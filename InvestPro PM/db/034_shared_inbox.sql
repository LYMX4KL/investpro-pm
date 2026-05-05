-- ============================================================
-- 034 — Allow shared inboxes in agent_emails
-- ============================================================
-- Background: Kenny 2026-05-04 — InvestPro needs shared role-based
-- inboxes (marketing@, info@, sales@, support@) that fan out to
-- multiple recipients. Originally agent_emails was 1:1 with a
-- profile; this migration makes profile_id optional and adds the
-- shared-inbox metadata.
--
-- Changes:
--   1. profile_id becomes nullable (NULL = shared inbox)
--   2. New flag column is_shared
--   3. New shared_forward_to_list JSONB (array of CF destinations)
--   4. New shared_display_name (used in onboarding email + Gmail "Send mail as")
--   5. Drop the old UNIQUE(profile_id, company_id); shared inboxes
--      are uniquely identified by full_email (already UNIQUE).
--      For staff emails we re-enforce uniqueness via a partial
--      UNIQUE INDEX where profile_id IS NOT NULL.
-- ============================================================

-- 1. profile_id → nullable
ALTER TABLE agent_emails
  ALTER COLUMN profile_id DROP NOT NULL;

-- 2. is_shared flag
ALTER TABLE agent_emails
  ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. JSON array of forward destinations (CF supports up to 5)
ALTER TABLE agent_emails
  ADD COLUMN IF NOT EXISTS shared_forward_to_list JSONB;

-- 4. Display name for shared inboxes
ALTER TABLE agent_emails
  ADD COLUMN IF NOT EXISTS shared_display_name TEXT;

-- 5. Re-shape the staff uniqueness constraint
ALTER TABLE agent_emails
  DROP CONSTRAINT IF EXISTS agent_emails_profile_id_company_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_emails_profile_company
  ON agent_emails(profile_id, company_id)
  WHERE profile_id IS NOT NULL;

-- Sanity check column on shared rows: must have a non-empty list
ALTER TABLE agent_emails
  DROP CONSTRAINT IF EXISTS chk_shared_has_forward_list;
ALTER TABLE agent_emails
  ADD CONSTRAINT chk_shared_has_forward_list
    CHECK (
      NOT is_shared
      OR (jsonb_typeof(shared_forward_to_list) = 'array'
          AND jsonb_array_length(shared_forward_to_list) BETWEEN 1 AND 5)
    );

COMMENT ON COLUMN agent_emails.is_shared IS
  'TRUE for role-based shared inboxes (marketing@, info@, support@). When TRUE, profile_id is NULL and shared_forward_to_list holds the CF route destinations.';

COMMENT ON COLUMN agent_emails.shared_forward_to_list IS
  'JSONB array of email destinations for shared inboxes. Cloudflare Email Routing allows up to 5 destinations per route.';

-- Verify
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
  WHERE table_name = 'agent_emails'
    AND column_name IN ('profile_id', 'is_shared', 'shared_forward_to_list', 'shared_display_name')
  ORDER BY column_name;
