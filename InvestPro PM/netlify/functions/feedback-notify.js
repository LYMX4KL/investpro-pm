/* ============================================================
 * Feedback email notifier
 * ============================================================
 * Endpoint: https://investpro-realty.netlify.app/.netlify/functions/feedback-notify
 *
 * Called from the feedback modal in js/auth.js right after a row is
 * inserted into the `feedback` table. Sends a formatted email to Kenny
 * via Resend (https://resend.com — free tier covers ~100/day, plenty
 * for soft-launch testing).
 *
 * Required Netlify env vars:
 *   RESEND_API_KEY   — from https://resend.com → API Keys (starts with "re_")
 *
 * The "from" address uses Resend's free testing sandbox domain
 * (onboarding@resend.dev) which can only send to verified recipients —
 * Kenny verifies his own email once when he signs up. No DNS / domain
 * setup required.
 *
 * Once the InvestPro DNS / domain is wired up later, swap the from
 * address to feedback@investprorealty.net for proper branding.
 * ============================================================ */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    // Don't 500 — feedback insert already succeeded; we just can't email.
    // Log so we can see this in Netlify function logs.
    console.warn('feedback-notify: RESEND_API_KEY not set, skipping email');
    return { statusCode: 200, body: JSON.stringify({ ok: true, emailed: false, reason: 'no_api_key' }) };
  }

  // Where the email goes. Defaulted to Kenny but configurable via env var.
  const TO_EMAIL = process.env.FEEDBACK_RECIPIENT_EMAIL || 'zhongkennylin@gmail.com';

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) };
  }

  const {
    user_name = '(unknown)',
    user_email = '(no email)',
    user_role = '(no role)',
    page_url = '',
    page_title = '',
    category = 'general',
    message = ''
  } = body;

  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing message' }) };
  }

  const categoryLabels = {
    bug: '🐛 Bug',
    suggestion: '💡 Suggestion',
    question: '❓ Question',
    praise: '🌟 Praise',
    general: '📝 General'
  };
  const categoryLabel = categoryLabels[category] || '📝 General';

  // Truncate the message for the subject so it fits readably in the inbox preview
  const shortMsg = message.length > 60 ? message.slice(0, 60).trim() + '…' : message;
  const subject = `[InvestPro Feedback] ${categoryLabel}: ${shortMsg}`;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 580px; padding: 1.5rem; color: #1F2937;">
      <h2 style="font-family: Georgia, serif; color: #1F4FC1; margin: 0 0 .25rem;">${categoryLabel}</h2>
      <div style="color: #6B7280; font-size: 14px; margin-bottom: 1.25rem;">
        From <strong>${escapeHtml(user_name)}</strong> &lt;${escapeHtml(user_email)}&gt; · ${escapeHtml(user_role)}
      </div>
      <div style="background: #F7F8FB; border-left: 4px solid #1F4FC1; padding: 1rem 1.25rem; border-radius: 4px; line-height: 1.5; font-size: 15px; white-space: pre-wrap;">${escapeHtml(message)}</div>
      <div style="margin-top: 1.25rem; font-size: 13px; color: #6B7280;">
        <strong>Page:</strong> <a href="${escapeAttr(page_url)}" style="color: #1F4FC1;">${escapeHtml(page_title || page_url)}</a><br/>
        <strong>Submitted:</strong> ${new Date().toLocaleString()}
      </div>
      <hr style="border: 0; border-top: 1px solid #E5E7EB; margin: 1.5rem 0;" />
      <div style="font-size: 13px; color: #6B7280;">
        <a href="https://investpro-realty.netlify.app/portal/broker/feedback.html" style="color: #1F4FC1;">📥 View all feedback in the portal</a> · mark this resolved, add notes, see history
      </div>
    </div>
  `;

  const text =
    `${categoryLabel}\n` +
    `From: ${user_name} <${user_email}> · ${user_role}\n` +
    `Page: ${page_url}\n` +
    `Submitted: ${new Date().toISOString()}\n\n` +
    `${message}\n\n` +
    `View all feedback: https://investpro-realty.netlify.app/portal/broker/feedback.html\n`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'InvestPro Feedback <onboarding@resend.dev>',
        to: [TO_EMAIL],
        reply_to: user_email && user_email !== '(no email)' ? user_email : undefined,
        subject,
        html,
        text
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('feedback-notify: Resend error', res.status, errText);
      return { statusCode: 200, body: JSON.stringify({ ok: true, emailed: false, error: errText }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, emailed: true }) };
  } catch (err) {
    console.error('feedback-notify: send threw', err);
    return { statusCode: 200, body: JSON.stringify({ ok: true, emailed: false, error: err.message }) };
  }
};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;');
}
