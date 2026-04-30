-- ============================================================
-- 018 — PetScreening webhook plumbing
-- ============================================================
-- Adds the bits the Netlify Function (netlify/functions/petscreening-webhook.js)
-- needs to receive callbacks from PetScreening.com when an applicant completes
-- their pet/animal profile.
--
-- Adds:
--   1. webhook_events table — audit log of every incoming webhook (for debugging
--      + replay if a payload arrives malformed).
--   2. Two new vendor_settings keys for webhook config (URL display + shared secret).
--   3. A small public-read policy on vendor_settings so the applicant-facing
--      submission confirmation page can pull the PetScreening profile URL
--      without authentication.
--
-- Background: Kenny 2026-04-30 — "petscreening already signed up, waiting for
-- the URL, and the webhook, lets completed this all the way now."
-- ============================================================


-- ----------------------------------------------------------------
-- 1. webhook_events — log every webhook hit for audit + debugging
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT NOT NULL,                -- 'petscreening' | 'transunion' | etc.
  event_type      TEXT,                         -- vendor-specific event name if provided
  reference_id    TEXT,                         -- our application_id we matched to (or NULL if unmatched)
  -- Raw record
  http_method     TEXT NOT NULL,
  request_headers JSONB,
  request_body    JSONB,
  -- Outcome
  status          TEXT NOT NULL DEFAULT 'received',  -- 'received' | 'processed' | 'failed' | 'ignored'
  error_message   TEXT,
  rows_updated    INT,                          -- how many application_pets rows we updated
  -- Audit
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_source     ON webhook_events(source);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received   ON webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_reference  ON webhook_events(reference_id);

COMMENT ON TABLE webhook_events IS
  'Audit log of all incoming third-party webhooks. Helpful for debugging when a vendor changes payload shape or we miss an update.';

-- RLS: only PII-access roles can read the log (it may contain applicant emails / PII)
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_events_pii_read ON webhook_events;
CREATE POLICY webhook_events_pii_read ON webhook_events
  FOR SELECT TO authenticated
  USING (current_user_has_pii_access());


-- ----------------------------------------------------------------
-- 2. Add webhook-config keys to vendor_settings
-- ----------------------------------------------------------------
INSERT INTO vendor_settings (key, description) VALUES
  ('petscreening_webhook_secret',
   'Shared secret PetScreening uses to sign webhook callbacks. Generated once and pasted into both PetScreening dashboard and Netlify env vars. Treat as private — never expose to applicants.'),
  ('petscreening_reference_param',
   'Query-string parameter name PetScreening uses to round-trip our reference ID. Default: referenceNumber. If PetScreening uses a different name in their dashboard config, set it here.')
ON CONFLICT (key) DO NOTHING;

-- Default the param name (broker can edit if PetScreening uses something else)
UPDATE vendor_settings SET value = 'referenceNumber'
WHERE key = 'petscreening_reference_param' AND (value IS NULL OR value = '');


-- ----------------------------------------------------------------
-- 3. Public read on PetScreening URL key
-- ----------------------------------------------------------------
-- Applicants on the submission confirmation page need to be able to read the
-- PetScreening Property Manager URL to render the "Complete Pet Screening" link.
-- They are unauthenticated at that moment. Allow anon read on JUST that one key.
DROP POLICY IF EXISTS vendor_settings_public_url_read ON vendor_settings;
CREATE POLICY vendor_settings_public_url_read ON vendor_settings
  FOR SELECT TO anon, authenticated
  USING (key IN ('petscreening_pm_url', 'petscreening_reference_param'));


-- ----------------------------------------------------------------
-- 4. VERIFY
-- ----------------------------------------------------------------
SELECT key, description IS NOT NULL AS has_description, value IS NOT NULL AS has_value
FROM vendor_settings
WHERE key LIKE 'petscreening%'
ORDER BY key;

SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('webhook_events', 'vendor_settings')
ORDER BY tablename, policyname;
