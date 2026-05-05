/* ============================================================
 * Dispatch outreach sends
 * ============================================================
 * Endpoint:  POST /.netlify/functions/dispatch-outreach  (manual)
 * Schedule:  '*/10 * * * *' — every 10 minutes
 *
 * Drains the outreach_sends queue for active outreach_campaigns.
 * For each queued send:
 *   1. Verify lead_can_receive(lead, campaign) — skip if suppressed
 *   2. Render subject/body templates with lead data + unique
 *      unsubscribe_token + unsubscribe_url
 *   3. Send via Resend (domain = investproleads.com)
 *   4. Update outreach_sends row with status, provider_message_id
 *   5. Bump lead.send_count + last_sent_at
 *
 * Caps:
 *   - Per-campaign daily_send_cap (cumulative since UTC midnight)
 *   - Per-campaign per_second_cap (sleeps between sends)
 *   - Per-run global cap (BATCH_SIZE) to keep within Lambda 26s timeout
 *
 * On success: send is moved to 'sent' (Resend will follow up via
 * webhook to mark 'delivered'/'bounced'/'complained').
 *
 * On Resend failure: send is moved to 'failed' and provider_response
 * holds the raw error for debugging.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY_INVESTPRO_LEADS    (Resend API key for the cold domain — separate from main RESEND_API_KEY)
 *   OUTREACH_FROM_DOMAIN              (default 'investproleads.com')
 *   OUTREACH_REPLY_TO_DOMAIN          (default 'investprorealty.net')
 *   URL                               (auto-set by Netlify, for unsubscribe link)
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const BATCH_SIZE       = 50;             // max sends drained per run
const SLEEP_MIN_MS     = 100;            // floor sleep between sends (avoid Resend rate limits)
const SITE_URL         = process.env.URL || 'https://investprorealty.net';
const FROM_DOMAIN      = process.env.OUTREACH_FROM_DOMAIN     || 'investproleads.com';
const REPLY_TO_DOMAIN  = process.env.OUTREACH_REPLY_TO_DOMAIN || 'investprorealty.net';

