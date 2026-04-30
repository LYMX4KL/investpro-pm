-- ============================================================
-- 999 — DROP EVERYTHING (DESTRUCTIVE — dev/staging only)
-- ============================================================
-- Run this to completely wipe the platform schema. Useful when you
-- need to re-apply migrations from scratch on a development database.
--
-- ⚠️ DOES NOT RUN ON PRODUCTION. Add a guard if you ever wire CI to it.

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS app_config           CASCADE;
DROP TABLE IF EXISTS inspection_items     CASCADE;
DROP TABLE IF EXISTS inspections          CASCADE;
DROP TABLE IF EXISTS reviews              CASCADE;
DROP TABLE IF EXISTS calendar_events      CASCADE;
DROP TABLE IF EXISTS leases               CASCADE;
DROP TABLE IF EXISTS term_sheets          CASCADE;
DROP TABLE IF EXISTS tasks                CASCADE;
DROP TABLE IF EXISTS communications       CASCADE;
DROP TABLE IF EXISTS screening_reports    CASCADE;
DROP TABLE IF EXISTS verifications        CASCADE;
DROP TABLE IF EXISTS application_references     CASCADE;
DROP TABLE IF EXISTS application_signatures     CASCADE;
DROP TABLE IF EXISTS application_vehicles       CASCADE;
DROP TABLE IF EXISTS application_pets           CASCADE;
DROP TABLE IF EXISTS application_co_applicants  CASCADE;
DROP TABLE IF EXISTS application_documents      CASCADE;
DROP TABLE IF EXISTS applications         CASCADE;
DROP TABLE IF EXISTS properties           CASCADE;
DROP TABLE IF EXISTS mls_listings         CASCADE;
DROP TABLE IF EXISTS agents               CASCADE;
DROP TABLE IF EXISTS email_templates      CASCADE;
DROP TABLE IF EXISTS profiles             CASCADE;

-- Drop functions
DROP FUNCTION IF EXISTS touch_updated_at()                CASCADE;
DROP FUNCTION IF EXISTS handle_new_auth_user()            CASCADE;
DROP FUNCTION IF EXISTS gen_agent_share_code()            CASCADE;
DROP FUNCTION IF EXISTS current_user_role()               CASCADE;
DROP FUNCTION IF EXISTS can_see_application(UUID)         CASCADE;
DROP FUNCTION IF EXISTS can_access_inspection(UUID)       CASCADE;
DROP FUNCTION IF EXISTS recount_inspection_damage()       CASCADE;

-- Drop enums (will fail silently if anything still references them — clean order matters)
DROP TYPE IF EXISTS user_role             CASCADE;
DROP TYPE IF EXISTS property_status       CASCADE;
DROP TYPE IF EXISTS application_status    CASCADE;
DROP TYPE IF EXISTS applicant_role        CASCADE;
DROP TYPE IF EXISTS residence_type        CASCADE;
DROP TYPE IF EXISTS verification_type     CASCADE;
DROP TYPE IF EXISTS verification_status   CASCADE;
DROP TYPE IF EXISTS comm_direction        CASCADE;
DROP TYPE IF EXISTS comm_channel          CASCADE;
DROP TYPE IF EXISTS call_outcome          CASCADE;
DROP TYPE IF EXISTS task_status           CASCADE;
DROP TYPE IF EXISTS task_type             CASCADE;
DROP TYPE IF EXISTS term_response         CASCADE;
DROP TYPE IF EXISTS broker_decision       CASCADE;
DROP TYPE IF EXISTS recommendation        CASCADE;
DROP TYPE IF EXISTS calendar_event_type   CASCADE;
DROP TYPE IF EXISTS document_type         CASCADE;
DROP TYPE IF EXISTS inspection_type       CASCADE;
DROP TYPE IF EXISTS inspection_status     CASCADE;
DROP TYPE IF EXISTS inspection_item_condition CASCADE;
