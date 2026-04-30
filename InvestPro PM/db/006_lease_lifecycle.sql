-- ============================================================
-- 006 — Lease Lifecycle
-- ============================================================
-- Term sheets (offer + counter), executed leases, calendar events
-- (lease signing / orientation / move-in inspection), and post-move-in reviews.

-- ----------------------------------------------------------------
-- term_sheets — generated after broker approval, sent to applicant
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS term_sheets (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- Pricing (snapshot at term-sheet send time)
  monthly_rent                NUMERIC(10,2) NOT NULL,
  security_deposit            NUMERIC(10,2) NOT NULL,           -- can exceed MLS-advertised; refundable
  pet_fee                     NUMERIC(10,2),                    -- "fee" not "deposit" — non-refundable per Joan's note
  pet_rent_monthly            NUMERIC(10,2),
  lease_processing_fee        NUMERIC(10,2) NOT NULL DEFAULT 100.00,  -- Joan's correction: $100, not $800
  prorated_rent               NUMERIC(10,2),
  next_month_full_rent        NUMERIC(10,2),                    -- when move-in is on/after the 11th
  deferred_move_in_amount     NUMERIC(10,2),                    -- portion deferred to next 1st (must be < prorated_rent)
  total_due_at_signing        NUMERIC(10,2),                    -- computed from above
  -- Lease terms
  lease_term_months           INT NOT NULL DEFAULT 12,
  lease_start                 DATE NOT NULL,
  lease_end                   DATE NOT NULL,
  -- Free-form additional terms (e.g. parking, lawn-care, pet rules)
  additional_terms            JSONB,
  -- Sewer/trash inclusion confirmation (NV law — must be in rent now)
  utilities_included_in_rent  JSONB,                            -- ["sewer", "trash", ...]
  -- Versioning + counter-offer flow
  version                     INT NOT NULL DEFAULT 1,
  parent_term_sheet_id        UUID REFERENCES term_sheets(id),  -- if revised after counter
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,    -- only one active per application
  -- Send mechanics
  e_sign_envelope_id          TEXT,                             -- Dropbox Sign envelope
  pdf_storage_path            TEXT,                             -- bucket: signed-documents
  sent_at                     TIMESTAMPTZ,
  acceptance_deadline         TIMESTAMPTZ,                      -- 3 biz days from sent
  -- Applicant response
  applicant_response          term_response,
  applicant_response_at       TIMESTAMPTZ,
  applicant_counter_terms     JSONB,                            -- if response = 'counter'
  -- Broker response to applicant's counter
  broker_response_to_counter  term_response,
  broker_response_at          TIMESTAMPTZ,
  broker_response_notes       TEXT,
  -- Audit
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terms_app ON term_sheets(application_id);
CREATE INDEX IF NOT EXISTS idx_terms_active ON term_sheets(application_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_terms_deadline ON term_sheets(acceptance_deadline) WHERE applicant_response IS NULL;

DROP TRIGGER IF EXISTS trg_terms_touch_updated ON term_sheets;
CREATE TRIGGER trg_terms_touch_updated
  BEFORE UPDATE ON term_sheets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- leases — executed leases (one per application that reaches 'leased')
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leases (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          UUID NOT NULL UNIQUE REFERENCES applications(id),
  property_id             UUID NOT NULL REFERENCES properties(id),
  term_sheet_id           UUID REFERENCES term_sheets(id),
  -- Tenants on the lease (array of profile IDs once they have accounts)
  tenant_profile_ids      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Effective terms
  start_date              DATE NOT NULL,
  end_date                DATE NOT NULL,
  monthly_rent            NUMERIC(10,2) NOT NULL,
  security_deposit_held   NUMERIC(10,2) NOT NULL,
  pet_fee_paid            NUMERIC(10,2),
  -- Execution
  e_sign_envelope_id      TEXT,
  fully_executed_at       TIMESTAMPTZ,
  pdf_storage_path        TEXT,
  -- Addendums signed
  addendums_signed        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- e.g. ["addendum_3", "pool_addendum", "pet_addendum", "esa_addendum"]
  -- External system sync
  buildium_lease_id       TEXT,                                 -- for parallel-run with Buildium
  -- Status / lifecycle
  status                  TEXT NOT NULL DEFAULT 'active',       -- 'active' | 'renewed' | 'terminated' | 'expired'
  terminated_at           TIMESTAMPTZ,
  termination_reason      TEXT,
  -- Move-in condition report — convenience pointers (full data lives in `inspections` table from 011)
  micr_due_at             TIMESTAMPTZ,                          -- 3 business days from key release
  micr_returned_at        TIMESTAMPTZ,
  micr_storage_path       TEXT,                                 -- legacy; new MICRs use inspections.pdf_storage_path
  micr_deemed_perfect     BOOLEAN NOT NULL DEFAULT FALSE,       -- TRUE if MICR not returned in 3 biz days
  -- Pre-move-in inspection done by InvestPro staff before key release
  pre_move_in_inspection_id UUID,                               -- FK added in 011_inspections after that table exists
  -- Audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leases_property ON leases(property_id);
CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status);
CREATE INDEX IF NOT EXISTS idx_leases_renewal ON leases(end_date) WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_leases_touch_updated ON leases;
CREATE TRIGGER trg_leases_touch_updated
  BEFORE UPDATE ON leases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- calendar_events — lease signing, orientation, move-in inspection
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          UUID REFERENCES applications(id) ON DELETE CASCADE,
  lease_id                UUID REFERENCES leases(id) ON DELETE CASCADE,
  event_type              calendar_event_type NOT NULL,
  scheduled_at            TIMESTAMPTZ NOT NULL,
  duration_minutes        INT NOT NULL DEFAULT 45,             -- orientation default 30-45
  location                TEXT,
  zoom_link               TEXT,                                -- for off-site participants
  attendees               JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{profile_id, email, name, role}]
  notes                   TEXT,
  -- Reminder mechanics
  ics_sent_at             TIMESTAMPTZ,
  reminder_24h_sent_at    TIMESTAMPTZ,
  google_calendar_event_id TEXT,
  -- Outcome
  completed               BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at            TIMESTAMPTZ,
  no_show                 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cal_app ON calendar_events(application_id);
CREATE INDEX IF NOT EXISTS idx_cal_upcoming ON calendar_events(scheduled_at) WHERE completed = FALSE;

-- ----------------------------------------------------------------
-- reviews — post-move-in review requests + responses
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      UUID REFERENCES applications(id) ON DELETE SET NULL,
  lease_id            UUID REFERENCES leases(id) ON DELETE SET NULL,
  recipient_email     TEXT NOT NULL,
  recipient_role      TEXT NOT NULL,                            -- 'applicant' | 'agent_listing' | 'agent_showing'
  -- Send
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Response
  response_received_at TIMESTAMPTZ,
  rating              INT,                                       -- 1-5
  comment             TEXT,
  google_review_left  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_app ON reviews(application_id);
CREATE INDEX IF NOT EXISTS idx_reviews_unresponded ON reviews(sent_at) WHERE response_received_at IS NULL;
