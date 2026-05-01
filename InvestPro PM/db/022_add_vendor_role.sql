-- ============================================================
-- 022 — Add 'vendor' role for recurring third-party vendors
-- ============================================================
-- Adds a new role for cleaning companies, handymen, exterminators, etc.
-- who do work for InvestPro frequently enough to deserve a real portal
-- account (vs. one-time vendors who'll get magic links — see Phase 2).
--
-- Vendors get a stripped-down dashboard showing only inspections + work
-- orders assigned to them. They cannot see PII, properties they aren't
-- working on, financials, or anything else.
--
-- Background: Kenny 2026-05-01 — wants to onboard team members and vendors
-- so inspections can be assigned to specific people.
-- ============================================================

DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'vendor';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ----------------------------------------------------------------
-- Vendor RLS — minimal: see only inspections assigned to them
-- (already covered by inspections_agent_self in db/021, since
--  current_user_role() returns 'vendor' and they can be in
--  assigned_to_roles or be the specific inspector_profile_id)
-- ----------------------------------------------------------------
-- No new policies needed; just confirming the existing policy works.


-- ----------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'user_role'::regtype
ORDER BY enumsortorder;
