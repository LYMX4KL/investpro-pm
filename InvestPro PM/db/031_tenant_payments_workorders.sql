-- ============================================================
-- 031 — Tenant payments (rent ledger) + work orders (maintenance)
-- ============================================================
-- Two foundational tables for the tenant portal:
--
-- 1. payments — every charge or credit that hits a lease's
--    ledger: rent, late fees, pet rent, utility allocations,
--    refunds, security-deposit holds, etc. Tenants see their
--    own; owners see payments for their properties; managers
--    see all.
--
-- 2. work_orders — maintenance requests, from initial tenant
--    submission through vendor dispatch, owner approval (when
--    estimate exceeds threshold), completion, and audit.
--    Replaces the placeholder "coming soon" sections in
--    portal/tenant-dashboard.html.
--
-- Background: Kenny 2026-05-04 — building tenant portal real
-- features now that the LYMX rebrand and site launch are done.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. PAYMENTS — the rent ledger
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE payment_type AS ENUM (
    'rent',                    -- monthly rent
    'late_fee',                -- 5% of monthly rent (NV statutory cap)
    'pet_rent',                -- monthly pet rent if applicable
    'pet_fee',                 -- one-time pet fee
    'utility_allocation',      -- water/sewer/trash if billed back (rare under new NV law)
    'tenant_caused_repair',    -- repair the tenant pays for (with markup)
    'security_deposit_hold',   -- initial deposit (in trust, not revenue)
    'security_deposit_refund', -- partial / full refund at move-out
    'application_fee',         -- $75 / $50 — applied at app time but visible here too
    'lease_processing_fee',    -- $100
    'nsf_fee',                 -- bounced payment
    'lease_break_fee',         -- early termination
    'move_out_admin_fee',      -- per-lease basis
    'credit',                  -- manual credit
    'adjustment'               -- manual adjustment (reason in description)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM (
    'scheduled',  -- recurring future charge (e.g., rent for next month)
    'due',        -- on/after due date, not yet paid
    'pending',    -- payment initiated (ACH float etc.)
    'paid',       -- successfully cleared
    'failed',     -- bounced / declined
    'refunded',   -- refunded back to tenant
    'voided',     -- cancelled before settlement
    'waived'      -- manually waived (e.g., late fee waiver)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id             UUID REFERENCES leases(id) ON DELETE CASCADE,
  property_id          UUID REFERENCES properties(id) ON DELETE SET NULL,
  -- Who paid (or who the charge is against)
  tenant_profile_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Amount: positive = charge against tenant, negative = credit/refund
  amount               NUMERIC(10,2) NOT NULL,
  type                 payment_type NOT NULL,
  status               payment_status NOT NULL DEFAULT 'scheduled',
  -- Dates
  due_date             DATE,
  paid_at              TIMESTAMPTZ,
  -- Payment method + external IDs (Stripe / Buildium / cash check etc.)
  payment_method       TEXT,                                  -- 'ach' | 'card' | 'cash' | 'check' | 'wire' | 'lymx'
  ext_provider         TEXT,                                  -- 'stripe' | 'buildium' | 'manual' etc.
  ext_payment_id       TEXT,
  -- LYMX redemption (when tenant uses LYMX to pay part of a fee)
  lymx_redeemed        NUMERIC(10,2) NOT NULL DEFAULT 0,      -- LYMX face value applied
  -- Description / memo / staff notes
  description          TEXT,
  staff_notes          TEXT,
  -- Audit
  recorded_by_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  recorded_by_name     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_lease       ON payments(lease_id, due_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_tenant      ON payments(tenant_profile_id, due_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_property    ON payments(property_id, due_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status      ON payments(status, due_date);
CREATE INDEX IF NOT EXISTS idx_payments_type        ON payments(type, due_date);

DROP TRIGGER IF EXISTS trg_payments_touch ON payments;
CREATE TRIGGER trg_payments_touch
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 2. WORK ORDERS — maintenance requests
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE work_order_category AS ENUM (
    'plumbing',
    'hvac',                    -- heating/cooling
    'electrical',
    'appliance',               -- refrigerator, dishwasher, washer/dryer, etc.
    'structural',              -- doors, windows, drywall, roofing
    'pest',
    'landscaping',
    'pool_spa',
    'security',                -- locks, smoke detectors, alarm
    'cleaning',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE work_order_priority AS ENUM (
    'emergency',  -- gas leak, no water, no heat in winter, flooding — same-day
    'urgent',     -- AC out in summer, fridge dead — within 24h
    'high',       -- recurring leak, broken appliance — within 3 biz days
    'normal',     -- typical repair — within 7 biz days
    'low'         -- cosmetic, nice-to-have
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE work_order_status AS ENUM (
    'submitted',                -- tenant just submitted; not yet triaged
    'triaged',                  -- broker has reviewed; categorized; not yet assigned
    'awaiting_owner_approval',  -- vendor estimate above PMA threshold; owner must approve
    'assigned',                 -- vendor dispatched
    'scheduled',                -- vendor scheduled appointment with tenant
    'in_progress',              -- vendor on site or work happening
    'completed',                -- vendor done, awaiting verification
    'verified',                 -- broker / tenant verified completion
    'closed',                   -- billed out and closed in books
    'cancelled',                -- tenant cancelled or duplicate
    'rejected'                  -- broker rejected (out of scope, tenant-caused, etc.)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS work_orders (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                 UUID REFERENCES leases(id) ON DELETE SET NULL,
  property_id              UUID REFERENCES properties(id) ON DELETE SET NULL,
  -- Who submitted it (tenant profile id), or null if entered by staff
  submitted_by_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,
  submitted_by_name        TEXT,                              -- snapshot for audit
  submitted_by_phone       TEXT,
  submitted_by_email       TEXT,
  -- Category + priority
  category                 work_order_category NOT NULL DEFAULT 'other',
  priority                 work_order_priority NOT NULL DEFAULT 'normal',
  -- Issue
  title                    TEXT NOT NULL,                     -- short summary
  description              TEXT,                              -- full description
  -- Photos / attachments stored in Supabase storage; this is an array of paths
  photo_paths              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Access — tenant gives permission to enter
  access_permission        TEXT,                              -- 'tenant_present' | 'enter_with_notice' | 'lockbox' | 'other'
  access_notes             TEXT,
  pet_in_home              BOOLEAN NOT NULL DEFAULT FALSE,
  pet_notes                TEXT,
  -- Status / lifecycle
  status                   work_order_status NOT NULL DEFAULT 'submitted',
  status_reason            TEXT,
  -- Vendor assignment
  assigned_vendor_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_vendor_name     TEXT,                              -- snapshot for audit
  assigned_at              TIMESTAMPTZ,
  -- Owner approval flow (for repairs above PMA threshold)
  estimate_amount          NUMERIC(10,2),
  estimate_provided_at     TIMESTAMPTZ,
  owner_approval_required  BOOLEAN NOT NULL DEFAULT FALSE,
  owner_approval_threshold NUMERIC(10,2),                     -- snapshot of PMA threshold at time of WO
  owner_approved_by_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  owner_approved_at        TIMESTAMPTZ,
  owner_decision           TEXT,                              -- 'approved' | 'declined' | 'modified'
  owner_decision_notes     TEXT,
  -- Scheduling
  scheduled_at             TIMESTAMPTZ,
  -- Completion
  completed_at             TIMESTAMPTZ,
  completion_notes         TEXT,
  invoice_amount           NUMERIC(10,2),
  invoice_storage_path     TEXT,
  tenant_caused            BOOLEAN NOT NULL DEFAULT FALSE,    -- if TRUE, charged back to tenant
  -- Visibility
  visible_to_owner         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Audit
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wo_lease    ON work_orders(lease_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wo_property ON work_orders(property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wo_status   ON work_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wo_vendor   ON work_orders(assigned_vendor_id, status) WHERE assigned_vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wo_priority ON work_orders(priority, status) WHERE status NOT IN ('completed','closed','cancelled','rejected');
CREATE INDEX IF NOT EXISTS idx_wo_submitter ON work_orders(submitted_by_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_wo_touch ON work_orders;
CREATE TRIGGER trg_wo_touch
  BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------
-- 3. WORK ORDER STATUS HISTORY — append-only audit
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_order_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id   UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  from_status     work_order_status,
  to_status       work_order_status NOT NULL,
  reason          TEXT,
  changed_by_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  changed_by_name TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wosh_wo ON work_order_status_history(work_order_id, changed_at DESC);

-- Trigger: log every status change automatically
CREATE OR REPLACE FUNCTION wo_log_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_actor_id UUID;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_actor_id := auth.uid();
    IF v_actor_id IS NOT NULL THEN
      SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor_id;
    END IF;
    INSERT INTO work_order_status_history (work_order_id, from_status, to_status, reason, changed_by_id, changed_by_name)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.status_reason, v_actor_id, v_actor_name);
  ELSIF TG_OP = 'INSERT' THEN
    v_actor_id := auth.uid();
    IF v_actor_id IS NOT NULL THEN
      SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor_id;
    END IF;
    INSERT INTO work_order_status_history (work_order_id, from_status, to_status, reason, changed_by_id, changed_by_name)
    VALUES (NEW.id, NULL, NEW.status, 'initial submission', v_actor_id, v_actor_name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wo_log_status ON work_orders;
CREATE TRIGGER trg_wo_log_status
  AFTER INSERT OR UPDATE OF status ON work_orders
  FOR EACH ROW EXECUTE FUNCTION wo_log_status_change();


-- ----------------------------------------------------------------
-- 4. AUDIT TRIGGERS (general — uses audit_trigger_fn from 025)
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_payments ON payments;
CREATE TRIGGER trg_audit_payments
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_work_orders ON work_orders;
CREATE TRIGGER trg_audit_work_orders
  AFTER INSERT OR UPDATE OR DELETE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ----------------------------------------------------------------
ALTER TABLE payments                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_status_history ENABLE ROW LEVEL SECURITY;

-- ---- payments ----
DROP POLICY IF EXISTS payments_managers_all ON payments;
CREATE POLICY payments_managers_all ON payments
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker','compliance','admin_onsite','accounting'))
  WITH CHECK (current_user_role() IN ('broker','compliance','admin_onsite','accounting'));

DROP POLICY IF EXISTS payments_tenant_self ON payments;
CREATE POLICY payments_tenant_self ON payments
  FOR SELECT TO authenticated
  USING (tenant_profile_id = auth.uid());

DROP POLICY IF EXISTS payments_owner_property ON payments;
CREATE POLICY payments_owner_property ON payments
  FOR SELECT TO authenticated
  USING (
    property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
  );

-- ---- work_orders ----
DROP POLICY IF EXISTS wo_managers_all ON work_orders;
CREATE POLICY wo_managers_all ON work_orders
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker','compliance','admin_onsite'))
  WITH CHECK (current_user_role() IN ('broker','compliance','admin_onsite'));

DROP POLICY IF EXISTS wo_tenant_self ON work_orders;
CREATE POLICY wo_tenant_self ON work_orders
  FOR SELECT TO authenticated
  USING (
    submitted_by_id = auth.uid()
    OR lease_id IN (
      SELECT id FROM leases
      WHERE tenant_profile_ids @> jsonb_build_array(auth.uid()::text)
    )
  );

DROP POLICY IF EXISTS wo_tenant_insert ON work_orders;
CREATE POLICY wo_tenant_insert ON work_orders
  FOR INSERT TO authenticated
  WITH CHECK (
    submitted_by_id = auth.uid()
    AND lease_id IN (
      SELECT id FROM leases
      WHERE tenant_profile_ids @> jsonb_build_array(auth.uid()::text)
    )
  );

DROP POLICY IF EXISTS wo_owner_property ON work_orders;
CREATE POLICY wo_owner_property ON work_orders
  FOR SELECT TO authenticated
  USING (
    visible_to_owner = TRUE
    AND property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS wo_vendor_assigned ON work_orders;
CREATE POLICY wo_vendor_assigned ON work_orders
  FOR SELECT TO authenticated
  USING (assigned_vendor_id = auth.uid());

-- ---- work_order_status_history ----
DROP POLICY IF EXISTS wosh_managers_all ON work_order_status_history;
CREATE POLICY wosh_managers_all ON work_order_status_history
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker','compliance','admin_onsite'))
  WITH CHECK (current_user_role() IN ('broker','compliance','admin_onsite'));

DROP POLICY IF EXISTS wosh_tenant_read ON work_order_status_history;
CREATE POLICY wosh_tenant_read ON work_order_status_history
  FOR SELECT TO authenticated
  USING (
    work_order_id IN (
      SELECT id FROM work_orders
      WHERE submitted_by_id = auth.uid()
         OR lease_id IN (SELECT id FROM leases WHERE tenant_profile_ids @> jsonb_build_array(auth.uid()::text))
    )
  );


-- ----------------------------------------------------------------
-- 6. Helper: lease_balance(lease_id) — sum of unpaid charges
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION lease_balance(p_lease_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(
    CASE
      WHEN status IN ('paid','refunded','voided','waived') THEN 0
      ELSE amount
    END
  ), 0)
  FROM payments
  WHERE lease_id = p_lease_id
$$;

GRANT EXECUTE ON FUNCTION lease_balance(UUID) TO authenticated;


-- ----------------------------------------------------------------
-- 7. Verify
-- ----------------------------------------------------------------
SELECT 'payments' AS table_name, COUNT(*) AS column_count FROM information_schema.columns WHERE table_name = 'payments'
UNION ALL
SELECT 'work_orders', COUNT(*) FROM information_schema.columns WHERE table_name = 'work_orders'
UNION ALL
SELECT 'work_order_status_history', COUNT(*) FROM information_schema.columns WHERE table_name = 'work_order_status_history';
