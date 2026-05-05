-- ============================================================
-- 035 — Cold outreach platform (lead lists, campaigns, sends)
-- ============================================================
-- The data layer for InvestPro's cold-prospecting email system.
-- Sends go through investproleads.com (cold-only domain) with
-- Reply-To routed back to investprorealty.net so replies converge
-- with normal mail.
--
-- See docs/INVESTPRO-OUTREACH-SETUP.md for the full setup runbook
-- (Cloudflare DNS, SES domain identity, Resend wiring, IAM reuse).
--
-- Tables:
--   1. lead_lists           — named buckets ("LV Owners 2026-Q2")
--   2. leads                — individual prospects (globally unique email)
--   3. lead_list_members    — many-to-many: a lead can be in N lists
--   4. outreach_campaigns   — a sending job (lead_list × template)
--   5. outreach_sends       — one row per send attempt
--   6. outreach_unsubscribes — append-only log (CAN-SPAM record)
--   7. outreach_bounces     — append-only log (deliverability audit)
--
-- Plus a helper function `lead_can_receive(p_lead_id, p_campaign_id)`
-- that encapsulates the "is this lead eligible for this campaign"
-- rule (not unsubscribed, not hard-bounced, not complained, not
-- recently sent within suppression window).
--
-- Background: Kenny 2026-05-05 — investproleads.com registered;
-- thousands of recruiting/owner/seller leads ready to import.
-- Reputation aging period (7-14 days) before first send.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Enums
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE outreach_audience AS ENUM (
    'recruiting',   -- agent recruiting (sponsor opportunity)
    'owner',        -- property-owner acquisition (PM service pitch)
    'seller',       -- seller leads (listing opportunity)
    'buyer',        -- buyer leads (showing/representation)
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM (
    'active',                  -- eligible to receive sends
    'unsubscribed',            -- user clicked unsubscribe
    'bounced_hard',            -- hard bounce (invalid address, etc.)
    'complained',              -- recipient marked as spam
    'manually_suppressed'      -- broker took the lead off the list
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE outreach_campaign_status AS ENUM (
    'draft',
    'scheduled',
    'sending',
    'sent',
    'paused',
    'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE outreach_send_status AS ENUM (
    'queued',
    'sending',
    'sent',          -- handed off to provider
    'delivered',     -- provider confirmed delivery
    'bounced',
    'complained',
    'failed',        -- internal/provider error pre-send
    'skipped'        -- excluded by lead_can_receive
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE outreach_provider AS ENUM ('resend', 'ses');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE unsubscribe_source AS ENUM (
    'public_link',         -- click on the unsubscribe link in the email body
    'list_unsubscribe',    -- one-click via List-Unsubscribe header (Gmail/Outlook UI)
    'webhook',             -- provider-side unsubscribe (Resend dashboard)
    'manual_admin',        -- broker took them off the list manually
    'reply_unsubscribe'    -- lead replied with "unsubscribe" / "stop" (manually processed)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ----------------------------------------------------------------
-- 2. lead_lists — named buckets
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_lists (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  description         TEXT,
  audience_type       outreach_audience NOT NULL DEFAULT 'other',

  -- Cached counts (refreshed by trigger on lead_list_members)
  lead_count          INT NOT NULL DEFAULT 0,
  active_lead_count   INT NOT NULL DEFAULT 0,

  created_by_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ                                   -- soft delete
);

CREATE INDEX IF NOT EXISTS idx_lead_lists_audience
  ON lead_lists(audience_type) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_lead_lists_touch ON lead_lists;
CREATE TRIGGER trg_lead_lists_touch
  BEFORE UPDATE ON lead_lists
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 3. leads — individual prospects
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  email               TEXT NOT NULL,                                  -- lowercased on insert
  first_name          TEXT,
  last_name           TEXT,
  phone               TEXT,

  -- Owner-outreach extras (the property they own that we're pitching to manage)
  property_address    TEXT,
  property_city       TEXT,
  property_state      TEXT,
  property_zip        TEXT,

  -- Provenance
  source              TEXT,                                          -- 'mls_scraper', 'redx', 'manual_csv', 'referral'
  source_url          TEXT,                                          -- where the lead came from (link)
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Status
  status              lead_status NOT NULL DEFAULT 'active',
  status_reason       TEXT,
  unsubscribed_at     TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  complained_at       TIMESTAMPTZ,

  -- Send tracking (cached for fast suppression checks)
  send_count          INT NOT NULL DEFAULT 0,
  last_sent_at        TIMESTAMPTZ,

  -- Optional link if a lead later signs up as a real subscriber/agent
  converted_subscriber_id UUID REFERENCES subscribers(id) ON DELETE SET NULL,
  converted_at        TIMESTAMPTZ,

  -- Free-form notes (broker's manual annotations)
  notes               TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

-- Globally unique email (case-insensitive). Soft-delete-aware via partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_email_active
  ON leads(LOWER(email))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_status
  ON leads(status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_imported_at
  ON leads(imported_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_phone
  ON leads(phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_leads_touch ON leads;
CREATE TRIGGER trg_leads_touch
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Lowercase + trim email automatically on insert/update
CREATE OR REPLACE FUNCTION leads_normalize_email()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    NEW.email := lower(btrim(NEW.email));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_normalize_email ON leads;
CREATE TRIGGER trg_leads_normalize_email
  BEFORE INSERT OR UPDATE OF email ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_normalize_email();


-- ----------------------------------------------------------------
-- 4. lead_list_members — many-to-many
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_list_members (
  lead_list_id        UUID NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by_id         UUID REFERENCES profiles(id) ON DELETE SET NULL,

  PRIMARY KEY (lead_list_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_list_members_lead
  ON lead_list_members(lead_id);

-- Refresh lead_lists.lead_count when membership changes
CREATE OR REPLACE FUNCTION lead_list_members_refresh_counts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_list_id UUID;
BEGIN
  v_list_id := COALESCE(NEW.lead_list_id, OLD.lead_list_id);
  UPDATE lead_lists
     SET lead_count = (
           SELECT count(*) FROM lead_list_members WHERE lead_list_id = v_list_id
         ),
         active_lead_count = (
           SELECT count(*)
             FROM lead_list_members m
             JOIN leads l ON l.id = m.lead_id
            WHERE m.lead_list_id = v_list_id
              AND l.deleted_at IS NULL
              AND l.status = 'active'
         )
   WHERE id = v_list_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_list_members_count ON lead_list_members;
CREATE TRIGGER trg_lead_list_members_count
  AFTER INSERT OR DELETE ON lead_list_members
  FOR EACH ROW EXECUTE FUNCTION lead_list_members_refresh_counts();


-- ----------------------------------------------------------------
-- 5. outreach_campaigns — a sending job (lead_list × template)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name                    TEXT NOT NULL,                       -- internal label
  audience_type           outreach_audience NOT NULL DEFAULT 'other',
  lead_list_id            UUID NOT NULL REFERENCES lead_lists(id) ON DELETE RESTRICT,

  -- From / Reply-To (the secret sauce for cold outreach)
  -- Default convention: From = <name>@investproleads.com,
  --                     Reply-To = <name>@investprorealty.net
  from_address            TEXT NOT NULL,
  from_display_name       TEXT NOT NULL,
  reply_to_address        TEXT NOT NULL,

  -- Body templates (support {first_name}, {last_name}, {property_address}, {unsubscribe_url})
  subject_template        TEXT NOT NULL,
  body_html_template      TEXT NOT NULL,
  body_text_template      TEXT,                                -- optional plain-text fallback

  -- Throttling / safety
  daily_send_cap          INT NOT NULL DEFAULT 250,            -- per-day max sends for this campaign
  per_second_cap          INT NOT NULL DEFAULT 1,              -- soft rate limit
  resend_suppression_days INT NOT NULL DEFAULT 90,             -- don't re-send to same lead within N days

  -- Provider
  provider                outreach_provider NOT NULL DEFAULT 'resend',

  -- Lifecycle
  status                  outreach_campaign_status NOT NULL DEFAULT 'draft',
  scheduled_at            TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  archived_at             TIMESTAMPTZ,

  -- Cached aggregate counts (updated by trigger on outreach_sends)
  total_queued            INT NOT NULL DEFAULT 0,
  total_sent              INT NOT NULL DEFAULT 0,
  total_delivered         INT NOT NULL DEFAULT 0,
  total_bounced           INT NOT NULL DEFAULT 0,
  total_complained        INT NOT NULL DEFAULT 0,
  total_unsubscribed      INT NOT NULL DEFAULT 0,
  total_skipped           INT NOT NULL DEFAULT 0,

  created_by_id           UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_status
  ON outreach_campaigns(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_lead_list
  ON outreach_campaigns(lead_list_id);

DROP TRIGGER IF EXISTS trg_outreach_campaigns_touch ON outreach_campaigns;
CREATE TRIGGER trg_outreach_campaigns_touch
  BEFORE UPDATE ON outreach_campaigns
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 6. outreach_sends — one row per send attempt
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_sends (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id             UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  lead_id                 UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- Snapshots at queue time (so we can audit even if lead changes)
  to_email                TEXT NOT NULL,                       -- snapshot
  rendered_subject        TEXT,                                -- subject_template after substitution
  rendered_body_html      TEXT,                                -- body_html after substitution
  rendered_body_text      TEXT,
  unsubscribe_token       TEXT,                                -- per-send unsubscribe token (in URL)

  -- Lifecycle
  status                  outreach_send_status NOT NULL DEFAULT 'queued',
  queued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sending_started_at      TIMESTAMPTZ,
  sent_at                 TIMESTAMPTZ,
  delivered_at            TIMESTAMPTZ,
  bounced_at              TIMESTAMPTZ,
  complained_at           TIMESTAMPTZ,
  failed_at               TIMESTAMPTZ,

  -- Provider details
  provider                outreach_provider NOT NULL DEFAULT 'resend',
  provider_message_id     TEXT,                                -- Resend/SES message ID
  provider_response       JSONB,                               -- raw response from provider

  -- Failure / bounce details
  bounce_type             TEXT,                                -- 'hard', 'soft', 'block'
  bounce_subtype          TEXT,
  diagnostic_code         TEXT,
  error_message           TEXT,

  -- Engagement (filled by webhook events)
  opened_count            INT NOT NULL DEFAULT 0,
  first_opened_at         TIMESTAMPTZ,
  clicked_count           INT NOT NULL DEFAULT 0,
  first_clicked_at        TIMESTAMPTZ,
  last_event_at           TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(campaign_id, lead_id)                                  -- never queue the same lead twice for one campaign
);

CREATE INDEX IF NOT EXISTS idx_outreach_sends_campaign_status
  ON outreach_sends(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_lead
  ON outreach_sends(lead_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_provider_msg
  ON outreach_sends(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_sends_queued
  ON outreach_sends(status, queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_outreach_sends_unsub_token
  ON outreach_sends(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;

DROP TRIGGER IF EXISTS trg_outreach_sends_touch ON outreach_sends;
CREATE TRIGGER trg_outreach_sends_touch
  BEFORE UPDATE ON outreach_sends
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 7. outreach_unsubscribes — append-only CAN-SPAM record
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_unsubscribes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL,                            -- lowercased
  lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id         UUID REFERENCES outreach_campaigns(id) ON DELETE SET NULL,
  send_id             UUID REFERENCES outreach_sends(id) ON DELETE SET NULL,
  source              unsubscribe_source NOT NULL,
  reason              TEXT,
  ip_address          INET,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_unsubs_email
  ON outreach_unsubscribes(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_outreach_unsubs_lead
  ON outreach_unsubscribes(lead_id);


-- ----------------------------------------------------------------
-- 8. outreach_bounces — append-only deliverability log
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_bounces (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL,
  lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
  send_id             UUID REFERENCES outreach_sends(id) ON DELETE SET NULL,
  bounce_type         TEXT NOT NULL,                            -- 'hard', 'soft', 'complaint', 'block'
  bounce_subtype      TEXT,                                     -- e.g., 'mailbox_full', 'suppressed'
  diagnostic_code     TEXT,
  raw_payload         JSONB,                                    -- full webhook payload for forensics
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_bounces_email
  ON outreach_bounces(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_outreach_bounces_send
  ON outreach_bounces(send_id);


-- ----------------------------------------------------------------
-- 9. Audit triggers — every table gets full edit history
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_lead_lists ON lead_lists;
CREATE TRIGGER trg_audit_lead_lists
  AFTER INSERT OR UPDATE OR DELETE ON lead_lists
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_leads ON leads;
CREATE TRIGGER trg_audit_leads
  AFTER INSERT OR UPDATE OR DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_lead_list_members ON lead_list_members;
CREATE TRIGGER trg_audit_lead_list_members
  AFTER INSERT OR UPDATE OR DELETE ON lead_list_members
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_outreach_campaigns ON outreach_campaigns;
CREATE TRIGGER trg_audit_outreach_campaigns
  AFTER INSERT OR UPDATE OR DELETE ON outreach_campaigns
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_outreach_sends ON outreach_sends;
CREATE TRIGGER trg_audit_outreach_sends
  AFTER INSERT OR UPDATE OR DELETE ON outreach_sends
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

-- Unsubscribes / bounces are append-only by design — no audit trigger needed
-- (the table itself IS the audit record). We do still add INSERT-only audit
-- to catch any deletes that shouldn't happen.
DROP TRIGGER IF EXISTS trg_audit_outreach_unsubs ON outreach_unsubscribes;
CREATE TRIGGER trg_audit_outreach_unsubs
  AFTER UPDATE OR DELETE ON outreach_unsubscribes
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_outreach_bounces ON outreach_bounces;
CREATE TRIGGER trg_audit_outreach_bounces
  AFTER UPDATE OR DELETE ON outreach_bounces
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 10. RLS — broker / compliance / admin_onsite manage all
-- ----------------------------------------------------------------
ALTER TABLE lead_lists            ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_list_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_campaigns    ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_sends        ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_unsubscribes ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_bounces      ENABLE ROW LEVEL SECURITY;

-- Manager full access on every table
DO $$
DECLARE
  t TEXT;
  managers TEXT := 'broker, compliance, admin_onsite';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lead_lists',
    'leads',
    'lead_list_members',
    'outreach_campaigns',
    'outreach_sends',
    'outreach_unsubscribes',
    'outreach_bounces'
  ] LOOP
    EXECUTE format($f$
      DROP POLICY IF EXISTS %I_managers_all ON %I;
      CREATE POLICY %I_managers_all ON %I
        FOR ALL TO authenticated
        USING (current_user_role() IN ('broker', 'compliance', 'admin_onsite'))
        WITH CHECK (current_user_role() IN ('broker', 'compliance', 'admin_onsite'));
    $f$, t, t, t, t);
  END LOOP;
END $$;

-- Public unsubscribe — service-role function will write to outreach_unsubscribes
-- bypassing RLS. The public landing page hits a Netlify function that uses
-- the service-role key. No anon-role policy needed.


-- ----------------------------------------------------------------
-- 11. Helper: lead_can_receive(lead_id, campaign_id)
-- ----------------------------------------------------------------
-- Encapsulates the suppression rule. Returns TRUE if the lead is
-- eligible to receive a send for the given campaign right now.
CREATE OR REPLACE FUNCTION lead_can_receive(
  p_lead_id     UUID,
  p_campaign_id UUID
) RETURNS TABLE (
  eligible      BOOLEAN,
  reason        TEXT
) LANGUAGE plpgsql AS $$
DECLARE
  v_lead   RECORD;
  v_camp   RECORD;
  v_recent INT;
BEGIN
  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'lead_not_found'; RETURN;
  END IF;
  IF v_lead.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'lead_deleted'; RETURN;
  END IF;
  IF v_lead.status <> 'active' THEN
    RETURN QUERY SELECT FALSE, 'lead_status_' || v_lead.status::text; RETURN;
  END IF;
  IF v_lead.unsubscribed_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'unsubscribed'; RETURN;
  END IF;
  IF v_lead.bounced_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'previously_bounced'; RETURN;
  END IF;
  IF v_lead.complained_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'previously_complained'; RETURN;
  END IF;

  SELECT * INTO v_camp FROM outreach_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'campaign_not_found'; RETURN;
  END IF;

  -- Don't re-send to a lead within the suppression window
  SELECT count(*) INTO v_recent
    FROM outreach_sends
   WHERE lead_id = p_lead_id
     AND sent_at IS NOT NULL
     AND sent_at >= NOW() - (v_camp.resend_suppression_days || ' days')::interval;
  IF v_recent > 0 THEN
    RETURN QUERY SELECT FALSE, 'within_suppression_window'; RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION lead_can_receive(UUID, UUID) TO authenticated;


-- ----------------------------------------------------------------
-- 12. Helper: refresh_outreach_campaign_counts(campaign_id)
-- ----------------------------------------------------------------
-- Recomputes the cached counters on outreach_campaigns from
-- outreach_sends. Called by the dispatch function after each batch
-- and by a periodic job.
CREATE OR REPLACE FUNCTION refresh_outreach_campaign_counts(p_campaign_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE outreach_campaigns SET
    total_queued       = (SELECT count(*) FROM outreach_sends WHERE campaign_id = p_campaign_id AND status = 'queued'),
    total_sent         = (SELECT count(*) FROM outreach_sends WHERE campaign_id = p_campaign_id AND status IN ('sent', 'delivered')),
    total_delivered    = (SELECT count(*) FROM outreach_sends WHERE campaign_id = p_campaign_id AND status = 'delivered'),
    total_bounced      = (SELECT count(*) FROM outreach_sends WHERE campaign_id = p_campaign_id AND status = 'bounced'),
    total_complained   = (SELECT count(*) FROM outreach_sends WHERE campaign_id = p_campaign_id AND status = 'complained'),
    total_skipped      = (SELECT count(*) FROM outreach_sends WHERE campaign_id = p_campaign_id AND status = 'skipped'),
    total_unsubscribed = (SELECT count(*) FROM outreach_unsubscribes
                            JOIN outreach_sends ON outreach_sends.id = outreach_unsubscribes.send_id
                           WHERE outreach_sends.campaign_id = p_campaign_id)
  WHERE id = p_campaign_id;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_outreach_campaign_counts(UUID) TO authenticated;


-- ----------------------------------------------------------------
-- 13. Verify
-- ----------------------------------------------------------------
SELECT 'lead_lists'            AS tbl, count(*) FROM lead_lists
UNION ALL SELECT 'leads',                count(*) FROM leads
UNION ALL SELECT 'lead_list_members',    count(*) FROM lead_list_members
UNION ALL SELECT 'outreach_campaigns',   count(*) FROM outreach_campaigns
UNION ALL SELECT 'outreach_sends',       count(*) FROM outreach_sends
UNION ALL SELECT 'outreach_unsubscribes',count(*) FROM outreach_unsubscribes
UNION ALL SELECT 'outreach_bounces',     count(*) FROM outreach_bounces;