exports.handler = async (event) => {
  if (event?.httpMethod === 'OPTIONS') return cors(204, '');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY_INVESTPRO_LEADS;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Supabase env vars missing' }));
  }
  if (!RESEND_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'RESEND_API_KEY_INVESTPRO_LEADS missing' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ---- 1. Pick up to BATCH_SIZE queued sends, oldest first ----
  // Join campaign + lead so we have everything we need in one query.
  const { data: queued, error: qErr } = await admin
    .from('outreach_sends')
    .select(`
      id, campaign_id, lead_id, to_email,
      outreach_campaigns!inner(
        id, name, status, audience_type,
        from_address, from_display_name, reply_to_address,
        subject_template, body_html_template, body_text_template,
        daily_send_cap, per_second_cap, resend_suppression_days,
        provider
      ),
      leads!inner(
        id, email, first_name, last_name, phone,
        property_address, property_city, property_state, property_zip,
        status, unsubscribed_at, bounced_at, complained_at, deleted_at
      )
    `)
    .eq('status', 'queued')
    .order('queued_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (qErr) {
    console.error('dispatch-outreach: queue lookup failed', qErr);
    return cors(500, JSON.stringify({ ok: false, error: qErr.message }));
  }
  if (!queued || queued.length === 0) {
    return cors(200, JSON.stringify({ ok: true, processed: 0, message: 'queue empty' }));
  }

  // ---- 2. Group by campaign so we can apply daily caps ----
  const byCampaign = {};
  for (const s of queued) {
    const cid = s.campaign_id;
    if (!byCampaign[cid]) byCampaign[cid] = { campaign: s.outreach_campaigns, sends: [] };
    byCampaign[cid].sends.push(s);
  }

  // ---- 3. For each campaign, compute remaining daily allowance ----
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartISO = todayStart.toISOString();

  let totalSent     = 0;
  let totalSkipped  = 0;
  let totalFailed   = 0;
  let touchedCamps  = new Set();

  for (const cid of Object.keys(byCampaign)) {
    const { campaign, sends } = byCampaign[cid];

    // Skip campaigns that aren't actively sending
    if (!['scheduled', 'sending'].includes(campaign.status)) {
      continue;
    }

    // How many already sent today for this campaign?
    const { count: sentToday } = await admin
      .from('outreach_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', cid)
      .gte('sent_at', todayStartISO)
      .in('status', ['sent', 'delivered']);

    const allowance = Math.max(0, (campaign.daily_send_cap || 250) - (sentToday || 0));
    const sleepMs = Math.max(SLEEP_MIN_MS, Math.ceil(1000 / Math.max(1, campaign.per_second_cap || 1)));

    // Mark campaign as 'sending' if it's still 'scheduled'
    if (campaign.status === 'scheduled') {
      await admin.from('outreach_campaigns')
        .update({ status: 'sending', started_at: new Date().toISOString() })
        .eq('id', cid);
      touchedCamps.add(cid);
    }

    // ---- 4. Process each queued send for this campaign ----
    let sentThisCampaign = 0;
    for (const s of sends) {
      if (sentThisCampaign >= allowance) {
        // Hit daily cap; remaining stay queued for tomorrow
        break;
      }

      // Eligibility check
      const elig = await admin.rpc('lead_can_receive', {
        p_lead_id:     s.lead_id,
        p_campaign_id: cid
      });
      const eligibleRow = (elig.data && elig.data[0]) || {};
      if (!eligibleRow.eligible) {
        await admin.from('outreach_sends')
          .update({
            status: 'skipped',
            error_message: 'Skipped: ' + (eligibleRow.reason || 'unknown'),
            sending_started_at: new Date().toISOString(),
            failed_at: new Date().toISOString()
          })
          .eq('id', s.id);
        totalSkipped++;
        touchedCamps.add(cid);
        continue;
      }

      // Render templates + unsubscribe token
      const lead = s.leads;
      const unsubToken = crypto.randomBytes(16).toString('hex');
      const unsubUrl = `${SITE_URL}/unsubscribe.html?t=${unsubToken}`;
      const ctx = {
        first_name:       lead.first_name || 'there',
        last_name:        lead.last_name  || '',
        property_address: lead.property_address || '',
        property_city:    lead.property_city || '',
        property_state:   lead.property_state || '',
        property_zip:     lead.property_zip || '',
        unsubscribe_url:  unsubUrl
      };

      const subject = renderTemplate(campaign.subject_template, ctx);
      let html = renderTemplate(campaign.body_html_template, ctx);
      // Auto-append the unsubscribe footer if the body doesn't already mention {unsubscribe_url}
      if (!campaign.body_html_template.includes('{unsubscribe_url}')) {
        html = html + buildUnsubscribeFooter(unsubUrl);
      }
      const text = campaign.body_text_template
        ? renderTemplate(campaign.body_text_template, ctx)
        : htmlToText(html);

      // Mark as sending
      await admin.from('outreach_sends')
        .update({
          status: 'sending',
          sending_started_at: new Date().toISOString(),
          rendered_subject: subject,
          rendered_body_html: html,
          rendered_body_text: text,
          unsubscribe_token: unsubToken
        })
        .eq('id', s.id);

      // ---- 5. Send via Resend ----
      let providerOk = false;
      let providerMessageId = null;
      let providerResponse = null;
      let errorMessage = null;

      try {
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: `${campaign.from_display_name} <${campaign.from_address}>`,
            to: [s.to_email],
            reply_to: campaign.reply_to_address,
            subject,
            html,
            text,
            headers: {
              'List-Unsubscribe': `<${unsubUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              'X-InvestPro-Campaign-Id': cid,
              'X-InvestPro-Send-Id': s.id
            }
          })
        });
        providerResponse = await resendRes.json().catch(() => null);
        if (resendRes.ok && providerResponse?.id) {
          providerOk = true;
          providerMessageId = providerResponse.id;
        } else {
          errorMessage = providerResponse?.message || ('Resend HTTP ' + resendRes.status);
        }
      } catch (err) {
        errorMessage = 'Network: ' + (err.message || err);
      }

      // ---- 6. Persist outcome ----
      if (providerOk) {
        await admin.from('outreach_sends')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            provider_message_id: providerMessageId,
            provider_response: providerResponse
          })
          .eq('id', s.id);
        // Bump lead counters
        await admin.from('leads')
          .update({
            send_count: (lead.send_count || 0) + 1,
            last_sent_at: new Date().toISOString()
          })
          .eq('id', lead.id);
        totalSent++;
        sentThisCampaign++;
      } else {
        await admin.from('outreach_sends')
          .update({
            status: 'failed',
            failed_at: new Date().toISOString(),
            provider_response: providerResponse,
            error_message: errorMessage
          })
          .eq('id', s.id);
        totalFailed++;
      }
      touchedCamps.add(cid);

      // Throttle
      if (sleepMs > 0) await sleep(sleepMs);
    }

    // If we hit daily cap and there are still queued sends for this campaign, leave status='sending'
    // until tomorrow's run. If we drained everything for this campaign, mark sent.
    const { count: stillQueued } = await admin
      .from('outreach_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', cid)
      .eq('status', 'queued');
    if (stillQueued === 0) {
      await admin.from('outreach_campaigns')
        .update({ status: 'sent', completed_at: new Date().toISOString() })
        .eq('id', cid);
    }
  }

  // ---- 7. Refresh cached counters on each touched campaign ----
  for (const cid of touchedCamps) {
    await admin.rpc('refresh_outreach_campaign_counts', { p_campaign_id: cid });
  }

  return cors(200, JSON.stringify({
    ok: true,
    processed:    queued.length,
    sent:         totalSent,
    skipped:      totalSkipped,
    failed:       totalFailed,
    campaigns_touched: Array.from(touchedCamps).length
  }));
};

// Run every 10 minutes — drains slowly enough to respect per-second caps,
// fast enough to start sending soon after a campaign is queued.
exports.config = { schedule: '*/10 * * * *' };

// ────────────────────────────────────────────────────────────
// Template rendering — safe substitution of {var_name} tokens.
// Falls back to '' for missing keys (never injects undefined).
// ────────────────────────────────────────────────────────────
function renderTemplate(tpl, ctx) {
  if (!tpl) return '';
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => {
    const v = ctx[k];
    return v == null ? '' : String(v);
  });
}

function buildUnsubscribeFooter(unsubUrl) {
  return `
    <hr style="border:none;border-top:1px solid #E5E7EB;margin:2rem 0;" />
    <p style="font-size:.78rem;color:#9aa3bd;line-height:1.5;">
      You're receiving this because we identified you as a potential property owner
      or real-estate-related contact in the Las Vegas area. If this isn't relevant,
      <a href="${unsubUrl}" style="color:#1F4FC1;">click here to unsubscribe</a> and
      we'll remove you from future outreach immediately.
    </p>
  `;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
