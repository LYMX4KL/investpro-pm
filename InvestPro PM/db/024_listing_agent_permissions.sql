-- ============================================================
-- 024 — Listing-agent permissions for inspections + invites
-- ============================================================
-- Lets listing agents (Helen, etc.) self-serve two things they used
-- to need staff for:
--   1. Schedule inspections on THEIR OWN listings — but only the
--      listing-stage types: pre_move_in_agent, rent_ready
--   2. Read all profiles in their role group (so they can use the
--      "Specific person" mode of inspection assignment to pick
--      a particular showing agent)
--
-- Notes:
--   - Inspections RLS already lets listing_agent perform inspections
--     assigned to them (via inspections_agent_self in db/021).
--   - This migration adds INSERT permission, scoped to their listings
--     and to listing-stage types only.
--   - User invitation enforcement is in the invite-user Netlify
--     function, not RLS — so no DB change needed for that.
--
-- Background: Kenny 2026-05-01 — Helen (listing agent) needs to
-- schedule pre-listing walkthroughs and onboard showing agents
-- without going through Mandy / Kenny / Omyko every time.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. INSERT policy for listing agents on inspections
-- ----------------------------------------------------------------
-- Allow row insert IF:
--   - caller's role is agent_listing
--   - inspection_type is one of the listing-stage types
--   - the property's listing_agent_id maps to this caller's profile
DROP POLICY IF EXISTS inspections_listing_agent_insert ON inspections;
CREATE POLICY inspections_listing_agent_insert ON inspections
  FOR INSERT TO authenticated
  WITH CHECK (
    current_user_role() = 'agent_listing'
    AND inspection_type IN ('pre_move_in_agent', 'rent_ready')
    AND property_id IN (
      SELECT p.id FROM properties p
      JOIN agents a ON a.id = p.listing_agent_id
      WHERE a.profile_id = auth.uid()
    )
  );

-- And UPDATE so they can edit/cancel their own scheduled inspections
DROP POLICY IF EXISTS inspections_listing_agent_update ON inspections;
CREATE POLICY inspections_listing_agent_update ON inspections
  FOR UPDATE TO authenticated
  USING (
    current_user_role() = 'agent_listing'
    AND assigned_by_id = auth.uid()
  )
  WITH CHECK (
    current_user_role() = 'agent_listing'
    AND assigned_by_id = auth.uid()
  );

-- And SELECT so they can see inspections they assigned
DROP POLICY IF EXISTS inspections_listing_agent_read_assigned ON inspections;
CREATE POLICY inspections_listing_agent_read_assigned ON inspections
  FOR SELECT TO authenticated
  USING (
    current_user_role() = 'agent_listing'
    AND (
      -- Inspections they themselves assigned
      assigned_by_id = auth.uid()
      -- OR inspections on their listings
      OR property_id IN (
        SELECT p.id FROM properties p
        JOIN agents a ON a.id = p.listing_agent_id
        WHERE a.profile_id = auth.uid()
      )
    )
  );


-- ----------------------------------------------------------------
-- 2. Allow listing agents to read profiles (so they can populate
--    the "Specific person" dropdown when assigning)
-- ----------------------------------------------------------------
-- Without this, agent_listing's PostgREST request to `profiles`
-- only returns their own row. We want them to see at least the
-- showing-agent roster.
DROP POLICY IF EXISTS profiles_listing_agent_read_showing ON profiles;
CREATE POLICY profiles_listing_agent_read_showing ON profiles
  FOR SELECT TO authenticated
  USING (
    role = 'agent_showing'
    AND EXISTS (
      SELECT 1 FROM profiles me
      WHERE me.id = auth.uid() AND me.role = 'agent_listing'
    )
  );


-- ----------------------------------------------------------------
-- 3. Verify
-- ----------------------------------------------------------------
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE tablename IN ('inspections', 'profiles')
  AND policyname LIKE '%listing_agent%' OR policyname LIKE '%listing%'
ORDER BY tablename, policyname;
