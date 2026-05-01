-- ============================================================
-- 019 — Allow leasing + admin_onsite to manage properties
-- ============================================================
-- Original RLS in 009_rls_policies.sql let only the broker INSERT/UPDATE/DELETE
-- properties. In practice, the leasing coordinator (Helen) and the front-desk
-- admin (Omyko) also add/edit listings as part of their job. This migration
-- extends the policy so all three roles can manage properties.
--
-- Read access (broker/va/accounting/compliance/leasing/pm_service/admin_onsite)
-- and owner/agent self-read policies stay unchanged.
--
-- Background: Helen (leasing) reported 2026-04-30 that "Save Property" did
-- nothing — it was an INSERT permission denial silently swallowed by the
-- frontend. Diagnosis covered both a JS bug and this RLS gap.
-- ============================================================

DROP POLICY IF EXISTS properties_broker_full ON properties;
DROP POLICY IF EXISTS properties_management_roles_full ON properties;

-- New combined policy: broker, leasing, admin_onsite can do anything on properties
CREATE POLICY properties_management_roles_full ON properties
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'leasing', 'admin_onsite'))
  WITH CHECK (current_user_role() IN ('broker', 'leasing', 'admin_onsite'));


-- ----------------------------------------------------------------
-- VERIFY
-- ----------------------------------------------------------------
SELECT policyname, cmd, qual::text AS using_clause
FROM pg_policies
WHERE tablename = 'properties'
ORDER BY policyname;
