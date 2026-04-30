-- ============================================================
-- 005 — Screening + Workflow
-- ============================================================
-- Verifications (VOR/VOE/credit/etc.), the AI-assembled Screening Summary,
-- the universal communications log, and VA work queue tasks.

-- ----------------------------------------------------------------
-- verifications — one row per verification we send out
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verifications (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  verification_type       verification_type NOT NULL,
  status                  verification_status NOT NULL DEFAULT 'not_sent',
  -- Recipient
  sent_to_name            TEXT,
  sent_to_email           TEXT,
  sent_to_phone           TEXT,
  -- Send mechanics
  template_id             UUID,                       -- → email_templates.id (set in 007)
  e_sign_envelope_id      TEXT,                       -- Dropbox Sign envelope when applicable
  external_request_id     TEXT,                       -- e.g. SmartMove report ID, RentSpree request ID
  external_provider       TEXT,                       -- 'smartmove' | 'rentspree' | 'manual_upload' | 'plaid' | etc.
  -- Timestamps + SLA
  sent_at                 TIMESTAMPTZ,
  last_reminder_sent_at   TIMESTAMPTZ,
  received_at             TIMESTAMPTZ,
  sla_due_at              TIMESTAMPTZ,                -- typically 48 hours from sent
  -- Result
  result_payload          JSONB,                      -- raw response or admin-uploaded PDF metadata
  result_storage_path     TEXT,                       -- bucket: verification-results
  -- AI auto-extraction (Claude API output, VA-editable)
  ai_parsed_summary       JSONB,                      -- {"paid_on_time": true, "would_rerent": true, "salary_confirmed": 65000, ...}
  ai_parsed_at            TIMESTAMPTZ,
  -- VA finalization
  va_verified_by          UUID REFERENCES profiles(id),
  va_verified_at          TIMESTAMPTZ,
  va_notes                TEXT,
  -- Audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verifications_app ON verifications(application_id);
CREATE INDEX IF NOT EXISTS idx_verifications_status ON verifications(status);
CREATE INDEX IF NOT EXISTS idx_verifications_sla ON verifications(sla_due_at) WHERE status IN ('sent', 'reminded');

DROP TRIGGER IF EXISTS trg_verifications_touch_updated ON verifications;
CREATE TRIGGER trg_verifications_touch_updated
  BEFORE UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- screening_reports — AI-drafted Screening Summary, finalized by VA
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS screening_reports (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          UUID NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  -- Computed
  meets_3x_income         BOOLEAN,                    -- combined gross monthly income >= 3 * monthly_rent
  combined_monthly_income NUMERIC(10,2),
  income_to_rent_ratio    NUMERIC(4,2),
  -- Credit summary
  credit_score            INT,
  credit_provider         TEXT,                       -- 'smartmove' | 'rentspree' | 'manual'
  derogatory_summary      JSONB,                      -- {"collections": 1, "charge_offs": 0, "bankruptcies": 0}
  -- Background
  background_summary      TEXT,
  background_clean        BOOLEAN,
  -- VOR/VOE summaries (AI-generated from verifications)
  vor_summary             TEXT,
  voe_summary             TEXT,
  pet_screening_summary   TEXT,
  -- Recommendation
  recommendation          recommendation,
  recommendation_notes    TEXT,
  -- Flags grid (display-friendly)
  flags                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. {"income": "green", "credit": "yellow", "vor": "green", "background": "green"}
  -- Lifecycle
  ai_drafted_at           TIMESTAMPTZ,
  va_finalized_at         TIMESTAMPTZ,
  va_finalized_by         UUID REFERENCES profiles(id),
  pdf_storage_path        TEXT,                       -- bucket: screening-summaries
  -- Audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screening_app ON screening_reports(application_id);
CREATE INDEX IF NOT EXISTS idx_screening_recommendation ON screening_reports(recommendation);

DROP TRIGGER IF EXISTS trg_screening_touch_updated ON screening_reports;
CREATE TRIGGER trg_screening_touch_updated
  BEFORE UPDATE ON screening_reports
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- communications — universal audit log (email + SMS + calls + system events)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      UUID REFERENCES applications(id) ON DELETE CASCADE,
  property_id         UUID REFERENCES properties(id) ON DELETE SET NULL,  -- some comms aren't app-specific
  direction           comm_direction NOT NULL,
  channel             comm_channel NOT NULL,
  -- Email/SMS-specific
  from_email          TEXT,
  to_email            TEXT,
  cc_emails           JSONB,
  bcc_emails          JSONB,
  reply_to            TEXT,
  subject             TEXT,
  body_html           TEXT,
  body_text           TEXT,
  thread_id           TEXT,                           -- groups email reply chains
  message_id          TEXT,                           -- email Message-ID header (for In-Reply-To)
  in_reply_to         TEXT,                           -- email In-Reply-To header
  attachments         JSONB,                          -- [{name, storage_path, size}]
  template_used       TEXT,                           -- email_templates.key
  -- SMS specific
  from_phone          TEXT,
  to_phone            TEXT,
  -- Call-specific
  call_logged_by      UUID REFERENCES profiles(id),
  call_outcome        call_outcome,
  call_duration_sec   INT,
  call_notes          TEXT,
  -- Send mechanics
  send_provider       TEXT,                           -- 'resend' | 'twilio' | 'manual'
  send_status         TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'sent' | 'delivered' | 'failed' | 'logged'
  send_error          TEXT,
  send_provider_id    TEXT,                           -- Resend message ID etc.
  -- Audit timestamps
  sent_at             TIMESTAMPTZ,
  received_at         TIMESTAMPTZ,
  read_by_va          BOOLEAN NOT NULL DEFAULT FALSE,
  read_at             TIMESTAMPTZ,
  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comms_app ON communications(application_id);
CREATE INDEX IF NOT EXISTS idx_comms_property ON communications(property_id);
CREATE INDEX IF NOT EXISTS idx_comms_thread ON communications(thread_id);
CREATE INDEX IF NOT EXISTS idx_comms_unread_va ON communications(read_by_va) WHERE read_by_va = FALSE;

-- ----------------------------------------------------------------
-- tasks — VA work queue
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID REFERENCES applications(id) ON DELETE CASCADE,
  task_type       task_type NOT NULL,
  status          task_status NOT NULL DEFAULT 'open',
  title           TEXT NOT NULL,
  description     TEXT,
  assigned_to     UUID REFERENCES profiles(id),       -- defaults to active VA
  priority        INT NOT NULL DEFAULT 3,             -- 1=highest, 5=lowest
  due_at          TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  completed_by    UUID REFERENCES profiles(id),
  outcome_notes   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_app ON tasks(application_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_open ON tasks(assigned_to, status) WHERE status IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at) WHERE status IN ('open', 'in_progress');

DROP TRIGGER IF EXISTS trg_tasks_touch_updated ON tasks;
CREATE TRIGGER trg_tasks_touch_updated
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
