-- ============================================================
-- 028 — Multi-Generational Compensation (MGC) structure
-- ============================================================
-- Foundational schema for the recruiting / downline / overrides
-- system documented in the BOP and INVESTPRO REALTY.docx.
--
-- Career ladder (per docx, sec 6):
--   Associate → Senior Associate → Executive Associate
--   → Team Manager → Branch Broker
-- Generational overrides: 1st gen 5%, 2nd gen 3%, 3rd gen 1%
-- Two bonus pools: All-Company 2%, Executive 1%
-- Branch Broker: additional 1% of branch volume
--
-- Background: Kenny 2026-05-03 — Block C of the rebuild. Adds
-- foundational schema; UI / commission wiring follows in later
-- migrations as actual deals start flowing.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Career levels enum
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE agent_career_level AS ENUM (
    'associate',           -- entry, 50% split
    'senior_associate',    -- 30k+ pts, 65% split
    'executive_associate', -- 75k+ pts, 75% split
    'team_manager',        -- 75k+ pts + broker license, 80% split
    'branch_broker'        -- TM running an office, 80% + 1% branch override
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ----------------------------------------------------------------
-- 2. Extend agents with sponsor + level + points
-- ----------------------------------------------------------------
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS sponsor_agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_level       agent_career_level NOT NULL DEFAULT 'associate',
  ADD COLUMN IF NOT EXISTS points_ytd          NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_lifetime     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS branch_office_id    UUID,            -- nullable; populated when promoted to Branch Broker
  ADD COLUMN IF NOT EXISTS level_changed_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agents_sponsor
  ON agents(sponsor_agent_id) WHERE sponsor_agent_id IS NOT NULL;

COMMENT ON COLUMN agents.sponsor_agent_id IS
  'The agent who recruited this one. Used to compute the 3-generation override chain (this row''s sponsor = 1st gen, sponsor''s sponsor = 2nd gen, etc.).';

COMMENT ON COLUMN agents.points_ytd IS
  'Year-to-date earned points (1 point = $1 commission incl. referrals, spreads, overrides). Denormalized — recomputed by award_points() trigger. Resets to 0 each January via cron.';


-- ----------------------------------------------------------------
-- 3. Append-only points log
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE points_source AS ENUM (
    'personal_commission',   -- own deal closed
    'spread_commission',     -- spread between agent split and 100%
    'override_gen1',         -- 5% off direct downline
    'override_gen2',         -- 3% off 2nd gen
    'override_gen3',         -- 1% off 3rd gen
    'all_company_bonus',     -- 2% pool distribution
    'executive_bonus',       -- 1% pool distribution (TM only)
    'branch_broker_override',-- 1% of branch office volume
    'referral_fee',          -- inbound rental referral
    'manual_adjustment'      -- broker-applied correction
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS agent_points_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  points          NUMERIC(12,2) NOT NULL,        -- can be negative for adjustments
  source          points_source NOT NULL,
  source_ref_id   UUID,                          -- transaction / lease / commission row this came from
  source_ref_type TEXT,                          -- 'transactions' | 'leases' | etc. (free text for flexibility)

  description     TEXT,
  earned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  year            INTEGER NOT NULL DEFAULT EXTRACT(YEAR FROM NOW())::INTEGER,

  awarded_by_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  awarded_by_name TEXT,                          -- snapshot per audit-trail rules

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_points_log_agent
  ON agent_points_log(agent_id, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_points_log_year
  ON agent_points_log(year, agent_id);
CREATE INDEX IF NOT EXISTS idx_points_log_source
  ON agent_points_log(source);

DROP TRIGGER IF EXISTS trg_audit_agent_points_log ON agent_points_log;
CREATE TRIGGER trg_audit_agent_points_log
  AFTER INSERT OR UPDATE OR DELETE ON agent_points_log
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 4. Function: award points to an agent
-- ----------------------------------------------------------------
-- Inserts a row into agent_points_log AND updates the agent's
-- points_ytd / points_lifetime cached totals AND auto-promotes
-- their level if they cross a threshold.
CREATE OR REPLACE FUNCTION award_points(
  p_agent_id        UUID,
  p_points          NUMERIC,
  p_source          points_source,
  p_source_ref_id   UUID DEFAULT NULL,
  p_source_ref_type TEXT DEFAULT NULL,
  p_description     TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor_id   UUID;
  v_actor_name TEXT;
  v_log_id     UUID;
  v_new_ytd    NUMERIC;
  v_new_level  agent_career_level;
  v_old_level  agent_career_level;
  v_has_broker BOOLEAN;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor_id;
  END IF;

  -- Insert log entry
  INSERT INTO agent_points_log (agent_id, points, source, source_ref_id, source_ref_type,
                                description, awarded_by_id, awarded_by_name)
  VALUES (p_agent_id, p_points, p_source, p_source_ref_id, p_source_ref_type,
          p_description, v_actor_id, v_actor_name)
  RETURNING id INTO v_log_id;

  -- Update cached YTD + lifetime totals
  UPDATE agents
  SET points_ytd      = points_ytd + p_points,
      points_lifetime = points_lifetime + p_points
  WHERE id = p_agent_id
  RETURNING points_ytd, current_level INTO v_new_ytd, v_old_level;

  -- Auto-promote based on points + license
  -- (Demotion is manual — handled by broker via dashboard)
  -- Check if agent has broker license (used for team_manager threshold)
  SELECT (license_number IS NOT NULL AND license_number ILIKE 'B%')
    INTO v_has_broker
    FROM agents WHERE id = p_agent_id;

  v_new_level := v_old_level;
  IF v_new_ytd >= 75000 AND v_has_broker AND v_old_level <> 'team_manager' AND v_old_level <> 'branch_broker' THEN
    v_new_level := 'team_manager';
  ELSIF v_new_ytd >= 75000 AND v_old_level <> 'executive_associate' AND v_old_level <> 'team_manager' AND v_old_level <> 'branch_broker' THEN
    v_new_level := 'executive_associate';
  ELSIF v_new_ytd >= 30000 AND v_old_level = 'associate' THEN
    v_new_level := 'senior_associate';
  END IF;

  IF v_new_level <> v_old_level THEN
    UPDATE agents
    SET current_level = v_new_level,
        level_changed_at = NOW()
    WHERE id = p_agent_id;
  END IF;

  RETURN v_log_id;
END;
$$;

GRANT EXECUTE ON FUNCTION award_points(UUID, NUMERIC, points_source, UUID, TEXT, TEXT) TO authenticated;


-- ----------------------------------------------------------------
-- 5. View: agent's full downline (recursive)
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW v_agent_downline AS
WITH RECURSIVE chain AS (
  -- Each agent is generation 0 of themselves (used as the starting row)
  SELECT
    id AS root_agent_id,
    id AS agent_id,
    sponsor_agent_id,
    0 AS depth
  FROM agents

  UNION ALL

  -- Walk DOWN — find agents whose sponsor is in our chain so far
  SELECT
    c.root_agent_id,
    a.id,
    a.sponsor_agent_id,
    c.depth + 1
  FROM agents a
  JOIN chain c ON a.sponsor_agent_id = c.agent_id
  WHERE c.depth < 5  -- safety: cap recursion at 5 generations deep
)
SELECT root_agent_id, agent_id, depth
FROM chain
WHERE depth > 0;  -- exclude self

COMMENT ON VIEW v_agent_downline IS
  'Recursive downline view. To get all descendants of agent X: SELECT * FROM v_agent_downline WHERE root_agent_id = X. depth=1 = direct recruits, depth=2 = recruits-of-recruits, etc.';


-- ----------------------------------------------------------------
-- 6. View: aggregate downline stats per agent
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW v_agent_downline_summary AS
SELECT
  root_agent_id AS agent_id,
  COUNT(*) FILTER (WHERE depth = 1) AS gen1_count,
  COUNT(*) FILTER (WHERE depth = 2) AS gen2_count,
  COUNT(*) FILTER (WHERE depth = 3) AS gen3_count,
  COUNT(*) AS total_downline
FROM v_agent_downline
GROUP BY root_agent_id;


-- ----------------------------------------------------------------
-- 7. RLS — agents see their own log, downline overview etc.
-- ----------------------------------------------------------------
ALTER TABLE agent_points_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS points_log_managers_all ON agent_points_log;
CREATE POLICY points_log_managers_all ON agent_points_log
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'compliance', 'accounting', 'admin_onsite'))
  WITH CHECK (current_user_role() IN ('broker', 'compliance', 'accounting', 'admin_onsite'));

-- Agents see only their own points log
DROP POLICY IF EXISTS points_log_self_read ON agent_points_log;
CREATE POLICY points_log_self_read ON agent_points_log
  FOR SELECT TO authenticated
  USING (
    agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid())
  );


-- ----------------------------------------------------------------
-- 8. Verify
-- ----------------------------------------------------------------
SELECT enumlabel FROM pg_enum
  WHERE enumtypid = 'agent_career_level'::regtype ORDER BY enumsortorder;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'agents'
  AND column_name IN ('sponsor_agent_id', 'current_level', 'points_ytd', 'points_lifetime', 'branch_office_id')
ORDER BY column_name;
