/* ============================================================
 * Import leads from CSV
 * ============================================================
 * Endpoint: POST /.netlify/functions/import-leads-csv
 *
 * Called from the broker outreach UI when uploading a CSV of
 * prospects (recruiting, owner, seller, buyer leads).
 *
 * Auth: caller must be broker / compliance / admin_onsite.
 *
 * Request body (JSON):
 *   {
 *     csv:                "raw csv string",      // required
 *     lead_list_id?:      UUID,                  // existing list to add to
 *     list_name?:         TEXT,                  // OR create a new list with this name
 *     list_audience_type?:'recruiting'|'owner'|'seller'|'buyer'|'other' (default 'other'),
 *     list_description?:  TEXT,
 *     source:             TEXT,                  // e.g., 'mls_scraper', 'redx', 'manual_csv'
 *     source_url?:        TEXT,
 *     dry_run?:           BOOL                   // parse only, don't insert
 *   }
 *
 * CSV format:
 *   - First row = header. Recognized columns (case-insensitive, with
 *     spaces/underscores normalized):
 *       email                   (REQUIRED on every row)
 *       first_name | first
 *       last_name  | last
 *       phone
 *       property_address | address
 *       property_city    | city
 *       property_state   | state
 *       property_zip     | zip | postal | postal_code
 *       notes
 *   - All other columns are ignored (silently dropped).
 *
 * Behavior:
 *   - Email is normalized: lowercased, trimmed.
 *   - Within the CSV: duplicate emails collapse into the LAST row that
 *     has data for each field (later rows merge in).
 *   - Cross-CSV: existing leads are UPDATED (non-null fields fill blanks
 *     in the existing row; status/unsubscribed flags are preserved).
 *   - lead_list_members is INSERT ON CONFLICT DO NOTHING — re-importing
 *     the same list is idempotent.
 *
 * Returns:
 *   {
 *     ok: true,
 *     lead_list_id,
 *     total_rows,         // CSV body rows
 *     valid_rows,         // had a parsable email
 *     new_leads,          // INSERTed rows
 *     updated_leads,      // existing rows touched
 *     added_to_list,      // new memberships (= new + previously-not-in-list existing)
 *     already_in_list,    // already members (no-op)
 *     skipped_invalid,    // rejected (no email / malformed)
 *     errors              // [{ row_number, reason }] up to 50 entries
 *   }
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const MAX_ROWS_PER_REQUEST = 5000;          // hard cap to avoid Lambda timeouts
const MAX_ERRORS_RETURNED  = 50;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST')    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));

  // ---- 1. Env ----
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  // ---- 2. Auth ----
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return cors(401, JSON.stringify({ ok: false, error: 'Missing bearer token' }));

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user) {
    return cors(401, JSON.stringify({ ok: false, error: 'Invalid session' }));
  }
  const callerId = callerData.user.id;
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role, full_name')
    .eq('id', callerId)
    .single();
  const ALLOWED = ['broker', 'compliance', 'admin_onsite'];
  if (!callerProfile || !ALLOWED.includes(callerProfile.role)) {
    return cors(403, JSON.stringify({ ok: false, error: 'Only broker / compliance / admin_onsite can import leads' }));
  }

  // ---- 3. Parse body ----
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  const csv                = String(body.csv || '');
  const lead_list_id_in    = body.lead_list_id || null;
  const list_name          = String(body.list_name || '').trim();
  const list_audience_type = String(body.list_audience_type || 'other').toLowerCase();
  const list_description   = String(body.list_description || '').trim() || null;
  const source             = String(body.source || 'manual_csv').trim();
  const source_url         = String(body.source_url || '').trim() || null;
  const dry_run            = !!body.dry_run;

  if (!csv || csv.length < 5) {
    return cors(400, JSON.stringify({ ok: false, error: 'csv body required' }));
  }
  if (!lead_list_id_in && !list_name) {
    return cors(400, JSON.stringify({ ok: false, error: 'Provide either lead_list_id or list_name' }));
  }
  if (!['recruiting', 'owner', 'seller', 'buyer', 'other'].includes(list_audience_type)) {
    return cors(400, JSON.stringify({ ok: false, error: 'Invalid list_audience_type' }));
  }

  // ---- 4. Parse CSV ----
  const parsed = parseCsv(csv);
  if (parsed.error) {
    return cors(400, JSON.stringify({ ok: false, error: parsed.error }));
  }
  const { headers, rows } = parsed;

  if (rows.length === 0) {
    return cors(400, JSON.stringify({ ok: false, error: 'CSV has no body rows' }));
  }
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return cors(413, JSON.stringify({
      ok: false,
      error: `CSV has ${rows.length} rows; max per request is ${MAX_ROWS_PER_REQUEST}. Split the file and try again.`
    }));
  }

  // Build a column-name → CSV-index map using fuzzy matches
  const colMap = mapColumns(headers);
  if (colMap.email == null) {
    return cors(400, JSON.stringify({
      ok: false,
      error: 'CSV header must include an "email" column',
      detected_headers: headers
    }));
  }

  // Normalize each row → object with our canonical fields
  const errors = [];
  const seenInBatch = new Map();              // email -> merged record
  let skippedInvalid = 0;

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    const rowNumber = i + 2;                  // 1-based; +1 for header
    const record = extractRecord(cells, colMap);

    if (!record.email || !isPlausibleEmail(record.email)) {
      skippedInvalid++;
      if (errors.length < MAX_ERRORS_RETURNED) {
        errors.push({ row_number: rowNumber, reason: 'missing_or_invalid_email' });
      }
      continue;
    }

    // Merge duplicate emails within this CSV — later rows win on non-null fields
    const existing = seenInBatch.get(record.email);
    if (existing) {
      seenInBatch.set(record.email, mergeRecords(existing, record));
    } else {
      seenInBatch.set(record.email, record);
    }
  }

  const validRecords = Array.from(seenInBatch.values());
  if (validRecords.length === 0) {
    return cors(400, JSON.stringify({
      ok: false,
      error: 'No valid rows found (all rows missing email)',
      total_rows: rows.length,
      skipped_invalid: skippedInvalid,
      errors
    }));
  }

  // ---- 5. Resolve lead_list (create if needed) ----
  let lead_list_id = lead_list_id_in;
  if (!lead_list_id) {
    if (dry_run) {
      lead_list_id = '00000000-0000-0000-0000-000000000000'; // placeholder
    } else {
      const { data: newList, error: listErr } = await admin
        .from('lead_lists')
        .insert({
          name: list_name,
          description: list_description,
          audience_type: list_audience_type,
          created_by_id: callerId
        })
        .select('id')
        .single();
      if (listErr) {
        return cors(500, JSON.stringify({ ok: false, error: 'Could not create lead_list: ' + listErr.message }));
      }
      lead_list_id = newList.id;
    }
  } else {
    // Verify it exists
    const { data: existing, error: e } = await admin
      .from('lead_lists')
      .select('id')
      .eq('id', lead_list_id)
      .maybeSingle();
    if (e || !existing) {
      return cors(404, JSON.stringify({ ok: false, error: 'lead_list_id not found' }));
    }
  }

  if (dry_run) {
    return cors(200, JSON.stringify({
      ok: true,
      dry_run: true,
      lead_list_id,
      total_rows:        rows.length,
      valid_rows:        validRecords.length,
      skipped_invalid:   skippedInvalid,
      detected_headers:  headers,
      sample_records:    validRecords.slice(0, 5),
      errors
    }));
  }

  // ---- 6. Bulk fetch existing leads to know which are new ----
  const emails = validRecords.map(r => r.email);
  // Postgres has a 65k parameter limit on prepared statements; chunk by 500.
  const existingMap = new Map();              // email -> {id, status, unsubscribed_at, ...}
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const { data, error } = await admin
      .from('leads')
      .select('id, email, status, unsubscribed_at, bounced_at, complained_at, first_name, last_name, phone, property_address, property_city, property_state, property_zip, notes')
      .in('email', chunk)
      .is('deleted_at', null);
    if (error) {
      return cors(500, JSON.stringify({ ok: false, error: 'Lookup failed: ' + error.message }));
    }
    for (const row of data || []) existingMap.set(row.email, row);
  }

  // ---- 7. Build inserts and updates ----
  const toInsert = [];
  const toUpdate = [];
  for (const rec of validRecords) {
    const existing = existingMap.get(rec.email);
    if (!existing) {
      toInsert.push({
        email:            rec.email,
        first_name:       rec.first_name || null,
        last_name:        rec.last_name || null,
        phone:            rec.phone || null,
        property_address: rec.property_address || null,
        property_city:    rec.property_city || null,
        property_state:   rec.property_state || null,
        property_zip:     rec.property_zip || null,
        notes:            rec.notes || null,
        source,
        source_url,
        imported_by_id:   callerId
      });
    } else {
      // Fill blanks only — never overwrite user data
      const patch = {};
      if (!existing.first_name       && rec.first_name)       patch.first_name       = rec.first_name;
      if (!existing.last_name        && rec.last_name)        patch.last_name        = rec.last_name;
      if (!existing.phone            && rec.phone)            patch.phone            = rec.phone;
      if (!existing.property_address && rec.property_address) patch.property_address = rec.property_address;
      if (!existing.property_city    && rec.property_city)    patch.property_city    = rec.property_city;
      if (!existing.property_state   && rec.property_state)   patch.property_state   = rec.property_state;
      if (!existing.property_zip     && rec.property_zip)     patch.property_zip     = rec.property_zip;
      if (!existing.notes            && rec.notes)            patch.notes            = rec.notes;
      if (Object.keys(patch).length > 0) {
        toUpdate.push({ id: existing.id, patch });
      }
    }
  }

  // ---- 8. Insert new leads ----
  let new_leads = 0;
  const newLeadIds = [];
  if (toInsert.length > 0) {
    // Chunk inserts to be safe
    for (let i = 0; i < toInsert.length; i += 500) {
      const chunk = toInsert.slice(i, i + 500);
      const { data, error } = await admin
        .from('leads')
        .insert(chunk)
        .select('id, email');
      if (error) {
        return cors(500, JSON.stringify({
          ok: false,
          error: 'Insert leads failed: ' + error.message,
          partial_progress: { new_leads, updated_leads: 0 }
        }));
      }
      new_leads += data.length;
      for (const r of data) {
        newLeadIds.push(r.id);
        existingMap.set(r.email, { id: r.id, status: 'active' });
      }
    }
  }

  // ---- 9. Update existing leads (fill blanks) ----
  let updated_leads = 0;
  for (const u of toUpdate) {
    const { error } = await admin.from('leads').update(u.patch).eq('id', u.id);
    if (!error) updated_leads++;
  }

  // ---- 10. Add memberships ----
  // Build the membership rows from existingMap (covers both new + existing)
  const memberRows = [];
  for (const rec of validRecords) {
    const lead = existingMap.get(rec.email);
    if (lead) {
      memberRows.push({
        lead_list_id,
        lead_id: lead.id,
        added_by_id: callerId
      });
    }
  }

  let added_to_list = 0;
  let already_in_list = 0;
  if (memberRows.length > 0) {
    // Find which are already members so we report accurate counts
    const allLeadIds = memberRows.map(m => m.lead_id);
    const { data: existingMembers } = await admin
      .from('lead_list_members')
      .select('lead_id')
      .eq('lead_list_id', lead_list_id)
      .in('lead_id', allLeadIds);
    const existingMemberSet = new Set((existingMembers || []).map(m => m.lead_id));

    const toAdd = memberRows.filter(m => !existingMemberSet.has(m.lead_id));
    already_in_list = memberRows.length - toAdd.length;

    if (toAdd.length > 0) {
      for (let i = 0; i < toAdd.length; i += 500) {
        const chunk = toAdd.slice(i, i + 500);
        const { error } = await admin
          .from('lead_list_members')
          .insert(chunk);
        if (!error) added_to_list += chunk.length;
      }
    }
  }

  // ---- 11. Return ----
  return cors(200, JSON.stringify({
    ok: true,
    lead_list_id,
    total_rows:      rows.length,
    valid_rows:      validRecords.length,
    new_leads,
    updated_leads,
    added_to_list,
    already_in_list,
    skipped_invalid: skippedInvalid,
    errors
  }));
};

// ────────────────────────────────────────────────────────────
// CSV parser — handles quoted fields, escaped quotes, CRLF
// ────────────────────────────────────────────────────────────
function parseCsv(csv) {
  // Strip BOM
  if (csv.charCodeAt(0) === 0xFEFF) csv = csv.slice(1);

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < csv.length) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(cell);
      // Skip empty trailing rows
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      cell = '';
      // Handle CRLF
      if (c === '\r' && csv[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    cell += c;
    i++;
  }
  // Flush last cell/row
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
  }

  if (rows.length < 1) return { error: 'Empty CSV' };

  const headers = rows[0].map(h => normalizeHeader(h));
  const body = rows.slice(1).filter(r => r.length > 0 && !(r.length === 1 && r[0] === ''));
  return { headers, rows: body };
}

function normalizeHeader(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

// Map CSV headers to our canonical field names
function mapColumns(headers) {
  const aliases = {
    email:            ['email', 'e_mail', 'email_address', 'emailaddress'],
    first_name:       ['first_name', 'firstname', 'first', 'fname', 'given_name'],
    last_name:        ['last_name', 'lastname', 'last', 'lname', 'surname', 'family_name'],
    phone:            ['phone', 'phone_number', 'mobile', 'cell', 'tel', 'telephone'],
    property_address: ['property_address', 'address', 'street', 'street_address', 'addr1'],
    property_city:    ['property_city', 'city'],
    property_state:   ['property_state', 'state', 'st'],
    property_zip:     ['property_zip', 'zip', 'postal', 'postal_code', 'zipcode', 'zip_code'],
    notes:            ['notes', 'note', 'comment', 'comments', 'description']
  };

  const map = {};
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const idx = headers.indexOf(alias);
      if (idx !== -1) { map[canonical] = idx; break; }
    }
  }
  return map;
}

function extractRecord(cells, colMap) {
  const get = (k) => {
    const idx = colMap[k];
    if (idx == null) return null;
    const v = (cells[idx] || '').trim();
    return v.length === 0 ? null : v;
  };
  const email = (get('email') || '').toLowerCase();
  return {
    email,
    first_name:       get('first_name'),
    last_name:        get('last_name'),
    phone:            get('phone'),
    property_address: get('property_address'),
    property_city:    get('property_city'),
    property_state:   get('property_state'),
    property_zip:     get('property_zip'),
    notes:            get('notes')
  };
}

function mergeRecords(a, b) {
  // b wins on non-null
  const merged = { ...a };
  for (const k of Object.keys(b)) {
    if (b[k] != null && b[k] !== '') merged[k] = b[k];
  }
  return merged;
}

function isPlausibleEmail(s) {
  if (!s || s.length > 254) return false;
  // Cheap but effective: one @, at least one . in the domain part, no whitespace
  if (/\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at < 1 || at === s.length - 1) return false;
  const domain = s.slice(at + 1);
  if (!domain.includes('.')) return false;
  return true;
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body
  };
}
