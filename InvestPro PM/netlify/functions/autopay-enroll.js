/* ============================================================
 * Auto-pay enrollment intent
 * ============================================================
 * Endpoint: POST /.netlify/functions/autopay-enroll
 *
 * Tenant requests to set up auto-pay for rent. We do NOT collect
 * bank account info on this form — that's collected via phone
 * call by the broker (or via the chosen ACH provider once we
 * finalize one). This just captures the intent + preferences.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   FROM_EMAIL
 *   AUTOPAY_RECIPIENT_EMAIL (defaults to info@investprorealty.net)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const FROM = process.env.FROM_EMAIL || 'InvestPro Realty <onboarding@resend.dev>';
const TO_BROKER = process.env.AUTOPAY_RECIPIENT_EMAIL || 'info@investprorealty.net';
const SITE_URL = process.env.URL || 'https://investprorealty.net';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST')    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  // Honeypot
  if (body.website || body.fax) return cors(200, JSON.stringify({ ok: true, id: null }));

  const tenant_profile_id = String(body.tenant_profile_id || '').trim();
  const lease_id          = String(body.lease_id          || '').trim();
  const preferred_method  = String(body.preferred_method  || 'ach').trim();   // 'ach' | 'echeck' | 'unsure'
  const preferred_day     = parseInt(body.preferred_day, 10) || 1;            // day of month for auto-pull
  const phone             = String(body.phone || '').trim();
  const best_time         = String(body.best_time || '').trim();
  const notes             = String(body.notes || '').trim();

  if (!tenant_profile_id) return cors(400, JSON.stringify({ ok: false, error: 'tenant_profile_id required' }));
  if (!lease_id)          return cors(400, JSON.stringify({ ok: false, error: 'lease_id required' }));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Look up tenant + lease + property for context
  const [{ data: tenant }, { data: lease }] = await Promise.all([
    admin.from('profiles').select('email, full_name').eq('id', tenant_profile_id).maybeSingle(),
    admin.from('leases').select('id, property_id, monthly_rent').eq('id', lease_id).maybeSingle()
  ]);

  let propAddr = '(no property)';
  if (lease?.property_id) {
    const { data: p } = await admin.from('properties')
      .select('address_line1, address_line2, city, state, zip')
      .eq('id', lease.property_id).maybeSingle();
    if (p) propAddr = `${p.address_line1}${p.address_line2 ? ' ' + p.address_line2 : ''}, ${p.city || 'Las Vegas'} ${p.zip || ''}`.trim();
  }

  const inquiryId = randomId();

  if (RESEND_KEY) {
    // Notify broker with all the context
    const internalSubject = `[InvestPro] Auto-pay enrollment request — ${tenant?.full_name || tenant_profile_id}`;
    const internalHtml = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:580px;padding:1.5rem;color:#1F2937;">
        <h2 style="font-family:Georgia,serif;color:#1F4FC1;margin:0 0 .5rem;">Auto-pay enrollment request</h2>
        <p style="font-size:14px;color:#6B7280;">A tenant has requested to set up auto-pay. <strong>Call them to capture bank info securely</strong> — no account details were collected via the form.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:.75rem;">
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;width:160px;">Tenant</td><td style="padding:.4rem .5rem;">${escapeHtml(tenant?.full_name || tenant_profile_id)} · ${escapeHtml(tenant?.email || '')}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Phone</td><td style="padding:.4rem .5rem;"><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a> (best: ${escapeHtml(best_time || 'anytime')})</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Property</td><td style="padding:.4rem .5rem;">${escapeHtml(propAddr)}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Monthly rent</td><td style="padding:.4rem .5rem;">$${Number(lease?.monthly_rent || 0).toLocaleString()}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Preferred method</td><td style="padding:.4rem .5rem;text-transform:uppercase;">${escapeHtml(preferred_method)}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Preferred day</td><td style="padding:.4rem .5rem;">${preferred_day}${preferred_day === 1 ? 'st' : preferred_day === 2 ? 'nd' : preferred_day === 3 ? 'rd' : 'th'} of each month</td></tr>
        </table>
        ${notes ? `<div style="background:#F7F8FB;border-left:4px solid #1F4FC1;padding:.75rem 1rem;margin-top:1rem;font-size:14px;white-space:pre-wrap;"><strong>Tenant notes:</strong><br/>${escapeHtml(notes)}</div>` : ''}
        <div style="margin-top:1rem;padding:1rem;background:#FFFCF0;border:1px dashed #FFD66B;border-radius:6px;font-size:13px;">
          <strong style="color:#92400E;">Next step:</strong> call the tenant to capture routing + account number, then enroll in your bank's biz banking ACH module (or your ACH provider once selected — see <code>docs/PAYMENT-PROVIDERS.md</code>).
        </div>
        <div style="margin-top:1.5rem;font-size:13px;color:#6B7280;">
          Submitted: ${new Date().toLocaleString()}<br/>
          Reference: ${inquiryId}
        </div>
      </div>
    `;
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [TO_BROKER], reply_to: tenant?.email || undefined, subject: internalSubject, html: internalHtml })
      });
    } catch (err) {
      console.error('autopay-enroll: notify broker failed', err);
    }

    // Auto-ack to tenant
    if (tenant?.email) {
      const ackSubject = '[InvestPro] Auto-pay request received — we\'ll call you';
      const ackHtml = `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;padding:1.5rem;color:#1F2937;">
          <h2 style="font-family:Georgia,serif;color:#1F4FC1;margin:0 0 .5rem;">Auto-pay setup — what happens next</h2>
          <p style="font-size:15px;line-height:1.55;">Hi ${escapeHtml((tenant.full_name || '').split(' ')[0] || 'there')},</p>
          <p style="font-size:15px;line-height:1.55;">We got your auto-pay request for <strong>${escapeHtml(propAddr)}</strong>. To keep your bank details secure, we'll call you (${escapeHtml(phone)} · best ${escapeHtml(best_time || 'anytime')}) to capture your routing and account number directly — never email or text bank info.</p>
          <p style="font-size:15px;line-height:1.55;">Once enrolled, we'll auto-pull rent on the <strong>${preferred_day}${preferred_day === 1 ? 'st' : preferred_day === 2 ? 'nd' : preferred_day === 3 ? 'rd' : 'th'} of each month</strong>. Standard ACH — usually $0.50–$1 fee, sometimes free if your bank covers it. We'll confirm fees on the call.</p>
          <p style="font-size:14px;color:#6B7280;margin-top:1.25rem;">If you don't hear from us within 1 business day, call 702-816-5555.</p>
          <p style="font-size:12px;color:#9aa3bd;margin-top:1.5rem;">Reference: ${inquiryId}</p>
        </div>
      `;
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM, to: [tenant.email], subject: ackSubject, html: ackHtml })
        });
      } catch (err) {
        console.error('autopay-enroll: ack failed', err);
      }
    }
  }

  return cors(200, JSON.stringify({ ok: true, id: inquiryId }));
};

function randomId() {
  return 'AP-' + Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
