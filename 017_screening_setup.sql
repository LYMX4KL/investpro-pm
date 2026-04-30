-- ============================================================
-- 017 — Screening integration setup (PetScreening.com + TU SmartMove)
-- ============================================================
-- Lets the broker store vendor URLs/account info and lets the VA capture
-- screening results manually until we wire the real API integrations later.
--
-- The schema already has:
--   * verifications table — with external_provider, external_request_id,
--     result_payload (JSONB), result_storage_path, ai_parsed_summary
--   * screening_reports — with credit_score, credit_provider, derogatory_summary,
--     background_summary, pet_screening_summary, recommendation
--
-- This migration adds:
--   1. A vendor_settings key/value table for the PM URLs and account emails
--   2. Per-pet PetScreening tracking columns on application_pets
--
-- Background: Kenny's directive 2026-04-30 — connect PetScreening.com and
-- TransUnion SmartMove to the platform. Manual entry today; API integration later.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. vendor_settings table — key/value config
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID REFERENCES profiles(id)
);

COMMENT ON TABLE vendor_settings IS
  'Key/value config for third-party vendors (PetScreening, TU SmartMove, etc). Broker + compliance manage; anyone with PII access can read.';

-- Seed the keys we need. Broker fills in the values via the Vendor Settings page.
INSERT INTO vendor_settings (key, description) VALUES
  ('petscreening_pm_url',
   'Your unique PetScreening Property Manager profile URL (e.g. petscreening.com/InvestProRealty). Shared with applicants who have pets.'),
  ('petscreening_account_email',
   'The email you use to log into PetScreening. For VA reference when retrieving results.'),
  ('smartmove_landlord_url',
   'Your TransUnion SmartMove landlord portal URL (typically https://smartmove.transunion.com).'),
  ('smartmove_account_email',
   'The email you use to log into TransUnion SmartMove. For VA reference when retrieving results.')
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS trg_vendor_settings_touch_updated ON vendor_settings;
CREATE TRIGGER trg_vendor_settings_touch_updated
  BEFORE UPDATE ON vendor_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 2. RLS for vendor_settings
-- ----------------------------------------------------------------
ALTER TABLE vendor_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_settings_read ON vendor_settings;
CREATE POLICY vendor_settings_read ON vendor_settings
  FOR SELECT TO authenticated
  USING (current_user_has_pii_access());

DROP POLICY IF EXISTS vendor_settings_write ON vendor_settings;
CREATE POLICY vendor_settings_write ON vendor_settings
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'compliance'))
  WITH CHECK (current_user_role() IN ('broker', 'compliance'));


-- ----------------------------------------------------------------
-- 3. application_pets — add PetScreening tracking columns
-- ----------------------------------------------------------------
ALTER TABLE application_pets
  ADD COLUMN IF NOT EXISTS pet_screening_url          TEXT,
  ADD COLUMN IF NOT EXISTS pet_screening_profile_id   TEXT,
  ADD COLUMN IF NOT EXISTS pet_screening_fido_score   INT,
  ADD COLUMN IF NOT EXISTS pet_screening_status       TEXT NOT NULL DEFAULT 'not_sent',
  ADD COLUMN IF NOT EXISTS pet_screening_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pet_screening_notes        TEXT;

COMMENT ON COLUMN application_pets.pet_screening_fido_score IS
  'PetScreening FIDO score: 1 = Highest Risk, 5 = Lowest Risk. ESA / service animals are typically exempt.';

COMMENT ON COLUMN application_pets.pet_screening_status IS
  'not_sent | invited | in_progress | complete | n_a (service animal / ESA exempt)';

CREATE INDEX IF NOT EXISTS idx_pets_screening_status
  ON application_pets(pet_screening_status);


-- ----------------------------------------------------------------
-- 4. VERIFY
-- ----------------------------------------------------------------
SELECT key, value, description FROM vendor_settings ORDER BY key;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'application_pets'
  AND column_name LIKE 'pet_screening%'
ORDER BY column_name;
