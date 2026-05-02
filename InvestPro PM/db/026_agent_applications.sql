-- ============================================================
-- 026 — Agent applications (recruiting funnel)
-- ============================================================
-- Captures submissions from the public "Join InvestPro" form on
-- recruiting.html. Each row is a lead — a licensed agent (or aspiring
-- one) who's interested in joining InvestPro under the MGC structure.
--
-- Workflow:
--   1. Public form posts → apply-agent Netlify function
--   2. Function INSERTS a row here + emails Kenny
--   3. Broker/compliance/admin_onsite review in portal
--   4. Move through statuses: new → contacted → scheduled → joined / declined
--
-- Background: Kenny 2026-05-01 — Phase 1 of public-site rebuild
-- focused on recruiting funnel.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Status enum
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE agent_application_status AS ENUM (
    'new',          -- just submitted
    'contacted',    -- staff reached out
    'scheduled',    -- intro call booked
    'joined',       -- signed contract, on the team
    'declined',     -- closed without joining
    'spam'          -- junk submission
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ----------------------------------------------------------------
-- 2. Applications table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_applications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Personal
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT NOT NULL,

  -- Background
  licensed              TEXT,              -- "Yes — Salesperson" | "Yes — Broker" | etc.
  current_brokerage     TEXT,
  interest              TEXT,              -- "Joining as individual agent" | "Bringing my team" | etc.
  message               TEXT,

  -- Lifecycle
  status                agent_application_status NOT NULL DEFAULT 'new',
  assigned_to_id        UUID REFERENCES profiles(id) ON DELETE SET NULL,
  resolution_notes      TEXT,

  -- Sponsor / referral attribution
  -- If the lead came in via a sponsor's share link (?sponsor=AGT-XXXX),
  -- track the sponsor's agent_id so we can credit the override.
  sponsor_agent_id      UUID REFERENCES agents(id) ON DELETE SET NULL,
  source_url            TEXT,
  utm_source            TEXT,
  utm_medium            TEXT,
  utm_campaign          TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_applications_status
  ON agent_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_applications_email
  ON agent_applications(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_agent_applications_sponsor
  ON agent_applications(sponsor_agent_id) WHERE sponsor_agent_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_agent_applications_touch ON agent_applications;
CREATE TRIGGER trg_agent_applications_touch
  BEFORE UPDATE ON agent_applications
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 3. RLS
-- ----------------------------------------------------------------
ALTER TABLE agent_applications ENABLE ROW LEVEL SECURITY;

-- Public form posts via Netlify function (uses service-role key — bypasses RLS).
-- We do NOT add a public anonymous INSERT policy here because the form
-- submission goes through the server-side function for spam validation
-- and email notification. This keeps the table tamper-resistant from
-- direct PostgREST calls by random clients.

-- Manager roles read all
DROP POLICY IF EXISTS agent_applications_managers_read ON agent_applications;
CREATE POLICY agent_applications_managers_read ON agent_applications
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('broker', 'compliance', 'admin_onsite'));

-- Manager roles update (status changes, resolution notes, assignment)
DROP POLICY IF EXISTS agent_applications_managers_update ON agent_applications;
CREATE POLICY agent_applications_managers_update ON agent_applications
  FOR UPDATE TO authenticated
  USING (current_user_role() IN ('broker', 'compliance', 'admin_onsite'))
  WITH CHECK (current_user_role() IN ('broker', 'compliance', 'admin_onsite'));

-- Sponsor agents can read applications attributed to them (so they can
-- track their referral pipeline). They can't modify status.
DROP POLICY IF EXISTS agent_applications_sponsor_read ON agent_applications;
CREATE POLICY agent_applications_sponsor_read ON agent_applications
  FOR SELECT TO authenticated
  USING (
    sponsor_agent_id IN (
      SELECT id FROM agents WHERE profile_id = auth.uid()
    )
  );


-- ----------------------------------------------------------------
-- 4. Audit trigger (per the audit-trail rules — every editable
--    record gets a history)
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_agent_applications ON agent_applications;
CREATE TRIGGER trg_audit_agent_applications
  AFTER INSERT OR UPDATE OR DELETE ON agent_applications
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 5. Verify
-- ----------------------------------------------------------------
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'agent_applications' ORDER BY ordinal_position;
