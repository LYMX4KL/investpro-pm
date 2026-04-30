/* ============================================================
 * PetScreening.com → InvestPro Realty webhook receiver
 * ============================================================
 * Endpoint: https://investpro-realty.netlify.app/.netlify/functions/petscreening-webhook
 *
 * Configure THIS URL in your PetScreening Property Manager dashboard
 * under "Webhooks" / "API Settings" / "Notification URL".
 *
 * What it does:
 *   1. Receives POST from PetScreening when an applicant completes a pet profile
 *   2. Validates the payload (HMAC signature if PetScreening provides one)
 *   3. Looks up the application by referenceNumber (which we passed when
 *      generating the applicant's PetScreening link)
 *   4. Updates application_pets rows with FIDO score + status + URL
 *   5. Logs the event to webhook_events for audit
 *
 * Required environment variables (set in Netlify Site settings → Environment):
 *   SUPABASE_URL                       e.g. https://prvpjutmukssogxqbsjq.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY          (from Supabase dashboard → API → service_role key)
 *   PETSCREENING_WEBHOOK_SECRET        (generated once; paste into PetScreening too)
 *
 * The function handles a few payload shapes flexibly because PetScreening's
 * exact schema may vary. It looks for these field paths in order:
 *   referenceNumber → reference_id → external_id → applicationId → applicationID
 *   fidoScore       → fido_score   → score
 *   pets[]          → animals[]    → applicantPets[]
 * Everything raw is stored in webhook_events.request_body, so we can iterate
 * once we see the actual production payload.
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

exports.handler = async (event) => {
  // We only accept POST. Everything else gets a 405.
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SECRET       = process.env.PETSCREENING_WEBHOOK_SECRET || '';

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: 'Server misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' })
    };
  }

  // Parse body
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'Invalid JSON body' })
    };
  }

  // Optional: HMAC signature verification.
  // PetScreening typically signs with their shared secret. The header name
  // varies by vendor — we check a few common ones. If SECRET is empty, we skip.
  if (SECRET) {
    const sigHeader =
      event.headers['x-petscreening-signature'] ||
      event.headers['x-webhook-signature'] ||
      event.headers['x-signature'] ||
      '';
    if (sigHeader) {
      const expected = crypto
        .createHmac('sha256', SECRET)
        .update(event.body || '')
        .digest('hex');
      // Accept either raw hex or "sha256=<hex>" format
      const provided = sigHeader.replace(/^sha256=/, '');
      if (!safeEqual(expected, provided)) {
        await logEvent({
          SUPABASE_URL, SERVICE_KEY,
          method: event.httpMethod, headers: event.headers, body,
          status: 'failed', error: 'Signature mismatch', referenceId: null
        });
        return {
          statusCode: 401,
          body: JSON.stringify({ ok: false, error: 'Invalid signature' })
        };
      }
    }
    // If no signature header was sent, we still accept (PetScreening may not sign).
    // Log the absence so Kenny can see it during initial testing.
  }

  // Pull our reference id (the application_id we passed when sending the link)
  const referenceId =
    body.referenceNumber ||
    body.reference_id ||
    body.external_id ||
    body.externalReferenceId ||
    body.applicationId ||
    body.applicationID ||
    null;

  // Build a Supabase client with the service role key (bypasses RLS — required
  // because the webhook isn't an authenticated user)
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Always log the event first so we have a record even if processing fails
  const logResult = await logEvent({
    SUPABASE_URL, SERVICE_KEY,
    method: event.httpMethod, headers: event.headers, body,
    status: 'received', referenceId
  });
  const eventId = logResult?.id;

  if (!referenceId) {
    await markEvent(supa, eventId, 'failed', 'Missing referenceNumber / external_id in payload', 0);
    return {
      statusCode: 200, // 200 so PetScreening doesn't retry endlessly; we'll handle manually
      body: JSON.stringify({ ok: false, error: 'No reference id', logged: true })
    };
  }

  // Pull pets array from common shape variations
  const incomingPets =
    Array.isArray(body.pets) ? body.pets :
    Array.isArray(body.animals) ? body.animals :
    Array.isArray(body.applicantPets) ? body.applicantPets :
    Array.isArray(body.profiles) ? body.profiles :
    [];

  // Top-level FIDO if it's a single-pet payload
  const topLevelFido = body.fidoScore || body.fido_score || body.score || null;

  // Find the application by referenceId. We support two shapes:
  //   * Internal UUID (applications.id)
  //   * Confirmation number (applications.confirmation_number — the user-facing IPR-XXXXXXX)
  // The confirmation number is what we round-trip via the applicant link, so try
  // that first; UUID fallback is for the admin-triggered case.
  let application = null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(referenceId)) {
    const { data } = await supa
      .from('applications')
      .select('id, confirmation_number')
      .eq('id', referenceId)
      .maybeSingle();
    application = data || null;
  }
  if (!application) {
    const { data } = await supa
      .from('applications')
      .select('id, confirmation_number')
      .eq('confirmation_number', referenceId)
      .maybeSingle();
    application = data || null;
  }

  if (!application) {
    await markEvent(supa, eventId, 'failed', 'No application matching referenceNumber: ' + referenceId, 0);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: 'No application found for that referenceNumber' })
    };
  }

  // Find existing pet rows for this application
  const { data: existingPets, error: fetchErr } = await supa
    .from('application_pets')
    .select('id, name, pet_type')
    .eq('application_id', application.id);

  if (fetchErr) {
    await markEvent(supa, eventId, 'failed', 'Could not fetch pets: ' + fetchErr.message, 0);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: 'DB error', detail: fetchErr.message })
    };
  }

  if (!existingPets || existingPets.length === 0) {
    await markEvent(supa, eventId, 'ignored', 'No matching pets on this application', 0);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: 'No pets found for that referenceNumber' })
    };
  }

  // Update strategy:
  //   * If incomingPets[] has length matching existing → update by index/name
  //   * If we got a single top-level fidoScore and only one pet → update that one
  //   * Otherwise update ALL existing pet rows for this app with the top-level data
  let rowsUpdated = 0;

  for (let i = 0; i < existingPets.length; i++) {
    const existing = existingPets[i];

    // Try to match by name first, fall back to position
    const matched =
      incomingPets.find(p =>
        (p.name || p.petName || '').toLowerCase().trim() ===
        (existing.name || '').toLowerCase().trim()
      ) ||
      incomingPets[i] ||
      null;

    const fido =
      matched ? (matched.fidoScore || matched.fido_score || matched.score) : topLevelFido;
    const profileId =
      matched ? (matched.profileId || matched.profile_id || matched.id) : (body.profileId || body.profile_id || null);
    const profileUrl =
      matched ? (matched.profileUrl || matched.profile_url || matched.url) : (body.profileUrl || body.profile_url || null);

    if (fido === null || fido === undefined) {
      // Nothing actionable for this pet — skip it but mark as in_progress
      const { error: updErr } = await supa
        .from('application_pets')
        .update({
          pet_screening_status: 'in_progress',
          pet_screening_profile_id: profileId,
          pet_screening_url: profileUrl
        })
        .eq('id', existing.id);
      if (!updErr) rowsUpdated++;
      continue;
    }

    const fidoInt = parseInt(fido);
    const { error: updErr } = await supa
      .from('application_pets')
      .update({
        pet_screening_status: 'complete',
        pet_screening_fido_score: isNaN(fidoInt) ? null : fidoInt,
        pet_screening_completed_at: new Date().toISOString(),
        pet_screening_profile_id: profileId,
        pet_screening_url: profileUrl
      })
      .eq('id', existing.id);

    if (updErr) {
      await markEvent(supa, eventId, 'failed', 'Update failed: ' + updErr.message, rowsUpdated);
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: 'Update failed', detail: updErr.message })
      };
    }
    rowsUpdated++;
  }

  await markEvent(supa, eventId, 'processed', null, rowsUpdated);

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, rowsUpdated, referenceId })
  };
};


/* ----------- helpers ----------- */

