-- ============================================================
-- 021 — Inspections: extended types, assignment workflow, per-type templates
-- ============================================================
-- Extends db/011_inspections.sql to support Kenny's full vision:
--   * Two new types: pre_move_in_agent (listing agent's initial walkthrough),
--     rent_ready (listing agent or service team verifies property is ready)
--   * Hybrid claim model: assignments can target a specific person OR a
--     role-group (any of those roles can claim it, like a job board)
--   * Office-manager assignment: broker, compliance, admin_onsite can create
--     inspection assignments
--   * Per-type checklist templates seeded into app_config
--
-- Background: Kenny 2026-05-01 — wants full inspections workflow for soft launch.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Add new inspection types to the enum
-- ----------------------------------------------------------------
DO $$ BEGIN
  ALTER TYPE inspection_type ADD VALUE IF NOT EXISTS 'pre_move_in_agent';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE inspection_type ADD VALUE IF NOT EXISTS 'rent_ready';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ----------------------------------------------------------------
-- 2. Assignment metadata columns
-- ----------------------------------------------------------------
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS title              TEXT,
  ADD COLUMN IF NOT EXISTS assigned_by_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_to_roles  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS claimed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assignment_notes   TEXT;

COMMENT ON COLUMN inspections.assigned_to_roles IS
  'When inspector_profile_id IS NULL, this lists role keys (e.g. {leasing,pm_service}) that may claim the inspection. When inspector_profile_id IS NOT NULL, the inspection is locked to that person.';

CREATE INDEX IF NOT EXISTS idx_inspections_unclaimed
  ON inspections(status)
  WHERE inspector_profile_id IS NULL AND status = 'scheduled';


-- ----------------------------------------------------------------
-- 3. RLS — extend so agents and tenants can perform their assignments
-- ----------------------------------------------------------------
-- Agents can read/write inspections assigned to them (specifically OR via role group)
DROP POLICY IF EXISTS inspections_agent_self ON inspections;
CREATE POLICY inspections_agent_self ON inspections
  FOR ALL TO authenticated
  USING (
    -- Specifically assigned to this user
    inspector_profile_id = auth.uid()
    -- OR open to their role group
    OR (
      inspector_profile_id IS NULL
      AND current_user_role()::text = ANY(assigned_to_roles)
    )
  )
  WITH CHECK (
    inspector_profile_id = auth.uid()
    OR (
      inspector_profile_id IS NULL
      AND current_user_role()::text = ANY(assigned_to_roles)
    )
  );


-- Helper function used by perform.html to atomically claim an open inspection
CREATE OR REPLACE FUNCTION claim_inspection(p_inspection_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  current_role user_role;
  current_uid  UUID;
BEGIN
  current_uid := auth.uid();
  IF current_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT role INTO current_role FROM profiles WHERE id = current_uid;

  UPDATE inspections SET
    inspector_profile_id = current_uid,
    inspector_role = current_role,
    claimed_at = NOW(),
    status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END,
    started_at = COALESCE(started_at, NOW())
  WHERE id = p_inspection_id
    AND inspector_profile_id IS NULL
    AND current_role::text = ANY(assigned_to_roles);

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_inspection(UUID) TO authenticated;


-- ----------------------------------------------------------------
-- 4. Per-type templates seeded into app_config
-- ----------------------------------------------------------------
-- Pre-move-in (PM/Service): full checklist (already in inspection_default_checklist).
-- Below: separate templates for the new types and a few existing ones.

-- pre_move_in_agent: listing agent's initial walkthrough (~12 items)
INSERT INTO app_config (key, value, description) VALUES
('inspection_template_pre_move_in_agent',
$$[
  {"area": "Curb Appeal", "items": ["Front yard / landscaping", "Front door & paint", "Mailbox", "Driveway condition", "Listing photos opportunities"]},
  {"area": "Interior General", "items": ["Overall cleanliness", "Paint condition", "Flooring condition", "Smell / odors"]},
  {"area": "Kitchen", "items": ["Appliance condition", "Cabinet condition", "Countertop condition"]},
  {"area": "Bathrooms", "items": ["Caulking & grout", "Visible leaks", "Vanity & mirror"]},
  {"area": "Repairs Needed Before Listing", "items": ["List anything needing repair, paint, or replacement"]}
]$$::jsonb,
'Listing agent walkthrough before property goes on market. Identifies what needs fixing before listing.')
ON CONFLICT (key) DO NOTHING;

-- rent_ready: final check before tenant takes possession (~15 items)
INSERT INTO app_config (key, value, description) VALUES
('inspection_template_rent_ready',
$$[
  {"area": "Cleaning", "items": ["Deep clean completed (interior)", "Carpets cleaned/replaced", "Windows clean inside", "Appliances cleaned"]},
  {"area": "Safety", "items": ["Smoke detectors tested + batteries", "CO detector tested + batteries", "Fire extinguisher present", "GFCI outlets tested"]},
  {"area": "Systems", "items": ["HVAC working + filter changed", "Water heater on + working", "All plumbing fixtures working", "All lights working"]},
  {"area": "Security", "items": ["Locks rekeyed", "Garage opener codes reset", "All keys present + labeled"]},
  {"area": "Property", "items": ["No trash / debris", "Yard / landscaping ready", "Pool/spa ready (if applicable)"]}
]$$::jsonb,
'Final pre-tenant verification by listing agent or service team. Property must be 100% ready before keys release.')
ON CONFLICT (key) DO NOTHING;

-- annual: yearly check (~25 items, safety + systems focus)
INSERT INTO app_config (key, value, description) VALUES
('inspection_template_annual',
$$[
  {"area": "Safety", "items": ["Smoke detectors tested", "CO detectors tested", "Fire extinguisher (date)", "GFCI outlets tested", "Emergency exits clear"]},
  {"area": "HVAC", "items": ["Filter changed in last 90 days", "System running + cooling/heating", "Thermostat working", "Vents clean"]},
  {"area": "Plumbing", "items": ["Water heater age/condition", "Visible leaks anywhere", "Toilet seals intact", "Garbage disposal working", "Water shutoff accessible"]},
  {"area": "Electrical", "items": ["Breaker panel labeled + accessible", "All outlets working", "All lights working"]},
  {"area": "Pest Control", "items": ["No signs of rodents", "No signs of insects", "Exterior entry points sealed"]},
  {"area": "Tenant Compliance", "items": ["Authorized occupants only", "Pet matches lease (count + type)", "No smoking damage", "Property maintained per lease"]},
  {"area": "Exterior", "items": ["Roof visible damage", "Gutters clean", "Fence/gate condition", "Pool/spa equipment (if applicable)"]}
]$$::jsonb,
'Annual property inspection by PM/Service. Focuses on safety, systems, and tenant compliance.')
ON CONFLICT (key) DO NOTHING;

-- move_out_pm: PM's exit inspection used to determine deposit disposition
INSERT INTO app_config (key, value, description) VALUES
('inspection_template_move_out_pm',
$$[
  {"area": "Damage Beyond Normal Wear", "items": ["List each damage item with location, description, and estimated repair cost"]},
  {"area": "Cleaning Required", "items": ["Carpet cleaning needed", "Deep clean needed (interior)", "Yard cleanup needed", "Trash / belongings left behind"]},
  {"area": "Missing Items", "items": ["Keys all returned", "Garage openers returned", "Appliances present", "Window coverings present", "Anything else missing"]},
  {"area": "Comparison to Move-In", "items": ["Compare each room to pre-move-in inspection. Note conditions that have changed beyond normal wear."]},
  {"area": "Final Assessment", "items": ["Total estimated repair/cleaning cost", "Recommended deposit disposition (full refund / partial / forfeit)"]}
]$$::jsonb,
'PM/Service exit inspection. Drives deposit return calculation. Compare against pre_move_in inspection.')
ON CONFLICT (key) DO NOTHING;


-- ----------------------------------------------------------------
-- 5. Storage bucket for inspection photos
-- ----------------------------------------------------------------
-- Reuses signed-documents bucket (already created in db/008_storage.sql).
-- Photos are stored under: signed-documents/inspections/<inspection_id>/<item_id>/<filename>


-- ----------------------------------------------------------------
-- 6. Verify
-- ----------------------------------------------------------------
SELECT enumlabel FROM pg_enum WHERE enumtypid = 'inspection_type'::regtype ORDER BY enumsortorder;

SELECT key FROM app_config WHERE key LIKE 'inspection_template_%' ORDER BY key;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'inspections' AND column_name IN ('title','assigned_by_id','assigned_at','assigned_to_roles','claimed_at','assignment_notes')
ORDER BY column_name;
