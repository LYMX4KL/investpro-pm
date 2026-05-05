/* ============================================================
 * Resend webhook handler — outreach domain
 * ============================================================
 * Endpoint: POST /.netlify/functions/outreach-webhook
 *
 * Configured in Resend dashboard for the investproleads.com
 * domain. Resend posts JSON for these event types:
 *   email.sent
 *   email.delivered
 *   email.bounced
 *   email.complained
 *   email.opened
 *   email.clicked
 *
 * We match the event back to an outreach_sends row by
 * provider_message_id and update status / counters / suppression.
 *
 * Hard bounces and complaints flip the lead's status so they're
 * never sent again.
 *
 * Security: Resend signs webhooks with HMAC SHA256 using the
 * webhook secret. We verify the 'svix-signature' header. If the
 * signature doesn't match, return 401.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_WEBHOOK_SECRET_INVESTPRO_LEADS  (from Resend dashboard)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST')    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SECRET       = process.env.RESEND_WEBHOOK_SECRET_INVESTPRO_LEADS;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  // ---- Verify signature (Svix-style — Resend uses Svix) ----
  // Header format: 'svix-signature: v1,<base64-sig> v1,<base64-sig>...'
  if (SECRET) {
    const sigHeader = event.headers['svix-signature'] || event.headers['Svix-Signature'] || '';
    const id        = event.headers['svix-id']        || event.headers['Svix-Id']        || '';
    const ts        = event.headers['svix-timestamp'] || event.headers['Svix-Timestamp'] || '';
    if (!sigHeader || !id || !ts) {
      return cors(401, JSON.stringify({ ok: false, error: 'Missing svix headers' }));
    }
    // Svix secret format: "whsec_<base64>"
    const cleanSecret = SECRET.startsWith('whsec_') ? SECRET.slice(6) : SECRET;
    const secretBuf = Buffer.from(cleanSecret, 'base64');
    const toSign = `${id}.${ts}.${event.body}`;
    const expected = crypto.createHmac('sha256', secretBuf).update(toSign).digest('base64');
    const provided = sigHeader.split(' ').map(s => s.split(',')[1]).filter(Boolean);
    const match = provided.some(p => safeEquals(p, expected));
    if (!match) {
      return cors(401, JSON.stringify({ ok: false, error: 'Invalid signature' }));
    }
  }
  // If SECRET isn't configured we allow (dev mode); production should always set it.

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  const type = payload.type || payload.event || '';
  const data = payload.data || {};
  const messageId = data.email_id || data.id || data.message_id;
  const recipient = (data.to && data.to[0]) || data.email || null;

  if (!type || !messageId) {
    return cors(400, JSON.stringify({ ok: false, error: 'Missing event type or message id' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Find the matching outreach_sends row
  const { data: sendRow } = await admin
    .from('outreach_sends')
    .select('id, lead_id, campaign_id, status, opened_count, clicked_count')
    .eq('provider_message_id', messageId)
    .maybeSingle();

  if (!sendRow) {
    // Not one of ours — could be a different domain on the same Resend account.
    return cors(200, JSON.stringify({ ok: true, ignored: 'no matching send row', message_id: messageId }));
  }

  const now = new Date().toISOString();
  const updates = { last_event_at: now };

  switch (type) {
    case 'email.sent':
      // Already handled by dispatch — no-op unless we missed it
      if (sendRow.status === 'queued' || sendRow.status === 'sending') {
        updates.status = 'sent';
        updates.sent_at = now;
      }
      break;

    case 'email.delivered':
      updates.status = 'delivered';
      updates.delivered_at = now;
      break;

    case 'email.bounced': {
      updates.status = 'bounced';
      updates.bounced_at = now;
      const bounceType = data.bounce?.type || data.bounce_type || 'unknown';
      const bounceSubtype = data.bounce?.subType || data.bounce_subtype || null;
      const diagnosticCode = data.bounce?.diagnosticCode || null;
      updates.bounce_type = bounceType;
      updates.bounce_subtype = bounceSubtype;
      updates.diagnostic_code = diagnosticCode;

      // Append to outreach_bounces audit table
      await admin.from('outreach_bounces').insert({
        email: recipient || '',
        lead_id: sendRow.lead_id,
        send_id: sendRow.id,
        bounce_type: bounceType,
        bounce_subtype: bounceSubtype,
        diagnostic_code: diagnosticCode,
        raw_payload: payload
      });

      // Hard bounce → suppress the lead permanently
      if (/hard|permanent/i.test(bounceType) || bounceType === 'Permanent') {
        await admin.from('leads')
          .update({
            status: 'bounced_hard',
            status_reason: 'hard_bounce: ' + (bounceSubtype || bounceType),
            bounced_at: now
          })
          .eq('id', sendRow.lead_id);
      }
      break;
    }

    case 'email.complained':
      updates.status = 'complained';
      updates.complained_at = now;

      await admin.from('outreach_bounces').insert({
        email: recipient || '',
        lead_id: sendRow.lead_id,
        send_id: sendRow.id,
        bounce_type: 'complaint',
        raw_payload: payload
      });

      // Auto-suppress and auto-unsubscribe
      await admin.from('leads')
        .update({
          status: 'complained',
          status_reason: 'spam_complaint',
          complained_at: now,
          unsubscribed_at: now
        })
        .eq('id', sendRow.lead_id);

      await admin.from('outreach_unsubscribes').insert({
        email: recipient || '',
        lead_id: sendRow.lead_id,
        campaign_id: sendRow.campaign_id,
        send_id: sendRow.id,
        source: 'webhook',
        reason: 'auto_unsub_after_complaint'
      });
      break;

    case 'email.opened':
      updates.opened_count = (sendRow.opened_count || 0) + 1;
      if (!sendRow.first_opened_at) updates.first_opened_at = now;
      break;

    case 'email.clicked':
      updates.clicked_count = (sendRow.clicked_count || 0) + 1;
      if (!sendRow.first_clicked_at) updates.first_clicked_at = now;
      break;

    default:
      // Unknown event type — record it on last_event_at and move on
      break;
  }

  await admin.from('outreach_sends').update(updates).eq('id', sendRow.id);

  // Refresh aggregate counters
  await admin.rpc('refresh_outreach_campaign_counts', { p_campaign_id: sendRow.campaign_id });

  return cors(200, JSON.stringify({ ok: true, event: type, send_id: sendRow.id }));
};

function safeEquals(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
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
