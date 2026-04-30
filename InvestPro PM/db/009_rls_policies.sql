-- ============================================================
-- 009 — Row Level Security policies
-- ============================================================
-- Enable RLS on every table and define who-can-see-what policies.
-- Reflects the permission matrix in PM-PLATFORM-PLAN §2.
--
-- Helper: SECURITY DEFINER function to read current user's role.
-- Avoids inlining a subquery in every policy.

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS user_role LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$;

-- ----------------------------------------------------------------
-- Enable RLS on every table
-- ----------------------------------------------------------------
ALTER TABLE profiles                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mls_listings                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_co_applicants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_pets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_vehicles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_signatures        ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_references        ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE screening_reports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications                ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE term_sheets                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE leases                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates               ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------
-- profiles policies
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS profiles_self_read ON profiles;
CREATE POLICY profiles_self_read ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing', 'admin_onsite'));

DROP POLICY IF EXISTS profiles_self_update ON profiles;
CREATE POLICY profiles_self_update ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ----------------------------------------------------------------
-- agents — agents read own, staff read all, broker writes (approves)
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS agents_self_read ON agents;
CREATE POLICY agents_self_read ON agents
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing', 'admin_onsite')
  );

DROP POLICY IF EXISTS agents_self_register ON agents;
CREATE POLICY agents_self_register ON agents
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS agents_self_update_limited ON agents;
CREATE POLICY agents_self_update_limited ON agents
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS agents_broker_full ON agents;
CREATE POLICY agents_broker_full ON agents
  FOR ALL TO authenticated
  USING (current_user_role() = 'broker')
  WITH CHECK (current_user_role() = 'broker');

-- ----------------------------------------------------------------
-- properties — staff full read; owner reads own; agent reads listing
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS properties_staff_read ON properties;
CREATE POLICY properties_staff_read ON properties
  FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing', 'pm_service', 'admin_onsite')
  );

DROP POLICY IF EXISTS properties_owner_read_own ON properties;
CREATE POLICY properties_owner_read_own ON properties
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS properties_agent_read_listing ON properties;
CREATE POLICY properties_agent_read_listing ON properties
  FOR SELECT TO authenticated
  USING (
    listing_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid())
  );

DROP POLICY IF EXISTS properties_broker_full ON properties;
CREATE POLICY properties_broker_full ON properties
  FOR ALL TO authenticated
  USING (current_user_role() = 'broker')
  WITH CHECK (current_user_role() = 'broker');

-- mls_listings — read-only by all authenticated staff + agents
DROP POLICY IF EXISTS mls_listings_read ON mls_listings;
CREATE POLICY mls_listings_read ON mls_listings
  FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('broker', 'va', 'leasing', 'admin_onsite', 'agent_listing', 'agent_showing')
  );

-- ----------------------------------------------------------------
-- applications — most complex policies
-- ----------------------------------------------------------------
-- Applicant reads their own application
DROP POLICY IF EXISTS apps_applicant_self ON applications;
CREATE POLICY apps_applicant_self ON applications
  FOR SELECT TO authenticated
  USING (applicant_profile_id = auth.uid() OR email = (SELECT email FROM profiles WHERE id = auth.uid()));

-- Applicant inserts (creates) their own application
DROP POLICY IF EXISTS apps_applicant_insert ON applications;
CREATE POLICY apps_applicant_insert ON applications
  FOR INSERT TO authenticated
  WITH CHECK (
    applicant_profile_id = auth.uid()
    OR applicant_profile_id IS NULL  -- allow anonymous-style inserts during early sign-up flow
  );

-- Internal staff can read all applications
DROP POLICY IF EXISTS apps_staff_read ON applications;
CREATE POLICY apps_staff_read ON applications
  FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing', 'admin_onsite')
  );

-- VA + Broker + Leasing can update applications
DROP POLICY IF EXISTS apps_workflow_update ON applications;
CREATE POLICY apps_workflow_update ON applications
  FOR UPDATE TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing'));

-- Agents can read applications they're attached to (showing or listing)
DROP POLICY IF EXISTS apps_agent_read ON applications;
CREATE POLICY apps_agent_read ON applications
  FOR SELECT TO authenticated
  USING (
    showing_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid())
    OR listing_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid())
  );

-- ----------------------------------------------------------------
-- application sub-tables — inherit access from parent application
-- ----------------------------------------------------------------
-- Helper: can current user see this application?
CREATE OR REPLACE FUNCTION can_see_application(p_application_id UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM applications a
    WHERE a.id = p_application_id
      AND (
        a.applicant_profile_id = auth.uid()
        OR a.email = (SELECT email FROM profiles WHERE id = auth.uid())
        OR current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing', 'admin_onsite')
        OR a.showing_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid())
        OR a.listing_agent_id IN (SELECT id FROM agents WHERE profile_id = auth.uid())
      )
  )
$$;

-- Apply to all app sub-tables
DROP POLICY IF EXISTS appdocs_inherit ON application_documents;
CREATE POLICY appdocs_inherit ON application_documents
  FOR ALL TO authenticated USING (can_see_application(application_id));