async function logEvent({ SUPABASE_URL, SERVICE_KEY, method, headers, body, status, referenceId, error }) {
  try {
    const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data, error: logErr } = await supa
      .from('webhook_events')
      .insert({
        source: 'petscreening',
        event_type: body?.eventType || body?.event || null,
        reference_id: referenceId,
        http_method: method,
        request_headers: redactHeaders(headers),
        request_body: body,
        status,
        error_message: error || null
      })
      .select('id')
      .single();
    if (logErr) console.error('webhook log insert failed', logErr);
    return data;
  } catch (e) {
    console.error('logEvent threw', e);
    return null;
  }
}

async function markEvent(supa, eventId, status, error, rowsUpdated) {
  if (!eventId) return;
  await supa
    .from('webhook_events')
    .update({
      status,
      error_message: error,
      rows_updated: rowsUpdated || 0,
      processed_at: new Date().toISOString()
    })
    .eq('id', eventId);
}

function redactHeaders(headers) {
  // Drop any auth-style header before persisting
  const out = {};
  for (const k of Object.keys(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk.includes('cookie') || lk.includes('signature') || lk.includes('secret')) {
      out[k] = '[redacted]';
    } else {
      out[k] = headers[k];
    }
  }
  return out;
}

function safeEqual(a, b) {
  // Constant-time string compare to resist timing attacks
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
