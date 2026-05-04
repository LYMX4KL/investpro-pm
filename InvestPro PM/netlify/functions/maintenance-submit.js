/* ============================================================
 * Maintenance request submission
 * ============================================================
 * Endpoint: https://investprorealty.net/.netlify/functions/maintenance-submit
 *
 * Called from forms/maintenance-request.html. Public endpoint —
 * but we look up the submitter's lease via their email so the
 * work_order is properly associated.
 *
 * What it does:
 *   1. Validates submission (required fields, honeypot)
 *   2. Looks up tenant by email → their active lease(s)
 *   3. Inserts a work_orders row via service-role
 *   4. Notifies broker via Resend
 *   5. Returns { ok, id } so the form can redirect
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   MAINTENANCE_RECIPIENT_EMAIL  (defaults to info@investprorealty.net)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST')    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  // Honeypot — bots tend to fill every field
  if (body.website || body.fax) {
    console.log('maintenance-submit: honeypot hit, dropping silently');
    return cors(200, JSON.stringify({ ok: true, id: null }));
  }

  // Validate
  const full_name   = String(body.full_name || '').trim();
  const email       = String(body.email     || '').trim().toLowerCase();
  const phone       = String(body.phone     || '').trim();
  const property_address = String(body.property_address || '').trim();
  const category    = String(body.category    || 'other').trim().toLowerCase();
  const priority    = String(body.priority    || 'normal').trim().toLowerCase();
  const title       = String(body.title       || '').trim();
  const description = String(body.description || '').trim();
  const access_permission = String(body.access_permission || '').trim();
  const access_notes      = String(body.access_notes || '').trim();
  const pet_in_home  = !!body.pet_in_home;
  const pet_notes    = String(body.pet_notes || '').trim();

  if (!full_name)            return cors(400, JSON.stringify({ ok: false, error: 'Full name required' }));
  if (!email || !email.includes('@')) return cors(400, JSON.stringify({ ok: false, error: 'Valid email required' }));
  if (!phone)                return cors(400, JSON.stringify({ ok: false, error: 'Phone required' }));
  if (!title)                return cors(400, JSON.stringify({ ok: false, error: 'Issue title required' }));

  const ALLOWED_CATEGORIES = ['plumbing','hvac','electrical','appliance','structural','pest','landscaping','pool_spa','security','cleaning','other'];
  const ALLOWED_PRIORITIES = ['emergency','urgent','high','normal','low'];
  const cat = ALLOWED_CATEGORIES.includes(category) ? category : 'other';
  const pri = ALLOWED_PRIORITIES.includes(priority) ? priority : 'normal';

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('maintenance-submit: missing Supabase env vars');
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ---- Look up tenant profile + active lease by email ----
  let lease_id = null;
  let property_id = null;
  let submitted_by_id = null;
  try {
    const { data: profile } = await admin
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (profile && profile.id) {
      submitted_by_id = profile.id;
      const { data: leases } = await admin
        .from('leases')
        .select('id, property_id')
        .contains('tenant_profile_ids', JSON.stringify([profile.id]))
        .eq('status', 'active')
        .order('start_date', { ascending: false })
        .limit(1);
      if (leases && leases[0]) {
        lease_id = leases[0].id;
        property_id = leases[0].property_id;
      }
    }
  } catch (err) {
    console.warn('maintenance-submit: lease lookup soft-failed', err);
  }

  // ---- Insert work order ----
  const { data: inserted, error: insErr } = await admin
    .from('work_orders')
    .insert({
      lease_id,
      property_id,
      submitted_by_id,
      submitted_by_name:  full_name,
      submitted_by_phone: phone,
      submitted_by_email: email,
      category:           cat,
      priority:           pri,
      title,
      description:        description || null,
      access_permission:  access_permission || null,
      access_notes:       access_notes || null,
      pet_in_home,
      pet_notes:          pet_notes || null,
      status:             'submitted',
      visible_to_owner:   true
    })
    .select('id')
    .single();

  if (insErr) {
    console.error('maintenance-submit: insert failed', insErr);
    return cors(500, JSON.stringify({ ok: false, error: 'Could not save request: ' + insErr.message }));
  }

  // ---- Notify broker via Resend ----
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (RESEND_API_KEY) {
    const TO_EMAIL = process.env.MAINTENANCE_RECIPIENT_EMAIL || 'info@investprorealty.net';
    const FROM_EMAIL = process.env.FROM_EMAIL || 'InvestPro Realty <onboarding@resend.dev>';
    const priorityBadgeColor = pri === 'emergency' ? '#991B1B' : (pri === 'urgent' ? '#9A3412' : (pri === 'high' ? '#92400E' : '#374151'));
    const subject = `[InvestPro] ${pri === 'emergency' ? '🚨 EMERGENCY ' : ''}Maintenance: ${title}`;
    const html = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width:580px; padding:1.5rem; color:#1F2937;">
        <h2 style="font-family:Georgia,serif;color:#1F4FC1;margin:0 0 .5rem;">New Maintenance Request</h2>
        <div style="display:inline-block;padding:.25rem .75rem;background:${priorityBadgeColor};color:#fff;border-radius:4px;font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:1rem;">${pri}</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;width:160px;">Tenant</td><td style="padding:.4rem .5rem;">${escapeHtml(full_name)} (${escapeHtml(email)})</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Phone</td><td style="padding:.4rem .5rem;">${escapeHtml(phone)}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Property</td><td style="padding:.4rem .5rem;">${escapeHtml(property_address || '(matched via email)')}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Category</td><td style="padding:.4rem .5rem;text-transform:capitalize;">${escapeHtml(cat.replace(/_/g,' '))}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Title</td><td style="padding:.4rem .5rem;">${escapeHtml(title)}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Lease matched</td><td style="padding:.4rem .5rem;">${lease_id ? 'Yes' : 'No (entered as walk-in)'}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Pet in home</td><td style="padding:.4rem .5rem;">${pet_in_home ? 'Yes — ' + escapeHtml(pet_notes || '') : 'No'}</td></tr>
          <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Access</td><td style="padding:.4rem .5rem;">${escapeHtml((access_permission || '—').replace(/_/g,' '))}${access_notes ? ' — ' + escapeHtml(access_notes) : ''}</td></tr>
        </table>
        ${description ? `<div style="background:#F7F8FB;border-left:4px solid #1F4FC1;padding:.75rem 1rem;margin-top:1rem;font-size:14px;white-space:pre-wrap;">${escapeHtml(description)}</div>` : ''}
        <div style="margin-top:1.5rem;font-size:13px;color:#6B7280;">Submitted ${new Date().toLocaleString()} · Work order ID: ${inserted.id}</div>
      </div>
    `;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: [TO_EMAIL], reply_to: email, subject, html })
      });
      if (!res.ok) console.error('maintenance-submit: resend failed', await res.text());
    } catch (err) {
      console.error('maintenance-submit: resend threw', err);
    }
  }

  return cors(200, JSON.stringify({ ok: true, id: inserted.id, lease_matched: !!lease_id }));
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
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
