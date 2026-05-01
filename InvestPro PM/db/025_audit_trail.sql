-- ============================================================
-- 025 — Audit trail foundation (rules apply to ALL editable content)
-- ============================================================
-- Goal: court-defensible record of who-did-what-when on every
-- editable record. Specifically:
--   * Inspection notes + condition changes
--   * Inspection photos (uploads + removals)
--   * Feedback messages (incl. resolution_notes edits)
--   * Property edits
--
-- Design decisions (per rules in feedback_audit_trail_rules.md):
--   1. Name + role snapshots stored at action time. We never
--      re-join live to profiles for historical display because
--      when staff turn over and a replacement takes the same
--      email, joining live would silently re-attribute history
--      to the wrong person.
--   2. Append-only. We do NOT update existing audit_log rows.
--      Photos use is_removed flag rather than DELETE.
--   3. Photos display the inspection's started_at timestamp,
--      not the wall clock when the upload happened. Inspections
--      take 30+ minutes; one consistent "inspection time"
--      reads cleaner in court than scattered photo timestamps.
--      uploaded_at is still recorded for audit purposes.
--
-- Background: Kenny 2026-05-01 — site may be used as evidence
-- in deposit disputes, evictions, fair-housing complaints.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Generic audit_log table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name            TEXT NOT NULL,
  row_id                UUID NOT NULL,
  action                TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),

  -- Actor identity (LIVE pointer + SNAPSHOTS — never re-join live for display)
  actor_id              UUID,
  actor_name_snapshot   TEXT,
  actor_role_snapshot   TEXT,
  actor_email_snapshot  TEXT,

  changed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  before_data           JSONB,           -- full row before (NULL for INSERT)
  after_data            JSONB,           -- full row after  (NULL for DELETE)
  changed_fields        TEXT[]           -- list of fields that differ; empty for INSERT/DELETE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_row
  ON audit_log(table_name, row_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log(actor_id, changed_at DESC);

COMMENT ON COLUMN audit_log.actor_name_snapshot IS
  'Actor''s full_name at time of action. Frozen — NEVER updated even if profiles.full_name changes later. This is what we display in edit history.';

COMMENT ON COLUMN audit_log.actor_email_snapshot IS
  'Actor''s email at time of action. Frozen. Helps disambiguate when names change but the same email keeps the same role.';


-- ----------------------------------------------------------------
-- 2. Generic audit trigger function
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor_id    UUID;
  v_name        TEXT;
  v_role        TEXT;
  v_email       TEXT;
  v_row_id      UUID;
  v_changed     TEXT[];
  v_before      JSONB;
  v_after       JSONB;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NOT NULL THEN
    SELECT full_name, role::text, email
      INTO v_name, v_role, v_email
      FROM profiles WHERE id = v_actor_id;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    v_row_id := OLD.id;
    v_before := to_jsonb(OLD);
    v_after  := NULL;
  ELSIF (TG_OP = 'INSERT') THEN
    v_row_id := NEW.id;
    v_before := NULL;
    v_after  := to_jsonb(NEW);
  ELSE  -- UPDATE
    v_row_id := NEW.id;
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    -- Compute list of changed field names
    SELECT array_agg(k) INTO v_changed
    FROM (
      SELECT key AS k FROM jsonb_each(v_after)
      WHERE v_before -> key IS DISTINCT FROM v_after -> key
    ) sub;
  END IF;

  INSERT INTO audit_log (
    table_name, row_id, action,
    actor_id, actor_name_snapshot, actor_role_snapshot, actor_email_snapshot,
    before_data, after_data, changed_fields
  ) VALUES (
    TG_TABLE_NAME, v_row_id, TG_OP,
    v_actor_id, v_name, v_role, v_email,
    v_before, v_after, COALESCE(v_changed, ARRAY[]::TEXT[])
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ----------------------------------------------------------------
-- 3. Attach to the four tables in scope
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_inspections ON inspections;
CREATE TRIGGER trg_audit_inspections
  AFTER INSERT OR UPDATE OR DELETE ON inspections
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_inspection_items ON inspection_items;
CREATE TRIGGER trg_audit_inspection_items
  AFTER INSERT OR UPDATE OR DELETE ON inspection_items
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_feedback ON feedback;
CREATE TRIGGER trg_audit_feedback
  AFTER INSERT OR UPDATE OR DELETE ON feedback
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

DROP TRIGGER IF EXISTS trg_audit_properties ON properties;
CREATE TRIGGER trg_audit_properties
  AFTER INSERT OR UPDATE OR DELETE ON properties
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 4. inspection_photos table — first-class record, append-only
-- ----------------------------------------------------------------
-- Replaces the implicit "list of paths in inspection_items.photo_paths".
-- A row per photo so each upload + removal is auditable, and each photo
-- carries snapshot metadata for court-printable export.
CREATE TABLE IF NOT EXISTS inspection_photos (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id            UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  inspection_item_id       UUID REFERENCES inspection_items(id) ON DELETE CASCADE,

  storage_path             TEXT NOT NULL,           -- e.g. signed-documents/inspections/<id>/<item_id>/<file>
  caption                  TEXT,                    -- short note shown in printed export

  -- Uploader snapshot (frozen at upload time)
  uploaded_by_id           UUID REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_by_name         TEXT NOT NULL,
  uploaded_by_role         TEXT,
  uploaded_by_email        TEXT,
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- wall clock — for audit

  -- Display timestamp = inspection.started_at (per Rule 4 — court-defensible)
  -- Set by trigger below; do NOT set this from the client.
  display_timestamp        TIMESTAMPTZ NOT NULL,

  -- Soft-delete (append-only)
  is_removed               BOOLEAN NOT NULL DEFAULT FALSE,
  removed_at               TIMESTAMPTZ,
  removed_by_id            UUID REFERENCES profiles(id) ON DELETE SET NULL,
  removed_by_name          TEXT,
  removed_by_role          TEXT,
  removal_reason           TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inspection_photos_inspection
  ON inspection_photos(inspection_id) WHERE is_removed = FALSE;
CREATE INDEX IF NOT EXISTS idx_inspection_photos_item
  ON inspection_photos(inspection_item_id) WHERE is_removed = FALSE;

COMMENT ON COLUMN inspection_photos.display_timestamp IS
  'Timestamp shown in UI and PDF exports — pinned to inspections.started_at to keep all photos from one inspection consistent in court.';

COMMENT ON COLUMN inspection_photos.uploaded_at IS
  'Real wall-clock when the upload was received. Internal/audit only — never display.';


-- ----------------------------------------------------------------
-- 5. Trigger: set display_timestamp = inspection.started_at on insert
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION inspection_photos_set_display_ts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_started_at TIMESTAMPTZ;
BEGIN
  -- Pull the parent inspection's started_at; fall back to NOW() if null
  -- (shouldn't happen in practice — perform.html promotes status to
  -- in_progress and sets started_at on first load).
  SELECT started_at INTO v_started_at
  FROM inspections WHERE id = NEW.inspection_id;
  NEW.display_timestamp := COALESCE(v_started_at, NOW());

  -- Snapshot uploader name/role/email if not already provided by the client
  IF NEW.uploaded_by_id IS NOT NULL AND (NEW.uploaded_by_name IS NULL OR NEW.uploaded_by_name = '') THEN
    SELECT full_name, role::text, email
      INTO NEW.uploaded_by_name, NEW.uploaded_by_role, NEW.uploaded_by_email
      FROM profiles WHERE id = NEW.uploaded_by_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inspection_photos_set_display_ts ON inspection_photos;
CREATE TRIGGER trg_inspection_photos_set_display_ts
  BEFORE INSERT ON inspection_photos
  FOR EACH ROW EXECUTE FUNCTION inspection_photos_set_display_ts();


-- ----------------------------------------------------------------
-- 6. Trigger: snapshot remover name on soft-delete
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION inspection_photos_set_remover()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only fires when is_removed transitions FALSE → TRUE
  IF OLD.is_removed = FALSE AND NEW.is_removed = TRUE THEN
    NEW.removed_at := NOW();
    NEW.removed_by_id := auth.uid();
    IF NEW.removed_by_id IS NOT NULL AND (NEW.removed_by_name IS NULL OR NEW.removed_by_name = '') THEN
      SELECT full_name, role::text
        INTO NEW.removed_by_name, NEW.removed_by_role
        FROM profiles WHERE id = NEW.removed_by_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inspection_photos_set_remover ON inspection_photos;
CREATE TRIGGER trg_inspection_photos_set_remover
  BEFORE UPDATE ON inspection_photos
  FOR EACH ROW EXECUTE FUNCTION inspection_photos_set_remover();


-- ----------------------------------------------------------------
-- 7. Audit trigger on inspection_photos itself
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_inspection_photos ON inspection_photos;
CREATE TRIGGER trg_audit_inspection_photos
  AFTER INSERT OR UPDATE OR DELETE ON inspection_photos
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();


-- ----------------------------------------------------------------
-- 8. RLS for inspection_photos
-- ----------------------------------------------------------------
ALTER TABLE inspection_photos ENABLE ROW LEVEL SECURITY;

-- Anyone with access to the parent inspection can read its photos
DROP POLICY IF EXISTS inspection_photos_read ON inspection_photos;
CREATE POLICY inspection_photos_read ON inspection_photos
  FOR SELECT TO authenticated
  USING (can_access_inspection(inspection_id));

-- Anyone performing the inspection can insert photos
DROP POLICY IF EXISTS inspection_photos_insert ON inspection_photos;
CREATE POLICY inspection_photos_insert ON inspection_photos
  FOR INSERT TO authenticated
  WITH CHECK (can_access_inspection(inspection_id));

-- Soft-delete: only the original uploader OR a manager can mark removed
DROP POLICY IF EXISTS inspection_photos_soft_delete ON inspection_photos;
CREATE POLICY inspection_photos_soft_delete ON inspection_photos
  FOR UPDATE TO authenticated
  USING (
    uploaded_by_id = auth.uid()
    OR current_user_role() IN ('broker', 'compliance', 'admin_onsite')
  )
  WITH CHECK (
    uploaded_by_id = auth.uid()
    OR current_user_role() IN ('broker', 'compliance', 'admin_onsite')
  );

-- Hard delete is BLOCKED. Use the is_removed flag instead.
-- (No DELETE policy = denied for everyone except service-role.)


-- ----------------------------------------------------------------
-- 9. RLS for audit_log
-- ----------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read audit_log entries that pertain to records
-- they can see. The table_name + row_id let us delegate to existing RLS.
-- For the simple case: broker / compliance / admin can see all audit rows.
-- Other roles see only their own actions.
DROP POLICY IF EXISTS audit_log_managers_read ON audit_log;
CREATE POLICY audit_log_managers_read ON audit_log
  FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('broker', 'compliance', 'admin_onsite')
    OR actor_id = auth.uid()
  );

-- audit_log is INSERT-only via the trigger function (SECURITY DEFINER).
-- No INSERT/UPDATE/DELETE policies → those are denied for all clients.
-- This makes the audit_log tamper-resistant.


-- ----------------------------------------------------------------
-- 10. Verify
-- ----------------------------------------------------------------
SELECT 'audit_log columns' AS check, column_name FROM information_schema.columns
WHERE table_name = 'audit_log' ORDER BY ordinal_position;

SELECT 'inspection_photos columns' AS check, column_name FROM information_schema.columns
WHERE table_name = 'inspection_photos' ORDER BY ordinal_position;

SELECT 'audit triggers' AS check, trigger_name, event_object_table FROM information_schema.triggers
WHERE trigger_name LIKE 'trg_audit_%' ORDER BY trigger_name;