DROP POLICY IF EXISTS coapps_inherit ON application_co_applicants;
CREATE POLICY coapps_inherit ON application_co_applicants
  FOR ALL TO authenticated USING (can_see_application(application_id));

DROP POLICY IF EXISTS pets_inherit ON application_pets;
CREATE POLICY pets_inherit ON application_pets
  FOR ALL TO authenticated USING (can_see_application(application_id));

DROP POLICY IF EXISTS vehicles_inherit ON application_vehicles;
CREATE POLICY vehicles_inherit ON application_vehicles
  FOR ALL TO authenticated USING (can_see_application(application_id));

DROP POLICY IF EXISTS sigs_inherit ON application_signatures;
CREATE POLICY sigs_inherit ON application_signatures
  FOR ALL TO authenticated USING (can_see_application(application_id));

DROP POLICY IF EXISTS refs_inherit ON application_references;
CREATE POLICY refs_inherit ON application_references
  FOR ALL TO authenticated USING (can_see_application(application_id));

-- ----------------------------------------------------------------
-- verifications + screening_reports — internal staff only (PII-heavy)
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS verifications_staff_only ON verifications;
CREATE POLICY verifications_staff_only ON verifications
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'compliance', 'leasing'))
  WITH CHECK (current_user_role() IN ('broker', 'va', 'compliance', 'leasing'));

DROP POLICY IF EXISTS screening_staff_only ON screening_reports;
CREATE POLICY screening_staff_only ON screening_reports
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'compliance'))
  WITH CHECK (current_user_role() IN ('broker', 'va'));

-- Owner sees ONLY recommendation field (via a view, defined separately) — never raw screening data

-- ----------------------------------------------------------------
-- communications — staff full; applicants/tenants/owners see relevant ones
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS comms_staff_full ON communications;
CREATE POLICY comms_staff_full ON communications
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing'))
  WITH CHECK (current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing'));

-- Applicant/tenant sees comms tied to their application
DROP POLICY IF EXISTS comms_applicant_read ON communications;
CREATE POLICY comms_applicant_read ON communications
  FOR SELECT TO authenticated
  USING (
    application_id IS NOT NULL
    AND can_see_application(application_id)
    AND current_user_role() IN ('applicant', 'tenant', 'agent_listing', 'agent_showing')
  );

-- ----------------------------------------------------------------
-- tasks — VA / Broker / Leasing
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS tasks_staff ON tasks;
CREATE POLICY tasks_staff ON tasks
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'leasing', 'compliance'))
  WITH CHECK (current_user_role() IN ('broker', 'va', 'leasing', 'compliance'));

-- ----------------------------------------------------------------
-- term_sheets, leases, calendar_events, reviews
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS terms_staff ON term_sheets;
CREATE POLICY terms_staff ON term_sheets
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'leasing'))
  WITH CHECK (current_user_role() IN ('broker', 'va', 'leasing'));

DROP POLICY IF EXISTS terms_applicant_read ON term_sheets;
CREATE POLICY terms_applicant_read ON term_sheets
  FOR SELECT TO authenticated
  USING (can_see_application(application_id));

DROP POLICY IF EXISTS leases_staff ON leases;
CREATE POLICY leases_staff ON leases
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'leasing', 'compliance', 'accounting'))
  WITH CHECK (current_user_role() IN ('broker', 'leasing', 'compliance'));

DROP POLICY IF EXISTS leases_tenant_read ON leases;
CREATE POLICY leases_tenant_read ON leases
  FOR SELECT TO authenticated
  USING (tenant_profile_ids @> to_jsonb(auth.uid()::text));

DROP POLICY IF EXISTS leases_owner_read ON leases;
CREATE POLICY leases_owner_read ON leases
  FOR SELECT TO authenticated
  USING (
    property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS cal_staff ON calendar_events;
CREATE POLICY cal_staff ON calendar_events
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'leasing', 'admin_onsite'))
  WITH CHECK (current_user_role() IN ('broker', 'va', 'leasing'));

DROP POLICY IF EXISTS cal_applicant_read ON calendar_events;
CREATE POLICY cal_applicant_read ON calendar_events
  FOR SELECT TO authenticated
  USING (application_id IS NOT NULL AND can_see_application(application_id));

DROP POLICY IF EXISTS reviews_staff ON reviews;
CREATE POLICY reviews_staff ON reviews
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'leasing'))
  WITH CHECK (current_user_role() IN ('broker', 'va', 'leasing'));

-- ----------------------------------------------------------------
-- email_templates — broker writes, all staff read
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS templates_staff_read ON email_templates;
CREATE POLICY templates_staff_read ON email_templates
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'accounting', 'compliance', 'leasing'));

DROP POLICY IF EXISTS templates_broker_write ON email_templates;
CREATE POLICY templates_broker_write ON email_templates
  FOR ALL TO authenticated
  USING (current_user_role() = 'broker')
  WITH CHECK (current_user_role() = 'broker');
