/* ============================================================
 * Generate monthly rent charges
 * ============================================================
 * Endpoint:  POST /.netlify/functions/generate-rent-charges
 * Schedule:  '0 5 1 * *'  — 5:00 AM UTC on the 1st of each month
 *
 * For every active lease, creates one row in `payments` with:
 *   type   = 'rent'
 *   status = 'due'
 *   amount = lease.monthly_rent
 *   due_date = YYYY-MM-01 (target month)
 *
 * Idempotent — uses a per-month, per-lease guard to avoid creating
 * duplicate rent rows if the function is run multiple times for
 * the same month.
 *
 * Manual call body (optional, for retroactive runs):
 *   { "year": 2026, "month": 5 }
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const isCron = event?.body == null && event?.headers?.['user-agent']?.includes('netlify');
  if (event?.httpMethod === 'OPTIONS') return cors(204, '');
  if (event?.httpMethod && event.httpMethod !== 'POST') {
    return cors(405, JSON.stringify({ ok: false, error: 'POST only' }));
  }

  let body = {};
  try { body = JSON.parse(event?.body || '{}'); } catch {}

  // Default target = current calendar month
  const now = new Date();
  const year  = parseInt(body.year)  || now.getUTCFullYear();
  const month = parseInt(body.month) || (now.getUTCMonth() + 1);

  if (year < 2020 || year > 2100 || month < 1 || month > 12) {
    return cors(400, JSON.stringify({ ok: false, error: 'Invalid year/month' }));
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('generate-rent-charges: missing Supabase env vars');
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Target due_date is the 1st of the target month (UTC)
  const dueDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd   = new Date(Date.UTC(year, month, 1));

  // 1. Pull all active leases that are valid for this month
  const { data: leases, error: lerr } = await admin.from('leases')
    .select('id, property_id, tenant_profile_ids, monthly_rent, start_date, end_date, status')
    .eq('status', 'active');
  if (lerr) {
    console.error('generate-rent-charges: lease fetch failed', lerr);
    return cors(500, JSON.stringify({ ok: false, error: lerr.message }));
  }

  // Filter: lease must overlap the target month
  const valid = (leases || []).filter(l => {
    const start = new Date(l.start_date + 'T00:00:00Z');
    const end   = new Date(l.end_date   + 'T23:59:59Z');
    return start < monthEnd && end >= monthStart && Number(l.monthly_rent) > 0;
  });

  // 2. For each lease, check if a rent row already exists for this due_date
  const created = [];
  const skipped = [];

  for (const l of valid) {
    const { count } = await admin.from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('lease_id', l.id)
      .eq('type', 'rent')
      .eq('due_date', dueDate);

    if (count && count > 0) {
      skipped.push(l.id);
      continue;
    }

    // Pick first tenant on the lease (for tenant_profile_id)
    let tenantId = null;
    try {
      const ids = Array.isArray(l.tenant_profile_ids)
        ? l.tenant_profile_ids
        : (typeof l.tenant_profile_ids === 'string' ? JSON.parse(l.tenant_profile_ids) : []);
      tenantId = ids[0] || null;
    } catch {}

    const { error: insErr } = await admin.from('payments').insert({
      lease_id:          l.id,
      property_id:       l.property_id,
      tenant_profile_id: tenantId,
      amount:            Number(l.monthly_rent),
      type:              'rent',
      status:            'due',
      due_date:          dueDate,
      payment_method:    null,
      description:       `Monthly rent — ${monthName(month)} ${year}`,
      recorded_by_id:    null,
      recorded_by_name:  isCron ? 'auto: monthly schedule' : 'manual run'
    });
    if (insErr) {
      console.error('generate-rent-charges: insert failed for lease', l.id, insErr);
      continue;
    }
    created.push(l.id);
  }

  return cors(200, JSON.stringify({
    ok: true,
    target: { year, month, due_date: dueDate },
    summary: {
      active_leases: valid.length,
      created_count: created.length,
      skipped_existing: skipped.length
    }
  }));
};

// Run on the 1st of each month at 5:00 AM UTC
exports.config = { schedule: '0 5 1 * *' };

function monthName(m) {
  return ['January','February','March','April','May','June','July','August','September','October','November','December'][m-1] || String(m);
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body
  };
}
