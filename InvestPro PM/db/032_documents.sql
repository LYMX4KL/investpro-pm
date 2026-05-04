-- ============================================================
-- 032 — Property documents (leases, PMAs, 1099s, etc.)
-- ============================================================
-- A single source of truth for non-application-related documents:
--   * Lease + addendums (tenant + owner can see)
--   * Property Management Agreements (owner only)
--   * 1099-MISC year-end summaries (owner only)
--   * Insurance certificates (owner only)
--   * Move-in / move-out inspection reports (tenant + owner)
--   * Vendor invoices (vendor + owner)
--   * General property records
--
-- Companion bucket: 'property-documents' on Supabase Storage.
-- File path convention: <property_id>/<doc_id>__<safe_filename>.
--
-- Background: Kenny 2026-05-04 — 3-portal documents. Distinct from
-- application-docs / verification-results / signed-documents which
-- are part of the application workflow (see db/008_storage.sql).
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Storage bucket — property-documents
-- ----------------------------------------------------------------
-- IMPORTANT: bucket creation requires supabase_admin. If you can't run
-- the INSERT, create the bucket manually in Storage UI with these settings:
--   id/name: property-documents
--   public:  false
--   max:     20 MB
--   types:   pdf, jpeg, png, heic
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-documents',
  'property-documents',
  FALSE,
  20971520,                                                       -- 20 MB
  ARRAY['application/pdf','image/jpeg','image/png','image/heic']::text[]
)
ON CONFLICT (id) DO NOTHING;


-- ----------------------------------------------------------------
-- 2. documents table
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE document_type AS ENUM (
    'lease',                 -- the executed lease document
    'lease_addendum',        -- pet addendum, HOA addendum, smoke addendum, etc.
    'pma',                   -- Property Management Agreement (owner ↔ InvestPro)
    'pma_amendment',
    'form_1099_misc',        -- year-end owner 1099
    'form_w9',               -- owner W-9
    'insurance_certificate', -- landlord insurance, COI, etc.
    'inspection_report',     -- move-in / move-out / annual inspection PDF
    'work_order_invoice',    -- vendor invoice for a completed WO
    'utility_account',       -- utility setup confirmation, NV-required disclosures
    'photo',                 -- standalone property photo (not part of inspection)
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Scoping
  property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,
  lease_id          UUID REFERENCES leases(id)     ON DELETE SET NULL,
  owner_profile_id  UUID REFERENCES profiles(id)   ON DELETE SET NULL,   -- for owner-only docs (1099, PMA)
  -- Metadata
  type              document_type NOT NULL,
  title             TEXT NOT NULL,                                       -- human-readable name shown in UI
  description       TEXT,
  -- File on Supabase Storage
  storage_bucket    TEXT NOT NULL DEFAULT 'property-documents',
  storage_path      TEXT NOT NULL,                                       -- e.g. <property_id>/<doc_id>__file.pdf
  file_size_bytes   INT,
  mime_type         TEXT,
  -- Visibility flags — tenant/owner/vendor see in their portal if true
  tenant_visible    BOOLEAN NOT NULL DEFAULT FALSE,
  owner_visible     BOOLEAN NOT NULL DEFAULT FALSE,
  vendor_visible    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Tax / year tagging
  tax_year          INT,                                                 -- for 1099s + W-9s
  -- Soft delete
  deleted_at        TIMESTAMPTZ,
  deleted_reason    TEXT,
  -- Audit
  uploaded_by_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_by_name  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_property    ON documents(property_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_docs_lease       ON documents(lease_id,    created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_docs_owner       ON documents(owner_profile_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_docs_type        ON documents(type, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_docs_tax_year    ON documents(tax_year, type) WHERE tax_year IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_documents_touch ON documents;
CREATE TRIGGER trg_documents_touch
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_audit_documents ON documents;
CREATE TRIGGER trg_audit_documents
  AFTER INSERT OR UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 3. Storage RLS — property-documents bucket
-- ----------------------------------------------------------------
-- Path convention: <property_id>/<doc_id>__<filename>
-- The first folder segment is always the property_id, which is what
-- our visibility checks key off.

-- Staff (broker/compliance/admin_onsite/accounting): full access
DROP POLICY IF EXISTS "staff all property-documents" ON storage.objects;
CREATE POLICY "staff all property-documents"
  ON storage.objects FOR ALL
  TO authenticated
  USING (
    bucket_id = 'property-documents'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('broker','compliance','admin_onsite','accounting')
    )
  )
  WITH CHECK (
    bucket_id = 'property-documents'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('broker','compliance','admin_onsite','accounting')
    )
  );

-- Owners can read documents for their own properties (and where owner_visible=true on the metadata row)
DROP POLICY IF EXISTS "owners read own property-documents" ON storage.objects;
CREATE POLICY "owners read own property-documents"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'property-documents'
    AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.storage_bucket = 'property-documents'
        AND d.storage_path = storage.objects.name
        AND d.owner_visible = TRUE
        AND d.deleted_at IS NULL
        AND (
          d.owner_profile_id = auth.uid()
          OR d.property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
        )
    )
  );

-- Tenants can read documents for their own lease (and where tenant_visible=true)
DROP POLICY IF EXISTS "tenants read own property-documents" ON storage.objects;
CREATE POLICY "tenants read own property-documents"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'property-documents'
    AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.storage_bucket = 'property-documents'
        AND d.storage_path = storage.objects.name
        AND d.tenant_visible = TRUE
        AND d.deleted_at IS NULL
        AND d.lease_id IN (
          SELECT id FROM leases
          WHERE tenant_profile_ids @> jsonb_build_array(auth.uid()::text)
        )
    )
  );

-- Vendors can read invoices for work orders they were assigned to
DROP POLICY IF EXISTS "vendors read assigned property-documents" ON storage.objects;
CREATE POLICY "vendors read assigned property-documents"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'property-documents'
    AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.storage_bucket = 'property-documents'
        AND d.storage_path = storage.objects.name
        AND d.vendor_visible = TRUE
        AND d.deleted_at IS NULL
        AND d.uploaded_by_id = auth.uid()                               -- vendor uploaded it themselves
    )
  );


-- ----------------------------------------------------------------
-- 4. RLS on `documents` metadata table
-- ----------------------------------------------------------------
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Managers: all access
DROP POLICY IF EXISTS docs_managers_all ON documents;
CREATE POLICY docs_managers_all ON documents
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker','compliance','admin_onsite','accounting'))
  WITH CHECK (current_user_role() IN ('broker','compliance','admin_onsite','accounting'));

-- Owner read scope
DROP POLICY IF EXISTS docs_owner_scope ON documents;
CREATE POLICY docs_owner_scope ON documents
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND owner_visible = TRUE
    AND (
      owner_profile_id = auth.uid()
      OR property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
    )
  );

-- Tenant read scope
DROP POLICY IF EXISTS docs_tenant_scope ON documents;
CREATE POLICY docs_tenant_scope ON documents
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND tenant_visible = TRUE
    AND lease_id IN (
      SELECT id FROM leases
      WHERE tenant_profile_ids @> jsonb_build_array(auth.uid()::text)
    )
  );

-- Vendor read scope (only docs they uploaded — typically their own invoices)
DROP POLICY IF EXISTS docs_vendor_scope ON documents;
CREATE POLICY docs_vendor_scope ON documents
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND vendor_visible = TRUE
    AND uploaded_by_id = auth.uid()
  );


-- ----------------------------------------------------------------
-- 5. Verify
-- ----------------------------------------------------------------
SELECT 'documents' AS table_name, COUNT(*) AS column_count
  FROM information_schema.columns WHERE table_name = 'documents';
