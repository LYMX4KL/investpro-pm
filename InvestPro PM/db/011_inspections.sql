-- ============================================================
-- 011 — Inspections (pre-move-in + tenant MICR + future annual / move-out)
-- ============================================================
-- Replaces paper inspection forms. Two flows go live in v1:
--   1) PRE_MOVE_IN by InvestPro staff (PM/Service or Admin) before keys release.
--      Documents condition with photos; tenant can compare against it.
--   2) MOVE_IN by tenant within 3 business days of key release.
--      Tenant uploads room-by-room photos and notes via the tenant portal.
--      If not returned by deadline, the platform marks the property as
--      "deemed perfect" for deposit purposes (per Master P&P Manual + Joan's
--      MICR rule).
--
-- Annual + move-out inspection types are in the enum so the same workflow
-- and UI can power them in Phase 6+.

-- ----------------------------------------------------------------
-- Enums for inspections
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE inspection_type AS ENUM (
    'pre_move_in',         -- PM/Service or Admin documents condition before key release
    'move_in_tenant',      -- Tenant returns MICR within 3 biz days of key release
    'annual',              -- Annual inspection by PM/Service (Phase 6+)
    'move_out_tenant',     -- Tenant's exit walkthrough notes (Phase 6+)
    'move_out_pm'          -- PM/Service's exit inspection (drives deposit disposition; Phase 6+)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE inspection_status AS ENUM (
    'scheduled',           -- created, not yet performed
    'in_progress',         -- inspector started capturing items
    'submitted',           -- inspector clicked Submit
    'overdue',             -- past deadline (auto-set by reminder cron)
    'deemed_perfect',      -- MICR not returned by tenant in 3 biz days → property assumed move-in ready
    'reviewed'             -- staff reviewed/accepted the submitted inspection
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE inspection_item_condition AS ENUM (
    'good',                -- no issues
    'fair',                -- cosmetic wear, acceptable
    'damaged',             -- needs repair / cleaning
    'missing',             -- item not present
    'na'                   -- not applicable to this property
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- inspections — one row per inspection event
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspections (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Relationships
  property_id                 UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lease_id                    UUID REFERENCES leases(id) ON DELETE SET NULL,
  application_id              UUID REFERENCES applications(id) ON DELETE SET NULL,
  -- Type + status
  inspection_type             inspection_type NOT NULL,
  status                      inspection_status NOT NULL DEFAULT 'scheduled',
  -- Who's performing it
  inspector_profile_id        UUID REFERENCES profiles(id),     -- PM/Service for pre_move_in / annual / move_out_pm
                                                                -- Tenant for move_in_tenant / move_out_tenant
  inspector_role              user_role,                        -- snapshot of role at inspection time
  -- Scheduling
  scheduled_for               TIMESTAMPTZ,                      -- when inspector intends to do it
  deadline_at                 TIMESTAMPTZ,                      -- for tenant MICR: 3 biz days after key release
  started_at                  TIMESTAMPTZ,
  submitted_at                TIMESTAMPTZ,
  reviewed_at                 TIMESTAMPTZ,
  reviewed_by                 UUID REFERENCES profiles(id),
  -- Reminder mechanics
  reminder_24h_sent_at        TIMESTAMPTZ,                      -- 24-hour-before-deadline reminder
  reminder_at_deadline_sent_at TIMESTAMPTZ,                     -- "Today is your deadline" reminder
  reminder_overdue_sent_at    TIMESTAMPTZ,                      -- post-deadline staff alert
  -- Summary
  overall_notes               TEXT,                             -- inspector's free-text summary
  damage_count                INT NOT NULL DEFAULT 0,           -- denormalized for queries; rebuilt by trigger
  repair_estimate_total       NUMERIC(10,2),                    -- staff fills in after review (move-out only)
  -- Output
  pdf_storage_path            TEXT,                             -- generated PDF of the inspection (bucket: signed-documents)
  -- Audit
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inspections_property ON inspections(property_id);
CREATE INDEX IF NOT EXISTS idx_inspections_lease ON inspections(lease_id);
CREATE INDEX IF NOT EXISTS idx_inspections_inspector ON inspections(inspector_profile_id);
CREATE INDEX IF NOT EXISTS idx_inspections_type_status ON inspections(inspection_type, status);
-- Index for the reminder cron: find inspections approaching/past deadline that haven't been reminded yet
CREATE INDEX IF NOT EXISTS idx_inspections_deadline_pending ON inspections(deadline_at)
  WHERE status IN ('scheduled', 'in_progress') AND deadline_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_inspections_touch_updated ON inspections;
CREATE TRIGGER trg_inspections_touch_updated
  BEFORE UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- inspection_items — line items per inspection (room/area + condition)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspection_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id       UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  -- Hierarchy: room → item
  area                TEXT NOT NULL,                          -- 'Living Room' | 'Kitchen' | 'Master Bedroom' | 'Exterior' | etc.
  item                TEXT NOT NULL,                          -- 'Carpet' | 'Oven' | 'Walls' | 'Smoke detector' | etc.
  -- Assessment
  condition           inspection_item_condition NOT NULL DEFAULT 'good',
  notes               TEXT,
  -- Photos: array of storage paths (bucket: signed-documents/inspections/<inspection_id>/<item_id>/<filename>)
  photo_paths         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Display order (for stable UI rendering)
  sort_order          INT NOT NULL DEFAULT 0,
  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_inspection ON inspection_items(inspection_id);
CREATE INDEX IF NOT EXISTS idx_items_condition ON inspection_items(condition) WHERE condition IN ('damaged', 'missing');

DROP TRIGGER IF EXISTS trg_items_touch_updated ON inspection_items;
CREATE TRIGGER trg_items_touch_updated
  BEFORE UPDATE ON inspection_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- Trigger: keep inspections.damage_count in sync with inspection_items
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION recount_inspection_damage()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  insp_id UUID;
BEGIN
  insp_id := COALESCE(NEW.inspection_id, OLD.inspection_id);
  UPDATE inspections SET damage_count = (
    SELECT COUNT(*) FROM inspection_items
    WHERE inspection_id = insp_id AND condition IN ('damaged', 'missing')
  )
  WHERE id = insp_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_items_recount ON inspection_items;
CREATE TRIGGER trg_items_recount
  AFTER INSERT OR UPDATE OR DELETE ON inspection_items
  FOR EACH ROW EXECUTE FUNCTION recount_inspection_damage();

-- ----------------------------------------------------------------
-- RLS — staff full; tenant sees own MICR; PM/Service handles PM inspections
-- ----------------------------------------------------------------
ALTER TABLE inspections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_items ENABLE ROW LEVEL SECURITY;

-- Staff can do everything
DROP POLICY IF EXISTS inspections_staff ON inspections;
CREATE POLICY inspections_staff ON inspections
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'va', 'compliance', 'leasing', 'pm_service', 'admin_onsite'))
  WITH CHECK (current_user_role() IN ('broker', 'va', 'compliance', 'leasing', 'pm_service', 'admin_onsite'));

-- Tenant: can read + write their own MICR (move_in_tenant + move_out_tenant)
DROP POLICY IF EXISTS inspections_tenant_self ON inspections;
CREATE POLICY inspections_tenant_self ON inspections
  FOR ALL TO authenticated
  USING (
    inspection_type IN ('move_in_tenant', 'move_out_tenant')
    AND inspector_profile_id = auth.uid()
  )
  WITH CHECK (
    inspection_type IN ('move_in_tenant', 'move_out_tenant')
    AND inspector_profile_id = auth.uid()
  );

-- Tenant: can READ pre-move-in inspections for their lease (they need to compare against it)
DROP POLICY IF EXISTS inspections_tenant_read_premovein ON inspections;
CREATE POLICY inspections_tenant_read_premovein ON inspections
  FOR SELECT TO authenticated
  USING (
    inspection_type = 'pre_move_in'
    AND lease_id IN (
      SELECT id FROM leases
      WHERE tenant_profile_ids @> to_jsonb(auth.uid()::text)
    )
  );

-- Owner: can read inspections on their own properties
DROP POLICY IF EXISTS inspections_owner_read ON inspections;
CREATE POLICY inspections_owner_read ON inspections
  FOR SELECT TO authenticated
  USING (
    property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
  );

-- Inspection items inherit from parent inspection
CREATE OR REPLACE FUNCTION can_access_inspection(p_inspection_id UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM inspections i
    WHERE i.id = p_inspection_id
      AND (
        current_user_role() IN ('broker', 'va', 'compliance', 'leasing', 'pm_service', 'admin_onsite')
        OR (i.inspector_profile_id = auth.uid()
            AND i.inspection_type IN ('move_in_tenant', 'move_out_tenant'))
        OR (i.inspection_type = 'pre_move_in'
            AND i.lease_id IN (
              SELECT id FROM leases
              WHERE tenant_profile_ids @> to_jsonb(auth.uid()::text)
            ))
        OR i.property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
      )
  )
$$;

DROP POLICY IF EXISTS items_inherit ON inspection_items;
CREATE POLICY items_inherit ON inspection_items
  FOR ALL TO authenticated
  USING (can_access_inspection(inspection_id))
  WITH CHECK (can_access_inspection(inspection_id));

-- ----------------------------------------------------------------
-- Seed: standard inspection checklist used to pre-populate items
-- when a new inspection is created for a property.
--
-- Stored as a JSONB blob in a config row so Broker can edit it later
-- via /portal/broker/templates without a schema change.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_config (
  key             TEXT PRIMARY KEY,
  value           JSONB NOT NULL,
  description     TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES profiles(id)
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_read ON app_config;
CREATE POLICY config_read ON app_config
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS config_broker_write ON app_config;
CREATE POLICY config_broker_write ON app_config
  FOR ALL TO authenticated
  USING (current_user_role() = 'broker')
  WITH CHECK (current_user_role() = 'broker');

-- Default checklist (covers a typical Las Vegas SFH/condo).
-- For special properties (pool, garage, etc.) the inspector adds extra items as needed.
-- ----------------------------------------------------------------
-- Late FK from leases.pre_move_in_inspection_id → inspections.id
-- (couldn't add in 006 since inspections didn't exist yet)
-- ----------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE leases
    ADD CONSTRAINT leases_pre_move_in_inspection_fk
    FOREIGN KEY (pre_move_in_inspection_id) REFERENCES inspections(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO app_config (key, value, description) VALUES
('inspection_default_checklist',
$$[
  {"area": "Exterior", "items": ["Front door & locks", "Mailbox", "Landscaping front", "Landscaping back", "Fence/gate", "Driveway", "Hose bibs", "Exterior paint", "Roof visible damage"]},
  {"area": "Living Room", "items": ["Walls/paint", "Flooring", "Ceiling", "Windows & screens", "Window coverings", "Light fixtures", "Outlets/switches", "Smoke detector", "CO detector"]},
  {"area": "Kitchen", "items": ["Cabinets", "Countertops", "Sink & faucet", "Garbage disposal", "Refrigerator", "Stove/oven", "Microwave", "Dishwasher", "Range hood", "Floors", "Walls/paint", "Outlets/GFCI"]},
  {"area": "Dining Area", "items": ["Walls/paint", "Flooring", "Light fixture", "Windows"]},
  {"area": "Master Bedroom", "items": ["Walls/paint", "Flooring", "Closet", "Windows & screens", "Window coverings", "Light fixtures", "Outlets/switches", "Smoke detector", "Ceiling fan"]},
  {"area": "Master Bathroom", "items": ["Vanity & sink", "Toilet", "Tub/shower", "Caulking/grout", "Mirror", "Towel bars", "Floors", "Walls", "Exhaust fan", "GFCI outlet"]},
  {"area": "Bedroom 2", "items": ["Walls/paint", "Flooring", "Closet", "Windows", "Light fixtures", "Outlets", "Smoke detector"]},
  {"area": "Bathroom 2", "items": ["Vanity & sink", "Toilet", "Tub/shower", "Floors", "Walls", "Exhaust fan"]},
  {"area": "Hallway/Stairs", "items": ["Walls", "Flooring", "Light fixtures", "Smoke detectors"]},
  {"area": "Laundry", "items": ["Washer hookups", "Dryer hookups & vent", "Floors", "Outlets"]},
  {"area": "Garage", "items": ["Garage door + opener", "Walls", "Floor", "Lighting", "Outlets"]},
  {"area": "HVAC", "items": ["Thermostat", "Air filter", "Visible ductwork", "Vents condition"]},
  {"area": "Plumbing", "items": ["Water heater age/condition", "Visible leaks", "Water shutoff location"]},
  {"area": "Electrical", "items": ["Breaker panel labeled", "GFCI test (kitchen + baths)"]},
  {"area": "Pool/Spa (if applicable)", "items": ["Pool surface", "Equipment", "Fencing/gate", "Pool addendum signed"]}
]$$::jsonb,
'Default inspection checklist used to pre-populate inspection_items rows. Editable by Broker.')
ON CONFLICT (key) DO NOTHING;
