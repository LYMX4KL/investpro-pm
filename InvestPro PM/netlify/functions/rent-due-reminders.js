/* ============================================================
 * Rent due reminders
 * ============================================================
 * Endpoint:  POST /.netlify/functions/rent-due-reminders
 * Schedule:  '0 14 * * *'  — 2:00 PM UTC every day (~6 AM PT)
 *
 * Emails tenants whose rent is:
 *   - status = 'due'  AND
 *   - due_date is within the next 3 days  OR
 *   - already past due (overdue notice)
 *
 * Idempotency: writes a 'reminder_sent_at' marker on the payment
 * row's description (we don't have a dedicated column yet — keeps
 * the schema minimal). To re-send, broker can clear that line.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   FROM_EMAIL  (defaults to onboarding@resend.dev)
 *   URL         (auto-set by Netlify; used for portal links)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const FROM = process.env.FROM_EMAIL || 'InvestPro Realty <onboarding@resend.dev>';
const SITE_URL = process.env.URL || 'https://investprorealty.net';

exports.handler = async (event) => {
  if (event?.httpMethod === 'OPTIONS') return cors(204, '');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('rent-due-reminders: missing Supabase env vars');
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }
  if (!RESEND_KEY) {
    console.error('rent-due-reminders: missing RESEND_API_KEY');
    return cors(500, JSON.stringify({ ok: false, error: 'Email provider not configured' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const in3Days  = new Date(today); in3Days.setDate(in3Days.getDate() + 3);
  const in3DaysISO = in3Days.toISOString().slice(0, 10);

  // Pull all 'due' rent payments where due_date <= today + 3 days
  const { data: payments, error } = await admin.from('payments')
    .select('id, lease_id, property_id, tenant_profile_id, amount, due_date, description')
    .eq('type', 'rent')
    .eq('status', 'due')
    .lte('due_date', in3DaysISO)
    .order('due_date');
  if (error) {
    console.error('rent-due-reminders: pull failed', error);
    return cors(500, JSON.stringify({ ok: false, error: error.message }));
  }

  const sent = [];
  const skipped = [];

  for (const p of payments || []) {
    // Idempotency: skip if description already contains today's reminder marker
    const reminderTag = `[reminder:${todayISO}]`;
    if (p.description && p.description.includes(reminderTag)) {
      skipped.push({ id: p.id, reason: 'already-sent-today' });
      continue;
    }

    if (!p.tenant_profile_id) {
      skipped.push({ id: p.id, reason: 'no-tenant' });
      continue;
    }

    // Look up tenant + property
    const [{ data: tenant }, { data: prop }] = await Promise.all([
      admin.from('profiles').select('email, full_name').eq('id', p.tenant_profile_id).maybeSingle(),
      p.property_id
        ? admin.from('properties').select('address_line1, address_line2, city, state, zip').eq('id', p.property_id).maybeSingle()
        : Promise.resolve({ data: null })
    ]);
    if (!tenant?.email) {
      skipped.push({ id: p.id, reason: 'no-tenant-email' });
      continue;
    }

    const dueDate = new Date(p.due_date + 'T00:00:00');
    const daysUntil = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
    const overdue = daysUntil < 0;
    const propAddr = prop
      ? `${prop.address_line1}${prop.address_line2 ? ' ' + prop.address_line2 : ''}, ${prop.city || 'Las Vegas'}, ${prop.state || 'NV'} ${prop.zip || ''}`
      : '';

    const subject = overdue
      ? `[InvestPro] Rent overdue — ${escapeHtml(propAddr || 'your lease')}`
      : (daysUntil === 0
          ? `[InvestPro] Rent due today — $${Number(p.amount).toFixed(2)}`
          : `[InvestPro] Rent due in ${daysUntil} day${daysUntil === 1 ? '' : 's'} — $${Number(p.amount).toFixed(2)}`);

    const headerColor = overdue ? '#991B1B' : (daysUntil <= 1 ? '#92400E' : '#1F4FC1');
    const headerLine  = overdue
      ? `⚠ Rent is ${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? '' : 's'} past due`
      : (daysUntil === 0 ? '📅 Rent is due today' : `📅 Rent is due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`);

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;padding:1.5rem;color:#1F2937;">
        <h2 style="font-family:Georgia,serif;color:${headerColor};margin:0 0 .5rem;">${headerLine}</h2>
        <p style="font-size:15px;line-height:1.55;">Hi ${escapeHtml((tenant.full_name || '').split(' ')[0] || 'there')},</p>
        <p style="font-size:15px;line-height:1.55;">${overdue
          ? `Your rent payment for ${escapeHtml(propAddr)} was due on <strong>${dueDate.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}</strong>. A 5% late fee will be added on the 6th if not received.`
          : `This is a friendly reminder that your rent for ${escapeHtml(propAddr)} is due on <strong>${dueDate.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}</strong>.`
        }</p>
        <div style="background:#FFFCF0;border:1px dashed #FFD66B;border-radius:6px;padding:1rem 1.25rem;margin:1rem 0;text-align:center;">
          <div style="font-size:.78rem;color:#92400E;letter-spacing:.12em;text-transform:uppercase;font-weight:700;">Amount due</div>
          <div style="font-size:2rem;font-weight:700;color:${headerColor};margin-top:.25rem;">$${Number(p.amount).toFixed(2)}</div>
        </div>
        <p style="margin-top:1.25rem;">
          <a href="${SITE_URL}/portal/tenant-dashboard.html#pay" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">Pay rent →</a>
        </p>
        <p style="margin-top:1.5rem;font-size:13px;color:#6B7280;">Already paid? Disregard this message — there can be a delay between payment receipt and our records updating. Questions: 702-816-5555.</p>
      </div>
    `;

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [tenant.email], subject, html })
      });
      if (!res.ok) {
        console.error('rent-due-reminders: resend failed for', p.id, await res.text());
        skipped.push({ id: p.id, reason: 'send-failed' });
        continue;
      }
      // Mark with reminder tag to prevent duplicate sends today
      const newDesc = (p.description ? p.description + ' ' : '') + reminderTag;
      await admin.from('payments').update({ description: newDesc }).eq('id', p.id);
      sent.push({ id: p.id, to: tenant.email, daysUntil });
    } catch (err) {
      console.error('rent-due-reminders: threw for', p.id, err);
      skipped.push({ id: p.id, reason: err.message });
    }
  }

  return cors(200, JSON.stringify({
    ok: true,
    today: todayISO,
    sent_count: sent.length,
    skipped_count: skipped.length,
    sent,
    skipped
  }));
};

// Run daily at 2:00 PM UTC (~6 AM PT)
exports.config = { schedule: '0 14 * * *' };

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
