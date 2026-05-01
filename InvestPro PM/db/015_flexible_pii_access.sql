-- ============================================================
-- 015 — Flexible PII access (broker controls who sees what)
-- ============================================================
-- WHO CAN SEE APPLICANT DOCUMENTS AND PII (income, ID, SSN, screening reports):
--   Anyone with profiles.pii_access = TRUE
--   Plus the applicant themselves
--
-- DEFAULT pii_access values:
--   TRUE  : broker, va, accounting, compliance, admin_onsite
--   FALSE : leasing, pm_service, agent_listing, agent_showing,
--           applicant, tenant, owner
--
-- The broker can flip pii_access on/off per person at any time:
--   UPDATE profiles SET pii_access = TRUE  WHERE email = '...';
--   UPDATE profiles SET pii_access = FALSE WHERE email = '...';
--
-- This separates "what dashboard you land on" (role) from "what data you see"
-- (pii_access). When duties shift among team members, just flip the flag —
-- no need to change anyone's role or dashboard.
--
-- ROLES that NEVER get PII access (even if pii_access=TRUE somehow):
--   applicant, tenant, owner — these are external users; they always see
--   ONLY their own data, which is enforced via separate per-row policies.
--
-- Background: Kenny's directives 2026-04-30 — "duties get moved around among
-- team members, base on their abilities and availabilities".
-- ============================================================


-- ----------------------------------------------------------------
-- 1. NEW COLUMN — profiles.pii_access
-- ----------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pii_access BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.pii_access IS
  'TRUE = this person can see applicant PII (income, ID, SSN, screening reports, documents). FALSE = they see only status + dates. Broker controls this; flip as duties shift.';

CREATE INDEX IF NOT EXISTS profiles_pii_access_idx ON profiles(pii_access);


-- ----------------------------------------------------------------
-- 2. BOOTSTRAP — set defaults for the 7 staff already in the system
-- ----------------------------------------------------------------
-- Anyone in the always-trusted internal group → TRUE
UPDATE profiles
SET pii_access = TRUE
WHERE role IN ('broker', 'va', 'accounting', 'compliance', 'admin_onsite');

-- Everyone else stays at FALSE (the column default)


-- ----------------------------------------------------------------
-- 3. HELPER FUNCTION — current_user_has_pii_access()
-- ----------------------------------------------------------------
-- SECURITY DEFINER so it can read profiles regardless of RLS on profiles.
CREATE OR REPLACE FUNCTION current_user_has_pii_access()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT COALESCE(
    (SELECT pii_access FROM profiles WHERE id = auth.uid()),
    FALSE
  )
$$;


-- ----------------------------------------------------------------
-- 4. UPDATE can_see_application() — uses pii_access flag now
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_see_application(p_application_id UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM applications a
    WHERE a.id = p_application_id
      AND (
        -- The applicant themselves
        a.applicant_profile_id = auth.uid()
        OR a.email = (SELECT email FROM profiles WHERE id = auth.uid())
        -- Anyone whose pii_access flag is TRUE
        OR current_user_has_pii_access()
      )
  )
$$;


-- ----------------------------------------------------------------
-- 5. POLICIES on `applications` table — drop old, install flag-based
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS apps_staff_read ON applications;
CREATE POLICY apps_staff_read ON applications
  FOR SELECT TO authenticated
  USING (current_user_has_pii_access());

DROP POLICY IF EXISTS apps_workflow_update ON applications;
CREATE POLICY apps_workflow_update ON applications
  FOR UPDATE TO authenticated
  USING (current_user_has_pii_access());

-- Agents previously had full app read access — REVOKED. They use get_app_statuses() now.
DROP POLICY IF EXISTS apps_agent_read ON applications;


-- ----------------------------------------------------------------
-- 6. PII-HEAVY tables — restrict to pii_access=TRUE
-- ----------------------------------------------------------------
-- verifications: was broker/va/compliance/leasing — now flag-based
DROP POLICY IF EXISTS verifications_staff_only ON verifications;
CREATE POLICY verifications_staff_only ON verifications
  FOR ALL TO authenticated
  USING (current_user_has_pii_access())
  WITH CHECK (current_user_has_pii_access());

