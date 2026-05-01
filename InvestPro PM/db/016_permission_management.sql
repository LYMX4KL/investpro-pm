-- ============================================================
-- 016 — Permission management policies
-- ============================================================
-- Lets broker (Kenny) and compliance (Mandy, acting as office manager)
-- update other users' profiles — primarily to flip pii_access on/off.
--
-- Background: Kenny's directive 2026-04-30 — compliance acts as office
-- manager and is responsible for assigning and adjusting permissions
-- as duties shift.
--
-- WHO CAN DO WHAT:
--   * Broker:     can update ANY profile, including role + pii_access
--   * Compliance: can update ANY profile EXCEPT the broker's, including
--                 role + pii_access (column-level restriction is enforced
--                 in the Manage Permissions UI for v1)
--   * Self:       can update own profile (existing profiles_self_update policy)
--
-- SAFETY: the broker is hardcoded to always have pii_access = TRUE
--   regardless of the flag's value, so accidental self-lockout is impossible.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. SAFETY UPGRADE — broker is always TRUE for current_user_has_pii_access()
-- ----------------------------------------------------------------
-- This makes self-lockout impossible. Even if someone flips the broker's
-- pii_access flag to FALSE, the broker still has access.
CREATE OR REPLACE FUNCTION current_user_has_pii_access()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT
    -- Broker is always TRUE (cannot be locked out)
    (SELECT role = 'broker' FROM profiles WHERE id = auth.uid())
    OR
    -- Otherwise read the flag, default FALSE
    COALESCE(
      (SELECT pii_access FROM profiles WHERE id = auth.uid()),
      FALSE
    )
$$;


-- ----------------------------------------------------------------
-- 2. BROKER — full update access on any profile
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS profiles_broker_update ON profiles;
CREATE POLICY profiles_broker_update ON profiles
  FOR UPDATE TO authenticated
  USING (current_user_role() = 'broker')
  WITH CHECK (current_user_role() = 'broker');


-- ----------------------------------------------------------------
-- 3. COMPLIANCE — update any profile EXCEPT the broker's
-- ----------------------------------------------------------------
-- USING:      which existing rows compliance can target → all except broker
-- WITH CHECK: what the row must look like after update → cannot become a broker row
DROP POLICY IF EXISTS profiles_compliance_update ON profiles;
CREATE POLICY profiles_compliance_update ON profiles
  FOR UPDATE TO authenticated
  USING (current_user_role() = 'compliance' AND role != 'broker')
  WITH CHECK (current_user_role() = 'compliance' AND role != 'broker');


-- ----------------------------------------------------------------
-- 4. ENSURE compliance can READ profiles too (already in profiles_self_read)
-- ----------------------------------------------------------------
-- profiles_self_read already grants compliance full read via current_user_has_pii_access()
-- since compliance has pii_access = TRUE. No change needed.


-- ----------------------------------------------------------------
-- 5. VERIFY
-- ----------------------------------------------------------------
SELECT policyname, cmd, qual::text AS using_clause
FROM pg_policies
WHERE tablename = 'profiles'
ORDER BY policyname;
