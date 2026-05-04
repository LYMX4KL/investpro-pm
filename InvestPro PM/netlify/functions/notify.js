/* ============================================================
 * Notification dispatcher
 * ============================================================
 * Endpoint: POST /.netlify/functions/notify
 *
 * Single entrypoint for all platform-driven email notifications.
 * Portals call this with { event, payload } when something happens
 * that should ping a tenant / owner / vendor / broker.
 *
 * Supported events:
 *   - vendor_assigned                 — vendor was just assigned to a WO
 *   - estimate_awaiting_approval      — broker requests owner approval on a vendor estimate
 *   - owner_approval_decision         — owner approved/declined an estimate
 *   - work_order_completed            — vendor marked WO complete (notifies broker + owner)
 *   - distribution_paid               — broker paid the owner
 *   - payment_recorded                — broker recorded a tenant payment (receipt-style)
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   FROM_EMAIL                  (defaults to onboarding@resend.dev)
 *   STAFF_NOTIFY_EMAIL          (defaults to info@investprorealty.net)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const FROM = process.env.FROM_EMAIL || 'InvestPro Realty <onboarding@resend.dev>';
const STAFF_TO = process.env.STAFF_NOTIFY_EMAIL || 'info@investprorealty.net';
const SITE_URL = process.env.URL || 'https://investprorealty.net';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST')    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  const eventType = String(body.event || '').trim();
  if (!eventType) return cors(400, JSON.stringify({ ok: false, error: 'event required' }));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('notify: missing Supabase env vars');
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }
  if (!RESEND_KEY) {
    console.error('notify: missing RESEND_API_KEY');
    return cors(500, JSON.stringify({ ok: false, error: 'Email provider not configured' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    let result;
    switch (eventType) {
      case 'vendor_assigned':            result = await onVendorAssigned(admin, body.payload || {}); break;
      case 'estimate_awaiting_approval': result = await onEstimateAwaitingApproval(admin, body.payload || {}); break;
      case 'owner_approval_decision':    result = await onOwnerApprovalDecision(admin, body.payload || {}); break;
      case 'work_order_completed':       result = await onWorkOrderCompleted(admin, body.payload || {}); break;
      case 'distribution_paid':          result = await onDistributionPaid(admin, body.payload || {}); break;
      case 'payment_recorded':           result = await onPaymentRecorded(admin, body.payload || {}); break;
      default:
        return cors(400, JSON.stringify({ ok: false, error: 'Unknown event: ' + eventType }));
    }
    return cors(200, JSON.stringify({ ok: true, event: eventType, result }));
  } catch (err) {
    console.error('notify: handler threw', eventType, err);
    return cors(500, JSON.stringify({ ok: false, error: err?.message || 'Unknown error' }));
  }
};

// =====================================================================
// Event handlers
// =====================================================================

async function onVendorAssigned(admin, payload) {
  const { work_order_id } = payload;
  if (!work_order_id) throw new Error('work_order_id required');

  const wo = await fetchWorkOrder(admin, work_order_id);
  if (!wo) throw new Error('Work order not found');
  if (!wo.assigned_vendor_id) throw new Error('No vendor assigned');

  const { data: vendor } = await admin.from('profiles')
    .select('email, full_name')
    .eq('id', wo.assigned_vendor_id)
    .maybeSingle();
  if (!vendor || !vendor.email) throw new Error('Vendor email not found');

  const propAddr = await fetchPropertyAddress(admin, wo.property_id);
  const priorityBadge = priorityBadgeColor(wo.priority);
  const subject = `[InvestPro] ${wo.priority === 'emergency' ? '🚨 EMERGENCY ' : ''}Job assigned: ${wo.title}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:580px;padding:1.5rem;color:#1F2937;">
      <h2 style="font-family:Georgia,serif;color:#1F4FC1;margin:0 0 .5rem;">New Job Assigned</h2>
      <span style="display:inline-block;padding:.25rem .75rem;background:${priorityBadge};color:#fff;border-radius:4px;font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${wo.priority}</span>
      <h3 style="margin-top:1rem;color:#1F4FC1;">${escapeHtml(wo.title)}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:.5rem;">
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;width:160px;">Property</td><td style="padding:.4rem .5rem;">${escapeHtml(propAddr || '(no address)')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Tenant</td><td style="padding:.4rem .5rem;">${escapeHtml(wo.submitted_by_name || '—')} · ${escapeHtml(wo.submitted_by_phone || '—')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Category</td><td style="padding:.4rem .5rem;text-transform:capitalize;">${escapeHtml((wo.category || '').replace(/_/g, ' '))}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Access</td><td style="padding:.4rem .5rem;">${escapeHtml((wo.access_permission || '—').replace(/_/g, ' '))}${wo.access_notes ? ' — ' + escapeHtml(wo.access_notes) : ''}</td></tr>
        ${wo.pet_in_home ? `<tr><td style="padding:.4rem .5rem;background:#FEF3C7;font-weight:600;">⚠ Pet on premises</td><td style="padding:.4rem .5rem;">${escapeHtml(wo.pet_notes || 'see notes')}</td></tr>` : ''}
      </table>
      ${wo.description ? `<div style="background:#F7F8FB;border-left:4px solid #1F4FC1;padding:.75rem 1rem;margin-top:1rem;font-size:14px;white-space:pre-wrap;">${escapeHtml(wo.description)}</div>` : ''}
      <p style="margin-top:1.5rem;">
        <a href="${SITE_URL}/portal/vendor/dashboard.html" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">View in vendor portal →</a>
      </p>
      <p style="margin-top:1rem;font-size:13px;color:#6B7280;">Reply to this email to message InvestPro directly. Office: 702-816-5555.</p>
    </div>
  `;
  return await sendEmail({ to: vendor.email, subject, html });
}

async function onEstimateAwaitingApproval(admin, payload) {
  const { work_order_id } = payload;
  if (!work_order_id) throw new Error('work_order_id required');

  const wo = await fetchWorkOrder(admin, work_order_id);
  if (!wo) throw new Error('Work order not found');

  const ownerEmail = await fetchOwnerEmail(admin, wo.property_id);
  if (!ownerEmail) throw new Error('Owner email not found');

  const propAddr = await fetchPropertyAddress(admin, wo.property_id);
  const subject = `[InvestPro] Approval needed: $${Number(wo.estimate_amount || 0).toFixed(2)} estimate for ${wo.title}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:580px;padding:1.5rem;color:#1F2937;">
      <h2 style="font-family:Georgia,serif;color:#92400E;margin:0 0 .5rem;">⚠ Owner approval needed</h2>
      <p style="font-size:15px;line-height:1.55;">A vendor estimate for one of your properties requires your sign-off. The work won't proceed until you approve or decline.</p>
      <div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:6px;padding:1rem 1.25rem;margin:1rem 0;">
        <h3 style="margin:0 0 .5rem;color:#92400E;">${escapeHtml(wo.title)}</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:.3rem .5rem;font-weight:600;width:140px;">Property</td><td style="padding:.3rem .5rem;">${escapeHtml(propAddr || '')}</td></tr>
          <tr><td style="padding:.3rem .5rem;font-weight:600;">Vendor</td><td style="padding:.3rem .5rem;">${escapeHtml(wo.assigned_vendor_name || 'TBD')}</td></tr>
          <tr><td style="padding:.3rem .5rem;font-weight:600;">Estimate</td><td style="padding:.3rem .5rem;font-weight:700;">$${Number(wo.estimate_amount || 0).toFixed(2)}</td></tr>
          <tr><td style="padding:.3rem .5rem;font-weight:600;">Issue</td><td style="padding:.3rem .5rem;">${escapeHtml(wo.description || '')}</td></tr>
        </table>
      </div>
      <p style="margin-top:1.25rem;">
        <a href="${SITE_URL}/portal/owner-dashboard.html#workorders" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">Approve or decline →</a>
      </p>
      <p style="margin-top:1.25rem;font-size:13px;color:#6B7280;">Questions? Reply to this email or call 702-816-5555.</p>
    </div>
  `;
  return await sendEmail({ to: ownerEmail, subject, html });
}

async function onOwnerApprovalDecision(admin, payload) {
  const { work_order_id, decision, notes } = payload;
  if (!work_order_id) throw new Error('work_order_id required');

  const wo = await fetchWorkOrder(admin, work_order_id);
  if (!wo) throw new Error('Work order not found');

  const propAddr = await fetchPropertyAddress(admin, wo.property_id);
  const isApproved = decision === 'approved';
  const subject = `[InvestPro] Owner ${isApproved ? '✓ APPROVED' : '✗ DECLINED'} estimate: ${wo.title}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:580px;padding:1.5rem;color:#1F2937;">
      <h2 style="font-family:Georgia,serif;color:${isApproved ? '#065F46' : '#991B1B'};margin:0 0 .5rem;">Owner ${isApproved ? 'approved' : 'declined'} estimate</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:.75rem;">
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;width:140px;">Work order</td><td style="padding:.4rem .5rem;">${escapeHtml(wo.title)}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Property</td><td style="padding:.4rem .5rem;">${escapeHtml(propAddr || '')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Vendor</td><td style="padding:.4rem .5rem;">${escapeHtml(wo.assigned_vendor_name || '—')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Estimate</td><td style="padding:.4rem .5rem;">$${Number(wo.estimate_amount || 0).toFixed(2)}</td></tr>
      </table>
      ${notes ? `<div style="background:#F7F8FB;border-left:4px solid ${isApproved ? '#065F46' : '#991B1B'};padding:.75rem 1rem;margin-top:1rem;font-size:14px;white-space:pre-wrap;"><strong>Owner notes:</strong> ${escapeHtml(notes)}</div>` : ''}
      <p style="margin-top:1.25rem;">
        <a href="${SITE_URL}/portal/broker/work-orders.html" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">Open in broker portal →</a>
      </p>
    </div>
  `;
  return await sendEmail({ to: STAFF_TO, subject, html });
}

async function onWorkOrderCompleted(admin, payload) {
  const { work_order_id } = payload;
  if (!work_order_id) throw new Error('work_order_id required');

  const wo = await fetchWorkOrder(admin, work_order_id);
  if (!wo) throw new Error('Work order not found');

  const ownerEmail = await fetchOwnerEmail(admin, wo.property_id);
  const propAddr = await fetchPropertyAddress(admin, wo.property_id);
  const subject = `[InvestPro] Work completed: ${wo.title}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:580px;padding:1.5rem;color:#1F2937;">
      <h2 style="font-family:Georgia,serif;color:#065F46;margin:0 0 .5rem;">✓ Work order completed</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:.75rem;">
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;width:140px;">Issue</td><td style="padding:.4rem .5rem;">${escapeHtml(wo.title)}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Property</td><td style="padding:.4rem .5rem;">${escapeHtml(propAddr || '')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Vendor</td><td style="padding:.4rem .5rem;">${escapeHtml(wo.assigned_vendor_name || '—')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Final cost</td><td style="padding:.4rem .5rem;">$${Number(wo.invoice_amount || 0).toFixed(2)}${wo.tenant_caused ? ' (charged to tenant)' : ' (deducted from your distribution)'}</td></tr>
      </table>
      ${wo.completion_notes ? `<div style="background:#F7F8FB;border-left:4px solid #065F46;padding:.75rem 1rem;margin-top:1rem;font-size:14px;white-space:pre-wrap;"><strong>Vendor notes:</strong> ${escapeHtml(wo.completion_notes)}</div>` : ''}
      <p style="margin-top:1.25rem;">
        <a href="${SITE_URL}/portal/owner-dashboard.html#workorders" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">View in your portal →</a>
      </p>
    </div>
  `;
  const tos = [];
  if (ownerEmail) tos.push(ownerEmail);
  tos.push(STAFF_TO);
  return await sendEmail({ to: tos, subject, html });
}

async function onDistributionPaid(admin, payload) {
  const { property_id, amount, period, method, ext_id } = payload;
  if (!property_id || !amount) throw new Error('property_id and amount required');

  const ownerEmail = await fetchOwnerEmail(admin, property_id);
  if (!ownerEmail) throw new Error('Owner email not found');

  const propAddr = await fetchPropertyAddress(admin, property_id);
  const subject = `[InvestPro] Distribution sent: $${Number(amount).toFixed(2)} for ${period || 'this period'}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:580px;padding:1.5rem;color:#1F2937;">
      <h2 style="font-family:Georgia,serif;color:#1F4FC1;margin:0 0 .5rem;">💸 Your distribution is on the way</h2>
      <p style="font-size:15px;line-height:1.55;">We've sent your owner distribution. Details below.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:.75rem;">
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;width:140px;">Property</td><td style="padding:.4rem .5rem;">${escapeHtml(propAddr || '')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Period</td><td style="padding:.4rem .5rem;">${escapeHtml(period || '—')}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Amount</td><td style="padding:.4rem .5rem;font-weight:700;font-size:1.1rem;color:#1F4FC1;">$${Number(amount).toFixed(2)}</td></tr>
        <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Method</td><td style="padding:.4rem .5rem;text-transform:capitalize;">${escapeHtml(method || '—')}</td></tr>
        ${ext_id ? `<tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Reference</td><td style="padding:.4rem .5rem;">${escapeHtml(ext_id)}</td></tr>` : ''}
      </table>
      <p style="margin-top:1.25rem;">
        <a href="${SITE_URL}/portal/owner-dashboard.html#statements" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">View statement →</a>
      </p>
      <p style="margin-top:1.25rem;font-size:13px;color:#6B7280;">A complete CSV statement is downloadable from your owner portal. Year-end 1099-MISC will be filed by January 31.</p>
    </div>
  `;
  return await sendEmail({ to: ownerEmail, subject, html });
}

async function onPaymentRecorded(admin, payload) {
  const { payment_id } = payload;
  if (!payment_id) throw new Error('payment_id required');

  const { data: pay } = await admin.from('payments')
    .select('id, amount, type, status, paid_at, payment_method, description, lease_id, tenant_profile_id, property_id, ext_payment_id')
    .eq('id', payment_id)
    .maybeSingle();
  if (!pay) throw new Error('Payment not found');
  if (!pay.tenant_profile_id) return { skipped: 'no tenant on payment' };

  const { data: tenant } = await admin.from('profiles')
    .select('email, full_name')
    .eq('id', pay.tenant_profile_id)
    .maybeSingle();
  if (!tenant || !tenant.email) return { skipped: 'no tenant email' };

  const propAddr = await fetchPropertyAddress(admin, pay.property_id);
  const typeLabel = (pay.type || '').replace(/_/g, ' ');
  const subject = `[InvestPro] Receipt: $${Number(pay.amount).toFixed(2)} ${typeLabel}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;padding:1.5rem;color:#1F2937;">
      <h2 style="font-family:Georgia,serif;color:#065F46;margin:0 0 .5rem;">Payment received ✓</h2>
      <p style="font-size:15px;line-height:1.55;">Thanks ${escapeHtml((tenant.full_name || '').split(' ')[0] || 'there')}, we've recorded the following payment to your account:</p>
      <div style="background:#D1FAE5;border:1px solid #6EE7B7;border-radius:6px;padding:1rem 1.25rem;margin:1rem 0;text-align:center;">
        <div style="font-size:.78rem;color:#065F46;letter-spacing:.12em;text-transform:uppercase;font-weight:700;">${escapeHtml(typeLabel)}</div>
        <div style="font-size:2rem;font-weight:700;color:#065F46;margin-top:.25rem;">$${Number(pay.amount).toFixed(2)}</div>
        <div style="font-size:.85rem;color:#065F46;margin-top:.25rem;">${pay.paid_at ? new Date(pay.paid_at).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : ''} · ${escapeHtml(pay.payment_method || '')}</div>
      </div>
      ${propAddr ? `<p style="font-size:14px;color:#6B7280;">Property: ${escapeHtml(propAddr)}</p>` : ''}
      ${pay.description ? `<p style="font-size:14px;color:#6B7280;">Memo: ${escapeHtml(pay.description)}</p>` : ''}
      <p style="margin-top:1.25rem;">
        <a href="${SITE_URL}/portal/tenant-dashboard.html#payments" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">View payment history →</a>
      </p>
      <p style="margin-top:1rem;font-size:12px;color:#9aa3bd;">This is an automated receipt. Reply if any details look wrong.</p>
    </div>
  `;
  return await sendEmail({ to: tenant.email, subject, html });
}

// =====================================================================
// Helpers
// =====================================================================

async function fetchWorkOrder(admin, id) {
  const { data } = await admin.from('work_orders')
    .select('id, lease_id, property_id, submitted_by_name, submitted_by_phone, submitted_by_email, category, priority, title, description, access_permission, access_notes, pet_in_home, pet_notes, status, status_reason, assigned_vendor_id, assigned_vendor_name, scheduled_at, estimate_amount, owner_approval_required, owner_approved_at, owner_decision, completed_at, completion_notes, invoice_amount, tenant_caused')
    .eq('id', id)
    .maybeSingle();
  return data || null;
}

async function fetchPropertyAddress(admin, propertyId) {
  if (!propertyId) return null;
  const { data: p } = await admin.from('properties')
    .select('address_line1, address_line2, city, state, zip')
    .eq('id', propertyId)
    .maybeSingle();
  if (!p) return null;
  return `${p.address_line1}${p.address_line2 ? ' ' + p.address_line2 : ''} — ${p.city || 'Las Vegas'}, ${p.state || 'NV'} ${p.zip || ''}`.trim();
}

async function fetchOwnerEmail(admin, propertyId) {
  if (!propertyId) return null;
  const { data: p } = await admin.from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .maybeSingle();
  if (!p || !p.owner_id) return null;
  const { data: prof } = await admin.from('profiles')
    .select('email')
    .eq('id', p.owner_id)
    .maybeSingle();
  return prof?.email || null;
}

async function sendEmail({ to, subject, html }) {
  const tos = Array.isArray(to) ? to : [to];
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: tos, subject, html })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Resend error: ' + t);
  }
  return await res.json();
}

function priorityBadgeColor(p) {
  if (p === 'emergency') return '#991B1B';
  if (p === 'urgent')    return '#9A3412';
  if (p === 'high')      return '#92400E';
  return '#374151';
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
