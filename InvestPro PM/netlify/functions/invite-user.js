/* ============================================================
 * Invite a new user to the InvestPro portal
 * ============================================================
 * Endpoint: https://investpro-realty.netlify.app/.netlify/functions/invite-user
 *
 * Called from manage-users.html "+ Invite User" modal. Sends a magic-link
 * invite via Supabase Auth (auth.admin.inviteUserByEmail), then updates the
 * auto-created profile row with role/full_name/phone.
 *
 * The new user receives an email like:
 *   "You've been invited to InvestPro. Click here to accept and set your password."
 * They click → land on portal/login.html?... → set password → in.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL                — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   — service-role key (Supabase → Settings → API → service_role)
 *                                 Used ONLY here, server-side; never exposed to browser.
 *
 * Auth: caller must include their session access token in
 *   Authorization: Bearer <token>
 * Their role is checked server-side: only broker / compliance / admin_onsite
 * can invite. Any other caller gets 403.
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_INVITER_ROLES = ['broker', 'compliance', 'admin_onsite'];

const ALLOWED_NEW_ROLES = [
  'broker', 'va', 'accounting', 'compliance', 'leasing', 'pm_service',
  'admin_onsite', 'agent_listing', 'agent_showing', 'tenant', 'owner',
  'applicant', 'vendor'
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method Not Allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('invite-user: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var');
    return json(500, { ok: false, error: 'Server not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify env vars.' });
  }

  // ---- 1. Parse body ----
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON' });
  }

  const email     = String(body.email || '').trim().toLowerCase();
  const fullName  = String(body.full_name || '').trim();
  const phone     = String(body.phone || '').trim();
  const role      = String(body.role || '').trim();

  if (!email || !email.includes('@')) {
    return json(400, { ok: false, error: 'Valid email required' });
  }
  if (!fullName) {
    return json(400, { ok: false, error: 'Full name required' });
  }
  if (!ALLOWED_NEW_ROLES.includes(role)) {
    return json(400, { ok: false, error: 'Invalid role: ' + role });
  }

  // ---- 2. Verify caller's JWT and role ----
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return json(401, { ok: false, error: 'Missing Authorization bearer token' });
  }

  // Use service-role client to look up the caller's identity from their JWT
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user) {
    return json(401, { ok: false, error: 'Invalid session token' });
  }
  const callerId = callerData.user.id;

  const { data: callerProfile, error: profErr } = await admin
    .from('profiles')
    .select('id, role, full_name')
    .eq('id', callerId)
    .single();

  if (profErr || !callerProfile) {
    return json(401, { ok: false, error: 'Caller profile not found' });
  }
  if (!ALLOWED_INVITER_ROLES.includes(callerProfile.role)) {
    return json(403, { ok: false, error: 'Only broker, compliance, or admin_onsite can invite users' });
  }

  // ---- 3. Check email isn't already in use ----
  const { data: existing, error: existErr } = await admin
    .from('profiles')
    .select('id, email, role, full_name')
    .ilike('email', email)
    .maybeSingle();

  if (existErr) {
    console.error('invite-user: existing-check failed', existErr);
    // Non-fatal — continue and let the auth call surface its own duplicate error.
  }
  if (existing) {
    return json(409, {
      ok: false,
      error: `That email is already registered as ${existing.full_name || existing.email} (${existing.role}). Use Manage Users to change their role instead.`
    });
  }

  // ---- 4. Send the magic-link invite ----
  // Supabase will:
  //   1. Create auth.users row
  //   2. Fire our handle_new_auth_user trigger (creates profiles row, role='tenant')
  //   3. Email the invite link (sender = Supabase default; configurable in dashboard)
  const inviteOpts = {
    data: { full_name: fullName, phone, invited_by: callerProfile.full_name || callerId, intended_role: role },
    redirectTo: 'https://investpro-realty.netlify.app/portal/login.html?invited=1'
  };

  const { data: inviteData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, inviteOpts);

  if (inviteErr) {
    console.error('invite-user: inviteUserByEmail failed', inviteErr);
    return json(500, { ok: false, error: 'Invite email failed: ' + inviteErr.message });
  }

  const newUserId = inviteData?.user?.id;
  if (!newUserId) {
    return json(500, { ok: false, error: 'Invite sent but no user ID returned' });
  }

  // ---- 5. Update the freshly-created profile row to the right role + name ----
  // The trigger already created a profiles row with role='tenant', so update it.
  // Brief retry: the trigger fires AFTER auth.users insert, so on rare timing
  // races the row may not be visible immediately.
  let updateErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await admin
      .from('profiles')
      .update({ role, full_name: fullName, phone, email })
      .eq('id', newUserId);
    if (!error) { updateErr = null; break; }
    updateErr = error;
    await new Promise(r => setTimeout(r, 200));
  }

  if (updateErr) {
    // Invite sent but profile update failed — surface to UI so admin can fix manually.
    console.error('invite-user: profile update failed', updateErr);
    return json(207, {
      ok: true,
      emailed: true,
      profile_updated: false,
      warning: 'Invite email sent, but role/name not applied to profile: ' + updateErr.message,
      user_id: newUserId
    });
  }

  return json(200, {
    ok: true,
    emailed: true,
    profile_updated: true,
    user_id: newUserId,
    email,
    role,
    full_name: fullName
  });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
