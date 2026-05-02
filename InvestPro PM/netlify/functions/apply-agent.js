/* ============================================================
 * Agent application receiver
 * ============================================================
 * Endpoint: https://investpro-realty.netlify.app/.netlify/functions/apply-agent
 *
 * Called from the public "Apply to Join InvestPro" form on
 * recruiting.html. Public endpoint — no auth required (it's
 * the lead-gen funnel).
 *
 * What it does:
 *   1. Validates the submission (required fields, email format,
 *      simple honeypot to deflect bots)
 *   2. Inserts a row into agent_applications via Supabase
 *      service-role (bypasses RLS)
 *   3. Emails Kenny via Resend so he sees the lead immediately
 *   4. Returns JSON {ok:true, id:...} so the form JS can
 *      redirect to the thank-you page
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   APPLICATION_RECIPIENT_EMAIL  (defaults to zhongkennylin@gmail.com)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // CORS / preflight — public endpoint, called from the same origin in prod
  // but we keep this generous so future subdomains can submit too.
  if (event.httpMethod === 'OPTIONS') {
    return cors(204, '');
  }
  if (event.httpMethod !== 'POST') {
    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' }));
  }

  // Honeypot — if filled in, it's a bot. Pretend success so they don't retry.
  if (body.website || body.fax) {
    console.log('apply-agent: honeypot hit, dropping silently');
    return cors(200, JSON.stringify({ ok: true, id: null }));
  }

  const first_name        = String(body.first_name || '').trim();
  const last_name         = String(body.last_name  || '').trim();
  const email             = String(body.email      || '').trim().toLowerCase();
  const phone             = String(body.phone      || '').trim();
  const licensed          = String(body.licensed   || '').trim() || null;
  const current_brokerage = String(body.current_brokerage || '').trim() || null;
  const interest          = String(body.interest   || '').trim() || null;
  const message           = String(body.message    || '').trim() || null;
  const source_url        = String(body.source_url || '').trim() || null;
  const sponsor_share     = String(body.sponsor_share || '').trim() || null;

  if (!first_name) return cors(400, JSON.stringify({ ok: false, error: 'First name required' }));
  if (!last_name)  return cors(400, JSON.stringify({ ok: false, error: 'Last name required' }));
  if (!email || !email.includes('@')) {
    return cors(400, JSON.stringify({ ok: false, error: 'Valid email required' }));
  }
  if (!phone) return cors(400, JSON.stringify({ ok: false, error: 'Phone required' }));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('apply-agent: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ---- Sponsor lookup (optional) ----
  // If the form includes ?sponsor=AGT-XXXX, attribute the application
  // to that agent so generational override credit flows correctly.
  let sponsor_agent_id = null;
  if (sponsor_share) {
    const { data: sponsor } = await admin
      .from('agents')
      .select('id')
      .eq('agent_share_code', sponsor_share)
      .maybeSingle();
    if (sponsor && sponsor.id) sponsor_agent_id = sponsor.id;
  }

  // ---- Insert ----
  const { data: inserted, error: insErr } = await admin
    .from('agent_applications')
    .insert({
      first_name, last_name, email, phone,
      licensed, current_brokerage, interest, message,
      source_url, sponsor_agent_id,
      status: 'new'
    })
    .select('id')
    .single();

  if (insErr) {
    console.error('apply-agent: insert failed', insErr);
    return cors(500, JSON.stringify({ ok: false, error: 'Could not save application: ' + insErr.message }));
  }
  const newId = inserted.id;

  // ---- Notify Kenny ----
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (RESEND_API_KEY) {
    const TO_EMAIL = process.env.APPLICATION_RECIPIENT_EMAIL || 'zhongkennylin@gmail.com';
    const subject = `[InvestPro] New agent application: ${first_name} ${last_name}`;
    const html = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 580px; padding: 1.5rem; color: #1F2937;">
        <h2 style="font-family: Georgia, serif; color: #1F4FC1; margin: 0 0 .5rem;">New Agent Application</h2>
        <div style="color: #6B7280; font-size: 14px; margin-bottom: 1.25rem;">
          ${escapeHtml(first_name + ' ' + last_name)} — ${escapeHtml(email)} — ${escapeHtml(phone)}
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <tr><td style="padding:.4rem .5rem; background:#F7F8FB; font-weight:600; width:160px;">Licensed</td><td style="padding:.4rem .5rem;">${escapeHtml(licensed || '—')}</td></tr>
          <tr><td style="padding:.4rem .5rem; background:#F7F8FB; font-weight:600;">Current brokerage</td><td style="padding:.4rem .5rem;">${escapeHtml(current_brokerage || '—')}</td></tr>
          <tr><td style="padding:.4rem .5rem; background:#F7F8FB; font-weight:600;">Interest</td><td style="padding:.4rem .5rem;">${escapeHtml(interest || '—')}</td></tr>
          <tr><td style="padding:.4rem .5rem; background:#F7F8FB; font-weight:600;">Sponsor</td><td style="padding:.4rem .5rem;">${escapeHtml(sponsor_share || '—')}${sponsor_agent_id ? ' ✓ matched' : ''}</td></tr>
        </table>
        ${message ? `<div style="background:#F7F8FB; border-left:4px solid #1F4FC1; padding:.75rem 1rem; margin-top:1rem; font-size:14px; white-space:pre-wrap;">${escapeHtml(message)}</div>` : ''}
        <div style="margin-top:1.5rem; font-size:13px; color:#6B7280;">
          Submitted: ${new Date().toLocaleString()}<br/>
          Page: ${escapeHtml(source_url || '')}
        </div>
      </div>
    `;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'InvestPro Recruiting <onboarding@resend.dev>',
          to: [TO_EMAIL],
          reply_to: email,
          subject,
          html
        })
      });
      if (!res.ok) {
        console.error('apply-agent: resend failed', await res.text());
      }
    } catch (err) {
      console.error('apply-agent: resend threw', err);
    }
  }

  return cors(200, JSON.stringify({ ok: true, id: newId }));
};

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

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
