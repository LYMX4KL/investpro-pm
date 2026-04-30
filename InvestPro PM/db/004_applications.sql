-- ============================================================
-- 004 — Applications + Sub-tables
-- ============================================================
-- Core application records, plus normalized sub-tables for documents,
-- co-applicants, pets, vehicles, signatures.

-- ----------------------------------------------------------------
-- applications — one row per adult applying (primary or co-applicant)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_number             TEXT NOT NULL UNIQUE,       -- e.g. 'IPR-XXXXXXX'
  -- Property + agent links
  property_id                     UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  showing_agent_id                UUID REFERENCES agents(id),  -- who shared the link / showed property
  listing_agent_id                UUID REFERENCES agents(id),  -- copied from property at app time
  referral_company                TEXT,                        -- non-agent referral source
  -- Applicant + role
  applicant_role                  applicant_role NOT NULL DEFAULT 'primary',
  primary_application_id          UUID REFERENCES applications(id),  -- for co-apps, points to primary
  applicant_profile_id            UUID REFERENCES profiles(id),  -- if applicant has account
  -- Personal info (denormalized snapshot at submit time)
  first_name                      TEXT NOT NULL,
  middle_name                     TEXT,
  last_name                       TEXT NOT NULL,
  email                           TEXT NOT NULL,
  phone                           TEXT NOT NULL,
  date_of_birth                   DATE,
  ssn_last4                       TEXT,                       -- only last 4; full SSN goes encrypted/external
  nv_drivers_license              TEXT,
  -- Current residence (Joan's homeowner branch)
  current_residence_type          residence_type NOT NULL DEFAULT 'rent',
  current_address_line1           TEXT,
  current_address_line2           TEXT,
  current_city                    TEXT,
  current_state                   TEXT,
  current_zip                     TEXT,
  current_length_years            INT,
  current_length_months           INT,
  current_reason_for_moving       TEXT,
  -- If renting:
  current_landlord_name           TEXT,
  current_landlord_phone          TEXT,
  current_landlord_email          TEXT,
  current_monthly_rent            NUMERIC(10,2),
  -- If owning:
  current_mortgage_holder         TEXT,                       -- bank name
  current_monthly_mortgage        NUMERIC(10,2),
  current_county_record_ref       TEXT,                       -- deed reference / parcel #
  -- Prior residence (mirrors current; populated if at current < 2 years)
  prior_residence_type            residence_type,
  prior_address_line1             TEXT,
  prior_city                      TEXT,
  prior_state                     TEXT,
  prior_zip                       TEXT,
  prior_landlord_name             TEXT,
  prior_landlord_phone            TEXT,
  prior_landlord_email            TEXT,
  prior_monthly_rent              NUMERIC(10,2),
  prior_mortgage_holder           TEXT,
  -- Employment (current)
  current_employer                TEXT,
  current_employer_phone          TEXT,
  current_supervisor              TEXT,
  current_supervisor_email        TEXT,
  current_position                TEXT,
  current_employment_start        DATE,
  current_monthly_income          NUMERIC(10,2),
  -- Employment (prior, if current < 2 years)
  prior_employer                  TEXT,
  prior_employer_phone            TEXT,
  prior_position                  TEXT,
  prior_employment_start          DATE,
  prior_employment_end            DATE,
  -- Background questions
  has_eviction_history            BOOLEAN,
  eviction_explanation            TEXT,
  has_criminal_history            BOOLEAN,
  criminal_explanation            TEXT,
  has_bankruptcy_history          BOOLEAN,
  bankruptcy_explanation          TEXT,
  -- Status / workflow
  status                          application_status NOT NULL DEFAULT 'pending_payment',
  -- Payment
  payment_app_fee_cents           INT NOT NULL,               -- 7500 (primary) or 5000 (co-app)
  payment_holding_fee_cents       INT,                        -- = security deposit
  payment_stripe_session_id       TEXT,
  payment_stripe_payment_intent   TEXT,
  payment_confirmed_at            TIMESTAMPTZ,
  payment_confirmed_by            UUID REFERENCES profiles(id),
  -- VA assignment
  va_assigned_to                  UUID REFERENCES profiles(id),
  -- Broker decision
  broker_decision                 broker_decision,
  broker_decision_at              TIMESTAMPTZ,
  broker_decision_by              UUID REFERENCES profiles(id),
  broker_decision_notes           TEXT,
  approval_with_conditions        JSONB,                      -- e.g. {"additional_deposit": 500, "co_signer_required": true}
  denial_reasons                  JSONB,                      -- FCRA-compliant reason codes
  -- Term sheet / lease windows
  term_sheet_sent_at              TIMESTAMPTZ,
  term_sheet_acceptance_deadline  TIMESTAMPTZ,                -- 3 biz days from sent
  term_sheet_response             term_response,
  term_sheet_response_at          TIMESTAMPTZ,
  lease_signing_due               TIMESTAMPTZ,                -- 3 biz days from acceptance, broker-adjustable
  lease_signing_scheduled_at      TIMESTAMPTZ,
  orientation_scheduled_at        TIMESTAMPTZ,
  move_in_at                      TIMESTAMPTZ,
  -- Withdrawal / refund
  withdrawn_at                    TIMESTAMPTZ,
  refund_amount_cents             INT,
  refund_paid_at                  TIMESTAMPTZ,
  -- Signature timestamp (e-sig of application form)
  signed_at                       TIMESTAMPTZ,
  signed_ip                       TEXT,
  signed_user_agent               TEXT,
  -- Audit
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_apps_property ON applications(property_id);
CREATE INDEX IF NOT EXISTS idx_apps_showing_agent ON applications(showing_agent_id);
CREATE INDEX IF NOT EXISTS idx_apps_listing_agent ON applications(listing_agent_id);
CREATE INDEX IF NOT EXISTS idx_apps_va ON applications(va_assigned_to);
CREATE INDEX IF NOT EXISTS idx_apps_email ON applications(email);
CREATE INDEX IF NOT EXISTS idx_apps_confirmation ON applications(confirmation_number);
CREATE INDEX IF NOT EXISTS idx_apps_primary ON applications(primary_application_id) WHERE primary_application_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_apps_touch_updated ON applications;
CREATE TRIGGER trg_apps_touch_updated
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- application_documents — uploaded files per application
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  doc_type            document_type NOT NULL,
  file_name           TEXT NOT NULL,
  file_size_bytes     BIGINT,
  mime_type           TEXT,
  storage_path        TEXT NOT NULL,                  -- bucket: application-docs
  signed              BOOLEAN NOT NULL DEFAULT FALSE,
  e_sign_envelope_id  TEXT,                           -- Dropbox Sign envelope (Phase 3)
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by         UUID REFERENCES profiles(id),
  -- VA review
  va_status           TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'verified' | 'issue' | 'missing'
  va_notes            TEXT,
  va_reviewed_at      TIMESTAMPTZ,
  va_reviewed_by      UUID REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_appdocs_app ON application_documents(application_id);
CREATE INDEX IF NOT EXISTS idx_appdocs_type ON application_documents(doc_type);

-- ----------------------------------------------------------------
-- application_co_applicants — list of co-apps on a primary app
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_co_applicants (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  full_name               TEXT NOT NULL,
  email                   TEXT,
  phone                   TEXT,
  relationship            TEXT,                       -- 'spouse' | 'partner' | 'roommate' | 'family'
  their_application_id    UUID REFERENCES applications(id),  -- once they apply separately
  invite_sent_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_co_apps_app ON application_co_applicants(application_id);

-- ----------------------------------------------------------------
-- application_pets — per-pet records on an application
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_pets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  pet_type            TEXT NOT NULL,                  -- 'dog' | 'cat' | 'bird' | 'fish' | 'other'
  breed               TEXT,
  weight_lb           NUMERIC(5,1),
  age_years           NUMERIC(4,1),
  gender              TEXT,
  fixed               BOOLEAN,
  designation         TEXT NOT NULL DEFAULT 'pet',    -- 'pet' | 'service' | 'esa'
  vet_cert_doc_id     UUID REFERENCES application_documents(id),
  photo_doc_id        UUID REFERENCES application_documents(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pets_app ON application_pets(application_id);

-- ----------------------------------------------------------------
-- application_vehicles
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_vehicles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  make            TEXT,
  model           TEXT,
  year            INT,
  color           TEXT,
  license_plate   TEXT,
  state           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_app ON application_vehicles(application_id);

-- ----------------------------------------------------------------
-- application_signatures — granular per-checkbox/per-disclosure record
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_signatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  signer_role     TEXT NOT NULL,                      -- 'applicant' | 'landlord_acknowledged'
  field_name      TEXT NOT NULL,                      -- 'auth_screen' | 'auth_share' | 'lead_paint_disclosure' etc.
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      TEXT,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sigs_app ON application_signatures(application_id);

-- ----------------------------------------------------------------
-- application_references — personal + credit references
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_references (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  reference_type  TEXT NOT NULL,                      -- 'personal' | 'credit'
  full_name       TEXT NOT NULL,
  relationship    TEXT,
  phone           TEXT,
  email           TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refs_app ON application_references(application_id);
