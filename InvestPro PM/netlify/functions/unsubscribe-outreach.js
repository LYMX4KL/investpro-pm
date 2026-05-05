/* ============================================================
 * Public unsubscribe endpoint
 * ============================================================
 * Endpoints:
 *   GET  /.netlify/functions/unsubscribe-outreach?t=<token>   — page hits this for one-click unsub
 *   POST /.netlify/functions/unsubscribe-outreach             — body { token, reason? } from the form
 *
 * Public — NO auth. The token in the URL is the unsubscribe_token
 * stored on outreach_sends; possessing it is the proof of consent.
 *
 * What it does:
 *   1. Look up the send row by unsubscribe_token
 *   2. If found, flip lead.status='unsubscribed', set lead.unsubscribed_at
 *   3. Append to outreach_unsubscribes
 *   4. Idempotent — safe to call repeatedly
 *
 * Returns JSON for both GET and POST.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  let token = '';
  let reason = '';
  let source = 'public_link';

  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.rawQuery || event.queryStringParameters
      ? Object.entries(event.queryStringParameters || {}).map(([k, v]) => `${k}=${v}`).join('&')
      : '');
    token = (event.queryStringParameters?.t || '').trim();
    // Detect Gmail/Outlook one-click List-Unsubscribe POST (RFC 8058)
  } else if (event.httpMethod === 'POST') {
    // Could be JSON (from our /unsubscribe.html form) or url-encoded (from List-Unsubscribe-Post)
    const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      try {
        const body = JSON.parse(event.body || '{}');
        token  = String(body.token  || '').trim();
        reason = String(body.reason || '').trim();
      } catch {
        return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    } else {
      // URL-encoded: List-Unsubscribe one-click sends 'List-Unsubscribe=One-Click'
      // The token comes from the URL itself
      token  = (event.queryStringParameters?.t || '').trim();
      source = 'list_unsubscribe';
    }
  } else {
    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
  }

  if (!token || token.length < 16) {
    return cors(400, JSON.stringify({ ok: false, error: 'Missing or invalid token' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Look up the send row
  const { data: sendRow, error: sErr } = await admin
    .from('outreach_sends')
    .select('id, campaign_id, lead_id, to_email, leads(email, unsubscribed_at)')
    .eq('unsubscribe_token', token)
    .maybeSingle();

  if (sErr || !sendRow) {
    // Don't leak whether the token is valid — but still return success-ish so the user sees confirmation
    return cors(404, JSON.stringify({ ok: false, error: 'Token not found' }));
  }

  const now = new Date().toISOString();
  const email = sendRow.to_email || sendRow.leads?.email || '';

  // Already unsubscribed? Idempotent success
  if (sendRow.leads?.unsubscribed_at) {
    return cors(200, JSON.stringify({
      ok: true,
      already_unsubscribed: true,
      email
    }));
  }

  // Flip the lead's status
  await admin.from('leads').update({
    status: 'unsubscribed',
    status_reason: reason || 'public_unsub_link',
    unsubscribed_at: now
  }).eq('id', sendRow.lead_id);

  // Append to the audit log
  await admin.from('outreach_unsubscribes').insert({
    email,
    lead_id: sendRow.lead_id,
    campaign_id: sendRow.campaign_id,
    send_id: sendRow.id,
    source,
    reason: reason || null,
    ip_address: event.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
    user_agent: event.headers['user-agent'] || null
  });

  return cors(200, JSON.stringify({
    ok: true,
    email
  }));
};

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body
  };
}
