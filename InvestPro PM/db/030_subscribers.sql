-- ============================================================
-- 030 — Subscriber tier (free-tier members + LYMX wallet)
-- ============================================================
-- The other half of the BOP "Two paths" model:
--   Path 1 (already built): Agent — full Independent Contractor
--   Path 2 (this migration): Subscriber — free, lower-friction
--
-- Subscribers join the InvestPro ecosystem without licensing or
-- contractor agreements. They:
--   * Get a public profile / share code (referral attribution)
--   * Hold a LYMX wallet (network-spendable cashback currency,
--     "Powered by LYMX")
--   * Earn LYMX on InvestPro fee payments (application fees,
--     transaction fees, PM fees, agent dues, etc. — earn rates
--     are policy, not enforced here)
--   * Redeem LYMX against InvestPro fees (NOT rent) and across
--     the broader LYMX network at any LYMX-network business
--   * Receive InvestPro newsletters / training event invites
--
-- IMPORTANT: This schema is the local LYMX *ledger only*. The
-- real LYMX network wallet (getlymx.com) is a future API sync.
-- For now, balances are tracked internally; pages display
-- "Powered by LYMX" branding.
--
-- Background: Kenny 2026-05-03 — Block C of the rebuild,
-- pivoted from generic "rewards points" to LYMX integration.
-- Foundation only; full earn-on-transaction wiring comes later.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Subscribers table
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE subscriber_status AS ENUM (
    'active',
    'paused',         -- temporarily opted out of mail
    'unsubscribed',   -- hard bounce or user-requested removal
    'spam'            -- flagged
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS subscribers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional link to a profiles row (subscriber may upgrade to agent later)
  profile_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Personal info (most subscribers won't have a full profile)
  email               TEXT NOT NULL UNIQUE,
  full_name           TEXT,
  phone               TEXT,

  -- A unique 7-char share code so subscribers can refer others (just like agents)
  -- Format: SUB-XXXXX
  share_code          TEXT UNIQUE,
  sponsor_subscriber_id UUID REFERENCES subscribers(id) ON DELETE SET NULL,
  sponsor_agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,

  -- Lifecycle
  status              subscriber_status NOT NULL DEFAULT 'active',
  status_reason       TEXT,
  source              TEXT,                                  -- 'website', 'referral', 'event', 'manual'
  source_url          TEXT,
  utm_source          TEXT,
  utm_medium          TEXT,
  utm_campaign        TEXT,

  -- Cached LYMX balance (true source of truth is subscriber_lymx_log).
  -- 1 LYMX ≈ $0.01 face value (matches LYMX network convention).
  lymx_balance        NUMERIC(12,2) NOT NULL DEFAULT 0,
  lymx_lifetime       NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Whether this subscriber has been linked to a real LYMX network wallet
  -- on getlymx.com (future API sync — see docs/LYMX-PROGRAM.md).
  lymx_network_synced BOOLEAN NOT NULL DEFAULT FALSE,
  lymx_network_id     TEXT,                                   -- external wallet ID once synced

  -- Communication preferences
  newsletter_opt_in   BOOLEAN NOT NULL DEFAULT TRUE,
  events_opt_in       BOOLEAN NOT NULL DEFAULT TRUE,
  sms_opt_in          BOOLEAN NOT NULL DEFAULT FALSE,
  unsubscribed_at     TIMESTAMPTZ,

  -- Welcome email
  welcome_email_sent_at TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email
  ON subscribers(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_subscribers_status
  ON subscribers(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscribers_share_code
  ON subscribers(share_code) WHERE share_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscribers_sponsor
  ON subscribers(sponsor_subscriber_id) WHERE sponsor_subscriber_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_subscribers_touch ON subscribers;
CREATE TRIGGER trg_subscribers_touch
  BEFORE UPDATE ON subscribers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 2. Auto-generate share_code on insert
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION subscribers_set_share_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_attempt INT := 0;
  v_code TEXT;
BEGIN
  IF NEW.share_code IS NULL THEN
    LOOP
      v_code := 'SUB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
      IF NOT EXISTS (SELECT 1 FROM subscribers WHERE share_code = v_code) THEN
        NEW.share_code := v_code;
        EXIT;
      END IF;
      v_attempt := v_attempt + 1;
      IF v_attempt > 10 THEN
        RAISE EXCEPTION 'could not generate unique share_code after 10 attempts';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_subscribers_set_share_code ON subscribers;
CREATE TRIGGER trg_subscribers_set_share_code
  BEFORE INSERT ON subscribers
  FOR EACH ROW EXECUTE FUNCTION subscribers_set_share_code();


-- ----------------------------------------------------------------
-- 3. Subscriber LYMX log
-- ----------------------------------------------------------------
-- Every LYMX issuance and redemption is appended here. The
-- subscribers.lymx_balance and lymx_lifetime columns are caches
-- maintained by award_lymx() — DO NOT update them directly.
DO $$ BEGIN
  CREATE TYPE lymx_source AS ENUM (
    'signup_bonus',                -- 100-LYMX welcome
    'referral_signup',             -- their referral signed up (sponsor earns this)
    'referral_agent_joined',       -- their referral became an active agent (bigger bonus)
    'event_attendance',            -- attended a live event / webinar
    'feedback_submitted',          -- submitted useful feedback / review
    'social_share',                -- shared a post (verified via UTM)
    -- Earn-on-transaction sources (rates set in policy, not enforced here):
    'earn_rent_payment',           -- tenant earns LYMX when rent is paid
    'earn_pm_fee',                 -- owner earns LYMX on PM fee debit
    'earn_application_fee',        -- applicant earns LYMX on rental application fee
    'earn_transaction_fee',        -- buyer/seller earns LYMX on closing transaction fees
    'earn_office_dues',            -- agent earns LYMX on office dues paid
    'earn_agent_transaction_fee',  -- agent earns LYMX on agent transaction fees paid
    -- Negative entries:
    'redemption',                  -- redeemed against an InvestPro fee (negative)
    'network_redemption',          -- redeemed at a non-InvestPro LYMX-network business
    'network_sync_out',            -- transferred to external LYMX network wallet
    'manual_adjustment',
    'birthday_gift',
    'milestone_bonus'              -- e.g. 1-year anniversary
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS subscriber_lymx_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id   UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  lymx            NUMERIC(12,2) NOT NULL,                  -- can be negative for redemptions
  source          lymx_source NOT NULL,
  source_ref_id   UUID,
  source_ref_type TEXT,
  description     TEXT,
  earned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  awarded_by_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  awarded_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_lymx_subscriber
  ON subscriber_lymx_log(subscriber_id, earned_at DESC);


-- ----------------------------------------------------------------
-- 4. award_lymx helper function
-- ----------------------------------------------------------------
-- Atomically inserts a log row AND updates the cached balance on
-- subscribers. Use this for every LYMX movement so caches stay
-- consistent.
CREATE OR REPLACE FUNCTION award_lymx(
  p_subscriber_id UUID,
  p_lymx NUMERIC,
  p_source lymx_source,
  p_source_ref_id UUID DEFAULT NULL,
  p_source_ref_type TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor_id UUID;
  v_actor_name TEXT;
  v_log_id UUID;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor_id;
  END IF;

  INSERT INTO subscriber_lymx_log (subscriber_id, lymx, source, source_ref_id, source_ref_type,
                                   description, awarded_by_id, awarded_by_name)
  VALUES (p_subscriber_id, p_lymx, p_source, p_source_ref_id, p_source_ref_type,
          p_description, v_actor_id, v_actor_name)
  RETURNING id INTO v_log_id;

  UPDATE subscribers
  SET lymx_balance  = lymx_balance + p_lymx,
      lymx_lifetime = lymx_lifetime + GREATEST(p_lymx, 0)
  WHERE id = p_subscriber_id;

  RETURN v_log_id;
END;
$$;

GRANT EXECUTE ON FUNCTION award_lymx(UUID, NUMERIC, lymx_source, UUID, TEXT, TEXT) TO authenticated;


-- ----------------------------------------------------------------
-- 5. Audit triggers
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_subscribers ON subscribers;
CREATE TRIGGER trg_audit_subscribers
  AFTER INSERT OR UPDATE OR DELETE ON subscribers
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_subscriber_lymx_log ON subscriber_lymx_log;
CREATE TRIGGER trg_audit_subscriber_lymx_log
  AFTER INSERT OR UPDATE OR DELETE ON subscriber_lymx_log
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 6. RLS
-- ----------------------------------------------------------------
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_lymx_log ENABLE ROW LEVEL SECURITY;

-- Subscribers — managers see all, individual subscribers see their own (when linked to profile)
DROP POLICY IF EXISTS subscribers_managers_all ON subscribers;
CREATE POLICY subscribers_managers_all ON subscribers
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'compliance', 'admin_onsite', 'accounting'))
  WITH CHECK (current_user_role() IN ('broker', 'compliance', 'admin_onsite', 'accounting'));

DROP POLICY IF EXISTS subscribers_self_read ON subscribers;
CREATE POLICY subscribers_self_read ON subscribers
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- Sponsoring agents can see subscribers they sponsored (for referral pipeline)
DROP POLICY IF EXISTS subscribers_sponsor_read ON subscribers;
CREATE POLICY subscribers_sponsor_read ON subscribers
  FOR SELECT TO authenticated
  USING (
    sponsor_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid())
  );

-- LYMX log — same pattern
DROP POLICY IF EXISTS sub_lymx_managers_all ON subscriber_lymx_log;
CREATE POLICY sub_lymx_managers_all ON subscriber_lymx_log
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'compliance', 'admin_onsite', 'accounting'))
  WITH CHECK (current_user_role() IN ('broker', 'compliance', 'admin_onsite', 'accounting'));

DROP POLICY IF EXISTS sub_lymx_self_read ON subscriber_lymx_log;
CREATE POLICY sub_lymx_self_read ON subscriber_lymx_log
  FOR SELECT TO authenticated
  USING (
    subscriber_id IN (SELECT id FROM subscribers WHERE profile_id = auth.uid())
  );


-- ----------------------------------------------------------------
-- 7. Verify
-- ----------------------------------------------------------------
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'subscribers' ORDER BY ordinal_position;
