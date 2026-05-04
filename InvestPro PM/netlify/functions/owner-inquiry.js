/* ============================================================
 * Owner inquiry receiver
 * ============================================================
 * Endpoint: POST /.netlify/functions/owner-inquiry
 *
 * Called from forms/owner-inquiry.html. Public endpoint.
 *
 * What it does:
 *   1. Validates submission (required fields, honeypot)
 *   2. Emails Kenny via Resend (replyable to the sender)
 *   3. Sends an auto-acknowledgment to the inquirer
 *   4. Returns { ok, id } so the form can redirect to thank-you
 *
 * Required env vars:
 *   RESEND_API_KEY
 *   FROM_EMAIL
 *   OWNER_INQUIRY_RECIPIENT_EMAIL  (defaults to zhongkennylin@gmail.com)
 * ============================================================ */

const FROM = process.env.FROM_EMAIL || 'InvestPro Realty <onboarding@resend.dev>';
const TO_KENNY = process.env.OWNER_INQUIRY_RECIPIENT_EMAIL || 'zhongkennylin@gmail.com';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST')    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  // Honeypot
  if (body.website || body.fax) {
    console.log('owner-inquiry: honeypot hit, dropping silently');
    return cors(200, JSON.stringify({ ok: true, id: null }));
  }

  const first_name = String(body.first_name || '').trim();
  const last_name  = String(body.last_name  || '').trim();
  const email      = String(body.email || '').trim().toLowerCase();
  const phone      = String(body.phone || '').trim();
  const property_address = String(body.property_address || '').trim();

  if (!first_name) return cors(400, JSON.stringify({ ok: false, error: 'First name required' }));
  if (!last_name)  return cors(400, JSON.stringify({ ok: false, error: 'Last name required' }));
  if (!email || !email.includes('@')) {
    return cors(400, JSON.stringify({ ok: false, error: 'Valid email required' }));
  }
  if (!phone)            return cors(400, JSON.stringify({ ok: false, error: 'Phone required' }));
  if (!property_address) return cors(400, JSON.stringify({ ok: false, error: 'Property address required' }));

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    console.error('owner-inquiry: missing RESEND_API_KEY');
    return cors(500, JSON.stringify({ ok: false, error: 'Email provider not configured' }));
  }

  const inquiryId = randomId();
  const fullName = `${first_name} ${last_name}`;

  // ---- Notify Kenny ----
  const priorities = Array.isArray(body.priorities) ? body.priorities : [];
  const priorityLabel = {
    tenant_quality: 'Quality tenant placement',
    vacancy:        'Minimizing vacancy',
    maintenance:    'Hands-off maintenance',
    reporting:      'Clear monthly reporting',
    legal:          'Eviction / legal compliance',
    growth:         'Growing portfolio'
  };
  const priorityList = priorities.map(p => `<li>${escapeHtml(priorityLabel[p] || p)}</li>`).join('');

  const internalSubject = `[InvestPro] New owner inquiry: ${fullName} — ${property_address}`;
  const internalHtml = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:580px;padding:1.5rem;color:#1F2937;">
      <h2 style="font-family:Georgia,serif;color:#1F4FC1;margin:0 0 .5rem;">New PM Owner Inquiry</h2>
      <div style="color:#6B7280;font-size:14px;margin-bottom:1.25rem;">
        ${escapeHtml(fullName)} · ${escapeHtml(email)} · ${escapeHtml(phone)} · best ${escapeHtml(body.contact_time || 'anytime')}
      </div>
      <h3 style="margin:0 0 .5rem;color:#1F4FC1;">Property</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;width:160px;">Address</td><td style="padding:.4rem .5rem;">${escapeHtml(property_address)}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Portfolio size</td><td style="padding:.4rem .5rem;">${escapeHtml(body.property_count || '—')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Type</td><td style="padding:.4rem .5rem;">${escapeHtml((body.property_type || '').replace(/_/g, ' '))}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Currently</td><td style="padding:.4rem .5rem;">${escapeHtml((body.current_status || '').replace(/_/g, ' '))}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Current rent</td><td style="padding:.4rem .5rem;">${body.current_rent ? '$' + Number(body.current_rent).toLocaleString() : '—'}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Beds / Baths / SqFt</td><td style="padding:.4rem .5rem;">${body.bedrooms || '?'} / ${body.bathrooms || '?'} / ${body.sqft ? Number(body.sqft).toLocaleString() : '?'}</td></tr>
      </table>
      ${priorityList ? `<h3 style="margin:1rem 0 .5rem;color:#1F4FC1;">Priorities</h3><ul>${priorityList}</ul>` : ''}
      ${body.message ? `<div style="background:#F7F8FB;border-left:4px solid #1F4FC1;padding:.75rem 1rem;margin-top:1rem;font-size:14px;white-space:pre-wrap;"><strong>Message:</strong><br/>${escapeHtml(body.message)}</div>` : ''}
      <div style="margin-top:1.5rem;font-size:13px;color:#6B7280;">
        Submitted: ${new Date().toLocaleString()}<br/>
        Inquiry ID: ${inquiryId}<br/>
        Source: ${escapeHtml(body.source_url || '')}
      </div>
    </div>
  `;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [TO_KENNY], reply_to: email, subject: internalSubject, html: internalHtml })
    });
  } catch (err) {
    console.error('owner-inquiry: notify Kenny failed', err);
  }

  // ---- Auto-ack to inquirer ----
  try {
    const ackHtml = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;padding:1.5rem;color:#1F2937;">
        <h1 style="font-family:Georgia,serif;color:#1F4FC1;margin:0 0 .5rem;">Thanks, ${escapeHtml(first_name)}!</h1>
        <p style="font-size:15px;line-height:1.55;">We received your inquiry about ${escapeHtml(property_address)}. Here's what happens next:</p>
        <ol style="font-size:15px;line-height:1.7;">
          <li><strong>Within 1 business day</strong> — Kenny or one of our agents will email you a free rental analysis with recommended rent + projected monthly income.</li>
          <li>If the numbers look good to you, we'll schedule a 15-minute call to walk through our PM agreement and answer questions.</li>
          <li>Sign the PMA → we onboard the property within 5 business days. No setup fee.</li>
        </ol>
        <p style="font-size:14px;color:#6B7280;margin-top:1.5rem;">Want to skip the email? Call us directly at <a href="tel:7028165555">702-816-5555</a>.</p>
        <p style="font-size:13px;color:#9aa3bd;margin-top:1.5rem;">Inquiry reference: ${inquiryId}</p>
      </div>
    `;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [email], subject: 'Thanks for your InvestPro inquiry — what happens next', html: ackHtml })
    });
  } catch (err) {
    console.error('owner-inquiry: auto-ack failed', err);
  }

  return cors(200, JSON.stringify({ ok: true, id: inquiryId }));
};

function randomId() {
  // 8-char hex
  return 'OI-' + Array.from(crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(4)) : new Uint8Array(4))
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
