/* ============================================================
 * Verify an agent's company email as a sender identity in SES
 * ============================================================
 * Endpoint: /.netlify/functions/verify-agent-ses
 *
 * Step 4 of the email-provisioning flow (after provision-agent-email
 * has created the Cloudflare route + sent the welcome email):
 *
 *   1. Look up the agent_emails row
 *   2. Call SES CreateEmailIdentity for the company address
 *   3. SES sends a verification email to the company address
 *      (which forwards via Cloudflare to the agent's personal inbox)
 *   4. Save the SES identity ARN on the agent_emails row
 *   5. Return — the agent clicks the link in the verification email
 *      to activate. A separate poll/cron flips ses_identity_verified
 *      to true once SES reports the identity as VerifiedForSendingStatus.
 *
 * Required Netlify env vars (per company):
 *   SES_AWS_ACCESS_KEY_INVESTPRO
 *   SES_AWS_SECRET_KEY_INVESTPRO
 *   SES_REGION_INVESTPRO         (default: us-east-1)
 *
 * Auth: caller must be broker / compliance / admin_onsite.
 *
 * Request body: { agent_email_id: UUID }
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');
const { SESv2Client, CreateEmailIdentityCommand, GetEmailIdentityCommand } = require('@aws-sdk/client-sesv2');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST') {
    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured (Supabase env vars)' }));
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  const agent_email_id = body.agent_email_id;
  if (!agent_email_id) {
    return cors(400, JSON.stringify({ ok: false, error: 'agent_email_id required' }));
  }

  // ---- Auth check ----
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
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', callerData.user.id)
    .single();
  if (!callerProfile || !['broker', 'compliance', 'admin_onsite'].includes(callerProfile.role)) {
    return cors(403, JSON.stringify({ ok: false, error: 'Only broker / compliance / admin can verify SES identities' }));
  }

  // ---- Fetch the agent_emails row + company ----
  const { data: row, error: rowErr } = await admin
    .from('agent_emails')
    .select('id, full_email, status, ses_identity_verified, company_id, companies(slug, primary_domain, ses_region)')
    .eq('id', agent_email_id)
    .single();
  if (rowErr || !row) {
    return cors(404, JSON.stringify({ ok: false, error: 'agent_emails row not found' }));
  }

  const slug = row.companies?.slug || 'investpro';
  const slugUpper = slug.toUpperCase();
  const accessKey = process.env[`SES_AWS_ACCESS_KEY_${slugUpper}`];
  const secretKey = process.env[`SES_AWS_SECRET_KEY_${slugUpper}`];
  const region    = process.env[`SES_REGION_${slugUpper}`] || row.companies?.ses_region || 'us-east-1';

  if (!accessKey || !secretKey) {
    return cors(500, JSON.stringify({
      ok: false,
      error: `AWS credentials for "${slug}" not configured. Add SES_AWS_ACCESS_KEY_${slugUpper} and SES_AWS_SECRET_KEY_${slugUpper} to Netlify env vars.`
    }));
  }

  // ---- Call SES ----
  const ses = new SESv2Client({
    region,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey }
  });

  let identityCreated = false;
  let identityAlreadyExisted = false;
  let verificationStatus = 'unknown';
  let identityArn = null;

  try {
    // Try to create
    const createRes = await ses.send(new CreateEmailIdentityCommand({
      EmailIdentity: row.full_email
    }));
    identityCreated = true;
    identityArn = createRes.IdentityType + ':' + row.full_email; // SDK doesn't return ARN here; use synthetic
  } catch (err) {
    // If already exists, that's fine — fetch its current state
    if (err.name === 'AlreadyExistsException' || /already exists/i.test(err.message || '')) {
      identityAlreadyExisted = true;
    } else {
      console.error('SES CreateEmailIdentity failed:', err);
      // Update agent_emails with the error for visibility
      await admin.from('agent_emails')
        .update({ ses_last_error: err.message, ses_synced_at: new Date().toISOString() })
        .eq('id', agent_email_id);
      return cors(500, JSON.stringify({
        ok: false,
        error: 'SES verification failed: ' + err.message,
        aws_code: err.name
      }));
    }
  }

  // Fetch current verification status
  try {
    const getRes = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: row.full_email }));
    verificationStatus = getRes.VerifiedForSendingStatus ? 'verified' : 'pending';
    if (getRes.IdentityType) identityArn = getRes.IdentityType + ':' + row.full_email;
  } catch (err) {
    console.warn('SES GetEmailIdentity failed:', err);
  }

  // ---- Update DB ----
  await admin.from('agent_emails')
    .update({
      ses_identity_arn: identityArn,
      ses_identity_verified: verificationStatus === 'verified',
      ses_synced_at: new Date().toISOString(),
      ses_last_error: null
    })
    .eq('id', agent_email_id);

  return cors(200, JSON.stringify({
    ok: true,
    full_email: row.full_email,
    identity_created: identityCreated,
    identity_already_existed: identityAlreadyExisted,
    verification_status: verificationStatus,
    next_step: verificationStatus === 'verified'
      ? 'Identity verified. Agent can be issued SMTP credentials.'
      : 'Verification email sent to the company address (forwards via Cloudflare to agent\'s personal inbox). Agent must click the link.'
  }));
};

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