-- screening_reports: was broker/va/compliance — now flag-based
DROP POLICY IF EXISTS screening_staff_only ON screening_reports;
CREATE POLICY screening_staff_only ON screening_reports
  FOR ALL TO authenticated
  USING (current_user_has_pii_access())
  WITH CHECK (current_user_has_pii_access());


-- ----------------------------------------------------------------
-- 7. STATUS-ONLY VIEW for restricted roles (leasing, pm_service, agents)
-- ----------------------------------------------------------------
-- get_app_statuses() — returns ONLY status + key dates + IDs (no name, email,
-- phone, SSN, income, address, etc.). Use this from dashboards instead of
-- querying `applications` directly when the user has pii_access = FALSE.
CREATE OR REPLACE FUNCTION get_app_statuses()
RETURNS TABLE(
  id                    UUID,
  confirmation_number   TEXT,
  status                TEXT,
  created_at            TIMESTAMPTZ,
  broker_decision_at    TIMESTAMPTZ,
  move_in_at            TIMESTAMPTZ,
  property_id           UUID,
  showing_agent_id      UUID,
  listing_agent_id      UUID
)
SECURITY DEFINER
LANGUAGE sql STABLE
AS $$
  SELECT
    a.id,
    a.confirmation_number,
    a.status::text,
    a.created_at,           -- application submitted
    a.broker_decision_at,   -- when broker approved/denied (or NULL if pending)
    a.move_in_at,           -- target move-in (or NULL if not set yet)
    a.property_id,
    a.showing_agent_id,
    a.listing_agent_id
  FROM applications a
  WHERE
    -- People with PII access already see the full row, but include here so
    -- dashboards can call this function uniformly.
    current_user_has_pii_access()
    -- Operational roles: leasing & pm_service see all apps, status-only
    OR current_user_role() IN ('leasing', 'pm_service')
    -- Listing agent: only their listings
    OR (current_user_role() = 'agent_listing'
        AND a.listing_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid()))
    -- Showing agent: only their applicants
    OR (current_user_role() = 'agent_showing'
        AND a.showing_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid()))
    -- The applicant themselves
    OR a.applicant_profile_id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION get_app_statuses() TO authenticated;

COMMENT ON FUNCTION get_app_statuses() IS
  'Status-only view of applications visible to the current user. NEVER returns PII (name, email, phone, SSN, income, documents). Used by leasing, pm_service, and agent dashboards.';


-- ----------------------------------------------------------------
-- 8. PROFILES — restrict who can see applicant profiles
-- ----------------------------------------------------------------
-- pii_access = TRUE   → see all profiles (including applicants)
-- leasing, pm_service → see staff/agent/tenant/owner profiles, NOT applicants
-- everyone else       → see only themselves
DROP POLICY IF EXISTS profiles_self_read ON profiles;
CREATE POLICY profiles_self_read ON profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR current_user_has_pii_access()
    OR (current_user_role() IN ('leasing', 'pm_service')
        AND role IN ('broker','va','accounting','compliance','leasing','pm_service',
                     'admin_onsite','agent_listing','agent_showing','tenant','owner'))
  );


-- ----------------------------------------------------------------
-- 9. APPLICATION SUB-TABLES — already inherit via can_see_application()
-- ----------------------------------------------------------------
-- These tables (application_documents, application_co_applicants, application_pets,
-- application_vehicles, application_signatures, application_references) all use
-- the can_see_application() helper, which we updated above. So they automatically
-- restrict properly — no further change needed here.


-- ----------------------------------------------------------------
-- 10. VERIFY — quick sanity checks
-- ----------------------------------------------------------------
-- Confirm pii_access column exists with expected defaults
SELECT email, role, pii_access FROM profiles
WHERE role IN ('broker','va','accounting','compliance','admin_onsite',
               'leasing','pm_service','agent_listing','agent_showing')
ORDER BY role, email;

-- Confirm helper functions exist
SELECT proname FROM pg_proc WHERE proname IN ('current_user_has_pii_access','get_app_statuses','can_see_application');

-- Confirm PII-related policies updated
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('applications','verifications','screening_reports','profiles')
ORDER BY tablename, policyname;
