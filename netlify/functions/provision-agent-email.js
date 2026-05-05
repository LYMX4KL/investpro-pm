/* ============================================================
 * Provision a company email for a newly-joined agent
 * ============================================================
 * Endpoint: /.netlify/functions/provision-agent-email
 *
 * Called from portal/broker/applications.html when a manager flips
 * an application's status to "joined". Does the work documented in
 * docs/COMPANY-EMAIL-ARCHITECTURE.md, Section 3.
 *
 * Request body — three modes:
 *   1. From application:
 *        { application_id: UUID }
 *   2. Direct staff (re-provision / manual):
 *        { profile_id, company_slug, forward_to, local_part_override? }
 *   3. Shared role-based inbox (marketing@, info@, support@):
 *        { shared: true, company_slug, local_part, forward_to_list: [..1-5..],
 *          display_name? }
 *
 * Auth: caller must be broker / compliance / admin_onsite (verified via JWT).
 *
 * What it does:
 *   1. Validate caller's role
 *   2. Resolve {profile, company, forward_to}
 *   3. Generate non-colliding local_part (DB function does the work)
 *   4. INSERT agent_emails row (status=pending)
 *   5. Call Cloudflare API to add inbound route (if zone configured)
 *   6. Send onboarding email via Resend
 *   7. Update agent_emails row with route_id + provisioned_at
 *   8. Return { ok, email, route_id, sent } so the UI can display it
 *
 * SES outbound provisioning (sender identity + SMTP creds) is in a
 * separate function — verify-agent-ses.js — because it needs AWS
 * credentials and may not be configured tonight. The platform can
 * still hand out company emails; outbound goes through SES later.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   APPLICATION_RECIPIENT_EMAIL  (defaults to zhongkennylin@gmail.com)
 *   CF_API_TOKEN_INVESTPRO       (Cloudflare API token w/ Email Routing Rules permission)
 *   CF_ZONE_ID_INVESTPRO         (Cloudflare zone ID for investprorealty.net)
 *   (Repeat the CF_* pair per company slug — uppercase the slug)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST') {
    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
  }

  // ---- 1. Env ----
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured (Supabase env vars missing)' }));
  }

  // ---- 2. Parse body ----
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  const application_id      = body.application_id;
  const profile_id_in       = body.profile_id;
  const company_slug        = (body.company_slug || 'investpro').toLowerCase();
  const forward_to_in       = body.forward_to;
  const local_part_override = (body.local_part_override || '').toLowerCase().trim();
  const isShared            = !!body.shared;
  const shared_local_part   = (body.local_part || '').toLowerCase().trim();
  const shared_forward_list = Array.isArray(body.forward_to_list)
    ? body.forward_to_list.map(s => String(s).trim()).filter(Boolean)
    : [];
  const shared_display_name = (body.display_name || '').trim();

  if (!isShared && !application_id && !profile_id_in) {
    return cors(400, JSON.stringify({ ok: false, error: 'Need application_id, profile_id, or shared:true' }));
  }
  if (isShared) {
    if (!shared_local_part || !/^[a-z0-9._-]+$/.test(shared_local_part)) {
      return cors(400, JSON.stringify({ ok: false, error: 'shared local_part must be lowercase a-z0-9._-' }));
    }
    if (shared_forward_list.length === 0) {
      return cors(400, JSON.stringify({ ok: false, error: 'shared forward_to_list is required (1-5 addresses)' }));
    }
    if (shared_forward_list.length > 5) {
      return cors(400, JSON.stringify({ ok: false, error: 'Cloudflare allows at most 5 destinations per route' }));
    }
  }
  if (local_part_override && !/^[a-z0-9._-]+$/.test(local_part_override)) {
    return cors(400, JSON.stringify({ ok: false, error: 'local_part_override must be lowercase a-z0-9._-' }));
  }

  // ---- 3. Verify caller ----
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return cors(401, JSON.stringify({ ok: false, error: 'Missing bearer token' }));

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user) {
    return cors(401, JSON.stringify({ ok: false, error: 'Invalid session' }));
  }
  const callerId = callerData.user.id;
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role, full_name')
    .eq('id', callerId)
    .single();
  const ALLOWED = ['broker', 'compliance', 'admin_onsite'];
  if (!callerProfile || !ALLOWED.includes(callerProfile.role)) {
    return cors(403, JSON.stringify({ ok: false, error: 'Only broker, compliance, or admin_onsite can provision emails' }));
  }

  // ---- 4. Resolve target profile + forward address ----
  let profile_id, first_name, last_name, forward_to;
  let source_application_id = null;

  if (isShared) {
    // Skip per-profile resolution; we'll handle shared-inbox provisioning below.
    profile_id = null;
    first_name = shared_display_name || shared_local_part;
    last_name  = '';
    forward_to = shared_forward_list[0];
  } else if (application_id) {
    const { data: app, error } = await admin
      .from('agent_applications')
      .select('id, first_name, last_name, email, status')
      .eq('id', application_id)
      .single();
    if (error || !app) {
      return cors(404, JSON.stringify({ ok: false, error: 'Application not found' }));
    }
    if (app.status !== 'joined') {
      return cors(400, JSON.stringify({
        ok: false,
        error: `Application status is "${app.status}". Move it to "joined" before provisioning an email.`
      }));
    }
    source_application_id = app.id;
    first_name = app.first_name;
    last_name  = app.last_name;
    forward_to = app.email;

    // Look up the matching profile (created when invite-user was called)
    // by email match — this is the canonical link
    const { data: prof } = await admin
      .from('profiles')
      .select('id, full_name, email')
      .ilike('email', app.email)
      .maybeSingle();
    if (!prof) {
      return cors(400, JSON.stringify({
        ok: false,
        error: 'No portal profile found for that email yet. Invite the agent first via Manage Users → + Invite User, then come back.'
      }));
    }
    profile_id = prof.id;
  } else {
    // Direct profile_id mode (re-provisioning, manual flow)
    const { data: prof, error } = await admin
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', profile_id_in)
      .single();
    if (error || !prof) {
      return cors(404, JSON.stringify({ ok: false, error: 'Profile not found' }));
    }
    profile_id = prof.id;
    const parts = (prof.full_name || '').split(' ');
    first_name = parts[0] || '';
    last_name  = parts.slice(1).join(' ') || '';
    forward_to = forward_to_in || prof.email;
  }

  // ---- 5. Resolve company ----
  const { data: company, error: companyErr } = await admin
    .from('companies')
    .select('id, slug, name, primary_domain, tagline, support_phone, support_email, cloudflare_zone_id, cloudflare_setup_complete')
    .eq('slug', company_slug)
    .eq('active', true)
    .single();
  if (companyErr || !company) {
    return cors(404, JSON.stringify({ ok: false, error: `Company "${company_slug}" not found or inactive` }));
  }

  // ---- 6. Pick local-part ----
  let local_part;
  if (isShared) {
    local_part = shared_local_part;
  } else if (local_part_override) {
    local_part = local_part_override;
  } else {
    const { data: lpData, error: lpErr } = await admin.rpc('agent_email_pick_local_part', {
      p_first_name: first_name,
      p_last_name:  last_name,
      p_domain:     company.primary_domain
    });
    if (lpErr) {
      return cors(500, JSON.stringify({ ok: false, error: 'Could not pick a local-part: ' + lpErr.message }));
    }
    local_part = lpData;
  }
  const full_email = `${local_part}@${company.primary_domain}`;

  // ---- 7. Check for existing record ----
  if (isShared || local_part_override) {
    // Either path could collide on full_email (UNIQUE)
    const { data: existingFull } = await admin
      .from('agent_emails')
      .select('id, full_email, status')
      .ilike('full_email', full_email)
      .maybeSingle();
    if (existingFull) {
      return cors(409, JSON.stringify({
        ok: false,
        error: `Email ${full_email} already exists (status: ${existingFull.status}).`,
        existing: existingFull
      }));
    }
  } else {
    const { data: existing } = await admin
      .from('agent_emails')
      .select('id, full_email, status')
      .eq('profile_id', profile_id)
      .eq('company_id', company.id)
      .maybeSingle();
    if (existing) {
      return cors(409, JSON.stringify({
        ok: false,
        error: `That agent already has a company email at this company: ${existing.full_email} (status: ${existing.status}). Use the regenerate flow instead.`,
        existing
      }));
    }
  }

  // ---- 8. INSERT agent_emails row (pending) ----
  const insertPayload = {
    profile_id,
    company_id: company.id,
    local_part,
    full_email,
    forward_to,
    source_application_id,
    status: 'pending'
  };
  if (isShared) {
    insertPayload.is_shared = true;
    insertPayload.shared_forward_to_list = shared_forward_list;
    insertPayload.shared_display_name = shared_display_name || null;
  }
  const { data: newRow, error: insErr } = await admin
    .from('agent_emails')
    .insert(insertPayload)
    .select('id')
    .single();
  if (insErr) {
    return cors(500, JSON.stringify({ ok: false, error: 'Insert failed: ' + insErr.message }));
  }
  const emailRowId = newRow.id;

  // ---- 9. Add Cloudflare route ----
  // Looks up CF_API_TOKEN_INVESTPRO and CF_ZONE_ID_INVESTPRO from env
  // (uppercased slug). If not configured, we skip the CF call but
  // still send the onboarding email so the agent has their address.
  const cfTokenEnv = `CF_API_TOKEN_${company.slug.toUpperCase()}`;
  const cfZoneEnv  = `CF_ZONE_ID_${company.slug.toUpperCase()}`;
  const cfToken = process.env[cfTokenEnv];
  const cfZone  = company.cloudflare_zone_id || process.env[cfZoneEnv];

  let cf_route_id = null;
  let cf_error    = null;

  if (cfToken && cfZone) {
    try {
      const cfDestinations = isShared ? shared_forward_list : [forward_to];
      const cfRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZone}/email/routing/rules`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: `Forward ${local_part}${isShared ? ' (shared)' : ''}`,
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: full_email }],
          actions:  [{ type: 'forward', value: cfDestinations }],
          priority: 10
        })
      });
      const cfJson = await cfRes.json();
      if (!cfRes.ok || !cfJson.success) {
        cf_error = (cfJson.errors?.[0]?.message) || `Cloudflare returned ${cfRes.status}`;
        console.error('CF API failure', cfJson);
      } else {
        cf_route_id = cfJson.result?.tag || cfJson.result?.id;
      }
    } catch (err) {
      cf_error = 'Cloudflare API call threw: ' + err.message;
      console.error(err);
    }
  } else {
    cf_error = 'Cloudflare not yet configured for this company (env vars missing). Email created in DB but inbound forwarding is not active.';
  }

  // ---- 10. Update row with provisioned state ----
  await admin
    .from('agent_emails')
    .update({
      cloudflare_route_id: cf_route_id,
      cloudflare_synced_at: cf_route_id ? new Date().toISOString() : null,
      cloudflare_last_error: cf_error,
      provisioned_at: cf_route_id ? new Date().toISOString() : null,
      status: cf_route_id ? 'active' : 'pending'
    })
    .eq('id', emailRowId);

  // ---- 11. Send onboarding email via Resend ----
  // For staff: notify the agent's PERSONAL address with their new company email + Gmail send-as instructions.
  // For shared: notify every recipient on the fan-out list that mail to <local>@<domain> now lands in their inbox.
  let onboarding_sent = false;
  let onboarding_error = null;
  if (RESEND_KEY) {
    const recipients = isShared ? shared_forward_list : [forward_to];
    const { html, text, subject } = isShared
      ? buildSharedOnboardingEmail({
          generated_email: full_email,
          forward_list: shared_forward_list,
          display_name: shared_display_name,
          company,
          cf_route_active: !!cf_route_id
        })
      : buildOnboardingEmail({
          first_name,
          full_name: `${first_name} ${last_name}`.trim(),
          generated_email: full_email,
          personal_email: forward_to,
          company,
          cf_route_active: !!cf_route_id
        });
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${company.name} <onboarding@resend.dev>`,
          to: recipients,
          reply_to: company.support_email || 'info@investprorealty.net',
          subject,
          html,
          text
        })
      });
      if (r.ok) {
        onboarding_sent = true;
        await admin.from('agent_emails')
          .update({ onboarding_email_sent_at: new Date().toISOString() })
          .eq('id', emailRowId);
      } else {
        onboarding_error = 'Resend returned ' + r.status + ': ' + await r.text();
      }
    } catch (err) {
      onboarding_error = err.message;
    }
  } else {
    onboarding_error = 'RESEND_API_KEY not configured';
  }

  // ---- 12. Return ----
  return cors(200, JSON.stringify({
    ok: true,
    id: emailRowId,
    full_email,
    forward_to,
    is_shared: isShared,
    shared_forward_to_list: isShared ? shared_forward_list : null,
    onboarding_sent,
    cloudflare: {
      configured: !!(cfToken && cfZone),
      route_id:   cf_route_id,
      error:      cf_error
    },
    onboarding_email: {
      sent:  onboarding_sent,
      error: onboarding_error
    }
  }));
};

// ----------------------------------------------------------------
// Onboarding email body
// ----------------------------------------------------------------
function buildOnboardingEmail({ first_name, full_name, generated_email, personal_email, company, cf_route_active }) {
  const subject = `Welcome to ${company.name} — your work email is ready`;
  const safeName = company.name;
  const phone = company.support_phone || '702-816-5555';

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; max-width:620px; margin:0 auto; padding:1.5rem; color:#1F2937;">
  <h2 style="font-family:Georgia,serif; color:${escapeAttr(company.brand_color || '#1F4FC1')}; margin:0 0 .5rem;">Welcome to ${escapeHtml(safeName)}, ${escapeHtml(first_name)}!</h2>
  <p style="color:#555A6B; font-size:1rem;">Your company email is ready:</p>

  <div style="background:#F7F8FB; border-left:4px solid ${escapeAttr(company.brand_color || '#1F4FC1')}; padding:1rem 1.25rem; border-radius:4px; margin:1rem 0;">
    <div style="font-family:Georgia,serif; font-size:1.4rem; font-weight:700; color:#1F4FC1;">${escapeHtml(generated_email)}</div>
    <div style="font-size:.85rem; color:#6B7280; margin-top:.25rem;">Forwards directly to ${escapeHtml(personal_email)}</div>
  </div>

  ${cf_route_active
    ? `<p>Anyone who emails <strong>${escapeHtml(generated_email)}</strong> right now lands in your normal inbox at ${escapeHtml(personal_email)} — nothing for you to set up there.</p>`
    : `<p style="background:#FEF3C7; padding:.75rem 1rem; border-radius:4px; color:#92400E; font-size:.92rem;"><strong>Heads up:</strong> inbound forwarding will activate within a few minutes. Test it by sending yourself an email.</p>`
  }

  <h3 style="color:#1F4FC1; margin-top:2rem;">Set up "Send mail as" in Gmail</h3>
  <p>So your replies look like they're from your company address (not your personal one), do this once in Gmail:</p>

  <ol style="line-height:1.7; padding-left:1.25rem;">
    <li><strong>Gmail → Settings (gear icon) → "See all settings"</strong></li>
    <li>Open the <strong>"Accounts and Import"</strong> tab</li>
    <li>Under <strong>"Send mail as"</strong> click <strong>"Add another email address"</strong></li>
    <li>
      Name: <strong>${escapeHtml(full_name)}</strong><br/>
      Email: <strong>${escapeHtml(generated_email)}</strong><br/>
      <em>Uncheck</em> "Treat as an alias" and click <strong>Next Step</strong>
    </li>
    <li>SMTP credentials will be sent to you in a follow-up email once your sender identity is verified. Watch this inbox.</li>
  </ol>

  <p style="background:#DBEAFE; padding:.85rem 1rem; border-radius:4px; color:#1E40AF; font-size:.92rem;">
    <strong>One-time verification:</strong> Amazon (our outbound mail provider) will send a "verify this address" email to <strong>${escapeHtml(generated_email)}</strong>. Since that forwards here, you'll see it land in this inbox. Click the link to confirm.
  </p>

  <hr style="border:none; border-top:1px solid #E5E7EB; margin:2rem 0;" />

  <p style="font-size:.95rem;">
    Questions? Reply to this email or call <a href="tel:${escapeAttr(phone)}" style="color:#1F4FC1;">${escapeHtml(phone)}</a>.
  </p>
  <p style="font-size:.85rem; color:#6B7280; margin-top:1.5rem;">
    — The ${escapeHtml(safeName)} team<br/>
    ${company.tagline ? escapeHtml(company.tagline) : ''}
  </p>
</div>`;

  const text =
    `Welcome to ${safeName}, ${first_name}!\n\n` +
    `Your company email is ready: ${generated_email}\n` +
    `Forwards directly to: ${personal_email}\n\n` +
    `${cf_route_active
      ? 'Inbound forwarding is active. Test it by sending yourself an email.'
      : 'Inbound forwarding activates within a few minutes.'}\n\n` +
    `Set up "Send mail as" in Gmail (one-time):\n` +
    `1. Gmail → Settings → "Accounts and Import" tab\n` +
    `2. "Send mail as" → "Add another email address"\n` +
    `3. Name: ${full_name}, Email: ${generated_email}\n` +
    `4. Uncheck "Treat as an alias" → Next Step\n` +
    `5. SMTP credentials will arrive in a follow-up email once your sender identity is verified.\n\n` +
    `Questions? Call ${phone}.\n\n` +
    `— ${safeName}\n`;

  return { html, text, subject };
}

// ----------------------------------------------------------------
// Shared-inbox onboarding email body
// ----------------------------------------------------------------
function buildSharedOnboardingEmail({ generated_email, forward_list, display_name, company, cf_route_active }) {
  const labelName = display_name || generated_email.split('@')[0];
  const subject = `${company.name}: ${generated_email} is live (shared inbox)`;
  const phone = company.support_phone || '702-816-5555';
  const recipientsHtml = forward_list.map(e => `<li>${escapeHtml(e)}</li>`).join('');

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; max-width:620px; margin:0 auto; padding:1.5rem; color:#1F2937;">
  <h2 style="font-family:Georgia,serif; color:${escapeAttr(company.brand_color || '#1F4FC1')}; margin:0 0 .5rem;">Shared inbox is live: ${escapeHtml(labelName)}</h2>
  <p style="color:#555A6B; font-size:1rem;">Anyone who emails the address below will reach <strong>everyone</strong> on the recipient list. This is your team's shared role-based inbox at ${escapeHtml(company.name)}.</p>

  <div style="background:#F7F8FB; border-left:4px solid ${escapeAttr(company.brand_color || '#1F4FC1')}; padding:1rem 1.25rem; border-radius:4px; margin:1rem 0;">
    <div style="font-family:Georgia,serif; font-size:1.4rem; font-weight:700; color:#1F4FC1;">${escapeHtml(generated_email)}</div>
    <div style="font-size:.85rem; color:#6B7280; margin-top:.25rem;">Forwards to ${forward_list.length} recipient${forward_list.length === 1 ? '' : 's'}:</div>
    <ul style="margin:.4rem 0 0 0; padding-left:1.25rem; color:#1F2937; font-size:.9rem;">${recipientsHtml}</ul>
  </div>

  ${cf_route_active
    ? `<p>The Cloudflare route is active right now. Send a test email to <strong>${escapeHtml(generated_email)}</strong> — every recipient above should receive a copy.</p>`
    : `<p style="background:#FEF3C7; padding:.75rem 1rem; border-radius:4px; color:#92400E; font-size:.92rem;"><strong>Heads up:</strong> inbound forwarding will activate within a few minutes. The route is in the database but Cloudflare may need a moment to propagate.</p>`
  }

  <h3 style="color:#1F4FC1; margin-top:2rem;">Replying from this shared address (optional)</h3>
  <p>If you want to <em>reply</em> as ${escapeHtml(generated_email)} (not as your personal address), each recipient should set up Gmail "Send mail as":</p>
  <ol style="line-height:1.7; padding-left:1.25rem;">
    <li>Gmail → Settings → "Accounts and Import" → "Send mail as" → "Add another email address"</li>
    <li>Email: <strong>${escapeHtml(generated_email)}</strong>, Name: <strong>${escapeHtml(labelName)}</strong></li>
    <li>Uncheck "Treat as an alias" → Next Step</li>
    <li>SMTP credentials are sent in a follow-up email once the SES sender identity is verified by a manager.</li>
  </ol>

  <hr style="border:none; border-top:1px solid #E5E7EB; margin:2rem 0;" />
  <p style="font-size:.95rem;">Questions? Reply here or call <a href="tel:${escapeAttr(phone)}" style="color:#1F4FC1;">${escapeHtml(phone)}</a>.</p>
  <p style="font-size:.85rem; color:#6B7280; margin-top:1.5rem;">— ${escapeHtml(company.name)}<br/>${company.tagline ? escapeHtml(company.tagline) : ''}</p>
</div>`;

  const text =
    `Shared inbox is live: ${labelName}\n\n` +
    `Address: ${generated_email}\n` +
    `Forwards to:\n` +
    forward_list.map(e => '  - ' + e).join('\n') + '\n\n' +
    `${cf_route_active
      ? 'Cloudflare route is active. Send a test email — every recipient should receive a copy.'
      : 'Inbound forwarding activates within a few minutes.'}\n\n` +
    `Optional: set up Gmail "Send mail as" to reply from this address.\n\n` +
    `Questions? Call ${phone}.\n\n— ${company.name}\n`;

  return { html, text, subject };
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body
  };
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;');
}
