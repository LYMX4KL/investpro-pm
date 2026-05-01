-- ============================================================
-- 023 — Add missing extra_permissions JSONB column to profiles
-- ============================================================
-- The manage-users.html UI (and manage-permissions.html) both reference
-- profiles.extra_permissions to grant temporary PII / screening access
-- without changing a user's role. The column was never actually created
-- in earlier migrations — discovered today when manage-users.html threw
-- "column profiles.extra_permissions does not exist".
--
-- The column stores arbitrary boolean overrides, e.g.
--   { "view_pii": true, "view_screening": true }
--
-- Background: Kenny 2026-05-01 — bug surfaced while testing User Mgmt
-- after Invite User feature shipped.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS extra_permissions JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.extra_permissions IS
  'Per-user permission overrides as JSON booleans. Examples: {"view_pii":true,"view_screening":true}. Empty object {} = no overrides; defaults are derived from role.';

-- Index for lookups by override flag (e.g. find everyone with manual PII grant)
CREATE INDEX IF NOT EXISTS idx_profiles_extra_permissions
  ON profiles USING GIN (extra_permissions);


-- ----------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'extra_permissions';
