-- ============================================================
-- 029 — Sponsor propagation (closes the recruiting → MGC loop)
-- ============================================================
-- Connects the public recruiting funnel to the MGC override chain:
--   1. Public form captures ?sponsor=AGT-XXXX in agent_applications.sponsor_agent_id
--   2. Manager flips application status to 'joined'
--   3. Manager invites the agent via Manage Users (creates profiles row)
--   4. Broker eventually creates an agents row (with license, share code, etc.)
--   5. *** This migration *** makes sure the sponsor link gets copied
--      to the new agent's agents.sponsor_agent_id, so generational
--      override credit will flow correctly when their first deal closes.
--
-- Two paths cover the timing variations:
--   A. Function called explicitly when the application moves to joined,
--      AND when an agents row is created.
--   B. Trigger on agents AFTER INSERT — checks if there's a matching
--      application by email and back-fills sponsor.
--
-- Background: Kenny 2026-05-03 — without this, the recruiting funnel
-- captures sponsor info but the override chain never knows about it.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Function — propagate sponsor from application to agents row
-- ----------------------------------------------------------------
-- Idempotent: safe to call multiple times. Only sets sponsor_agent_id
-- if it's currently NULL on the agents row.
CREATE OR REPLACE FUNCTION propagate_sponsor_to_agent(p_application_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_app           RECORD;
  v_profile_id    UUID;
  v_agent_id      UUID;
  v_already_set   UUID;
BEGIN
  -- Pull the application
  SELECT id, email, sponsor_agent_id, first_name, last_name
    INTO v_app
    FROM agent_applications
    WHERE id = p_application_id;

  IF v_app IS NULL OR v_app.sponsor_agent_id IS NULL THEN
    RETURN FALSE;  -- no application or no sponsor to propagate
  END IF;

  -- Find the matching profile by email (case-insensitive)
  SELECT id INTO v_profile_id
    FROM profiles
    WHERE LOWER(email) = LOWER(v_app.email)
    LIMIT 1;

  IF v_profile_id IS NULL THEN
    RETURN FALSE;  -- agent not yet invited to portal
  END IF;

  -- Find the matching agents row
  SELECT id, sponsor_agent_id INTO v_agent_id, v_already_set
    FROM agents
    WHERE profile_id = v_profile_id
    LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN FALSE;  -- agents row not created yet (broker creates this when wiring license, etc.)
  END IF;

  -- Don't overwrite an existing sponsor link (broker may have set manually)
  IF v_already_set IS NOT NULL THEN
    RETURN FALSE;
  END IF;

  -- Copy the sponsor over
  UPDATE agents
  SET sponsor_agent_id = v_app.sponsor_agent_id
  WHERE id = v_agent_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION propagate_sponsor_to_agent(UUID) TO authenticated;


-- ----------------------------------------------------------------
-- 2. Trigger on agents AFTER INSERT — back-fill sponsor by email
-- ----------------------------------------------------------------
-- Catches the timing where an agents row is created AFTER the application
-- was already moved to 'joined'. When inserted, it looks up the most
-- recent matching joined application and copies the sponsor.
CREATE OR REPLACE FUNCTION agents_backfill_sponsor()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_email     TEXT;
  v_sponsor   UUID;
BEGIN
  -- Already has a sponsor? Don't override.
  IF NEW.sponsor_agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Find the agent's email via profiles
  SELECT email INTO v_email FROM profiles WHERE id = NEW.profile_id;
  IF v_email IS NULL THEN RETURN NEW; END IF;

  -- Find most recent joined application with this email + a sponsor
  SELECT sponsor_agent_id INTO v_sponsor
    FROM agent_applications
    WHERE LOWER(email) = LOWER(v_email)
      AND status IN ('joined', 'scheduled', 'contacted', 'new')
      AND sponsor_agent_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1;

  IF v_sponsor IS NOT NULL THEN
    NEW.sponsor_agent_id := v_sponsor;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_backfill_sponsor ON agents;
CREATE TRIGGER trg_agents_backfill_sponsor
  BEFORE INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_backfill_sponsor();


-- ----------------------------------------------------------------
-- 3. Verify
-- ----------------------------------------------------------------
SELECT routine_name FROM information_schema.routines
  WHERE routine_name IN ('propagate_sponsor_to_agent', 'agents_backfill_sponsor');

SELECT trigger_name, event_manipulation, action_timing
  FROM information_schema.triggers
  WHERE trigger_name = 'trg_agents_backfill_sponsor';
