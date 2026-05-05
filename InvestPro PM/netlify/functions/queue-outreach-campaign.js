/* ============================================================
 * Queue an outreach campaign
 * ============================================================
 * Endpoint: POST /.netlify/functions/queue-outreach-campaign
 *
 * Called when broker clicks "Save & queue all" on a campaign.
 * Creates one outreach_sends row per active lead in the campaign's
 * lead_list. Skips leads that are already suppressed (unsubscribed,
 * bounced, complained) — they'll be marked 'skipped' immediately
 * by the dispatch function anyway, but skipping at queue time saves
 * a row.
 *
 * After queuing, flips the campaign status to 'scheduled' so the
 * cron-driven dispatch-outreach picks it up on its next run.
 *
 * Auth: broker / compliance / admin_onsite.
 *
 * Request body: { campaign_id: UUID }
 *
 * Returns: { ok, campaign_id, queued, skipped_already_suppressed }
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  if (event.httpMethod !== 'POST')    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  // Auth
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
    .from('profiles').select('role').eq('id', callerData.user.id).single();
  if (!callerProfile || !['broker', 'compliance', 'admin_onsite'].includes(callerProfile.role)) {
    return cors(403, JSON.stringify({ ok: false, error: 'Only broker / compliance / admin_onsite can queue campaigns' }));
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors(400, JSON.stringify({ ok: false, error: 'Invalid JSON' })); }

  const campaign_id = body.campaign_id;
  if (!campaign_id) return cors(400, JSON.stringify({ ok: false, error: 'campaign_id required' }));

  // Fetch campaign + verify it's queueable
  const { data: campaign, error: cErr } = await admin
    .from('outreach_campaigns')
    .select('id, status, lead_list_id')
    .eq('id', campaign_id)
    .single();
  if (cErr || !campaign) {
    return cors(404, JSON.stringify({ ok: false, error: 'Campaign not found' }));
  }
  if (!['draft', 'paused', 'scheduled'].includes(campaign.status)) {
    return cors(400, JSON.stringify({
      ok: false,
      error: `Cannot queue a campaign with status "${campaign.status}"`
    }));
  }

  // Fetch active leads from the campaign's list
  const { data: members, error: mErr } = await admin
    .from('lead_list_members')
    .select('lead_id, leads!inner(id, email, status, unsubscribed_at, bounced_at, complained_at, deleted_at)')
    .eq('lead_list_id', campaign.lead_list_id);
  if (mErr) {
    return cors(500, JSON.stringify({ ok: false, error: 'List members lookup failed: ' + mErr.message }));
  }

  let queued = 0;
  let skipped = 0;
  const rowsToInsert = [];

  for (const m of members || []) {
    const lead = m.leads;
    if (!lead) continue;
    if (lead.deleted_at)            { skipped++; continue; }
    if (lead.status !== 'active')   { skipped++; continue; }
    if (lead.unsubscribed_at)       { skipped++; continue; }
    if (lead.bounced_at)            { skipped++; continue; }
    if (lead.complained_at)         { skipped++; continue; }
    rowsToInsert.push({
      campaign_id,
      lead_id: lead.id,
      to_email: lead.email,
      status: 'queued'
    });
  }

  // Insert in chunks; UNIQUE(campaign_id, lead_id) prevents double-queue
  if (rowsToInsert.length > 0) {
    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500);
      const { data, error } = await admin
        .from('outreach_sends')
        .upsert(chunk, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true })
        .select('id');
      if (error) {
        return cors(500, JSON.stringify({
          ok: false,
          error: 'Queue insert failed: ' + error.message,
          partial_progress: { queued }
        }));
      }
      queued += data?.length || 0;
    }
  }

  // Flip campaign to scheduled (only if it wasn't already)
  if (campaign.status !== 'scheduled') {
    await admin.from('outreach_campaigns')
      .update({ status: 'scheduled', scheduled_at: new Date().toISOString() })
      .eq('id', campaign_id);
  }

  // Refresh cached counters
  await admin.rpc('refresh_outreach_campaign_counts', { p_campaign_id: campaign_id });

  return cors(200, JSON.stringify({
    ok: true,
    campaign_id,
    queued,
    skipped_already_suppressed: skipped
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
