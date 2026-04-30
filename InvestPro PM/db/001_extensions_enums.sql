-- ============================================================
-- 001 — Extensions and Enum Types
-- ============================================================
-- Run first. Sets up UUID generation and all the controlled-vocabulary
-- enums used throughout the schema. Keeping these centralized means a typo
-- in a status string fails at write time, not silently corrupts data.

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------
-- Role enum — the 12 platform roles defined in PM-PLATFORM-PLAN §2
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    -- Internal staff
    'broker',           -- Kenny: final approval, owner relationships, vendor approvals
    'va',               -- Virtual Admin: application processor (NOT Mandy)
    'accounting',       -- Jeff: payment confirmation, ACH, owner statements
    'compliance',       -- Mandy: deposit disposition, document filing, evictions
    'leasing',          -- Leasing coordinator: showings, application coord
    'pm_service',       -- Savan: maintenance dispatch, inspections (Phase 6+)
    'admin_onsite',     -- Front-desk admin assistant
    -- External
    'applicant',        -- Active rental applicant (becomes tenant on lease)
    'tenant',           -- Current tenant
    'owner',            -- Property owner / our PMA client
    'agent_listing',    -- Listing agent on the property
    'agent_showing'     -- Showing agent who brings the applicant
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Property statuses
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE property_status AS ENUM (
    'vacant',                   -- ready to list
    'listed',                   -- on MLS, accepting applications
    'application_in_progress',  -- holding fee paid, processing
    'leased',                   -- under active lease
    'renewal_pending',          -- 60 days before lease end
    'off_market'                -- not currently leasing
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Application statuses (the workflow state machine)
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE application_status AS ENUM (
    'pending_payment',          -- form submitted, Stripe checkout pending
    'payment_attempted',        -- Stripe attempted but not confirmed by Accounting
    'payment_confirmed',        -- Accounting confirmed, VA can start
    'va_review',                -- VA reviewing documents
    'screening_in_progress',    -- VOR/VOE/credit underway
    'summary_ready',            -- VA finalized summary, queued for Broker
    'broker_review',            -- Awaiting Kenny's decision
    'approved',                 -- Approved (term sheet pending generation)
    'denied',                   -- Denied (FCRA letter pending send)
    'offer_sent',               -- Term sheet sent to applicant
    'offer_accepted',           -- Applicant accepted term sheet
    'offer_declined',           -- Applicant declined; holding fee refunded
    'offer_countered',          -- Applicant countered; broker reviewing
    'lease_drafting',           -- Leasing coordinator drafting lease
    'lease_sent',               -- Lease sent for signature
    'lease_signed',             -- Lease fully executed
    'leased',                   -- Tenant moved in (terminal happy state)
    'withdrawn',                -- Applicant withdrew
    'refunded'                  -- Holding fee refunded (terminal)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Applicant role on a specific application
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE applicant_role AS ENUM ('primary', 'co_applicant');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Current residence type — branches the verification path
-- (Added per Joan's review 2026-04-28: applicants who own need a
-- different verification path than renters)
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE residence_type AS ENUM ('rent', 'own');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Verification types and statuses
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE verification_type AS ENUM (
    'vor_current',                  -- Verification of Rental, current address
    'vor_prior',                    -- VOR, prior address
    'property_ownership_current',   -- For homeowners: ownership verification, current address
    'property_ownership_prior',     -- Same, prior address
    'voe_current',                  -- Verification of Employment, current
    'voe_prior',                    -- VOE, prior
    'credit',                       -- Credit report (SmartMove / RentSpree / manual)
    'background',                   -- Background check (often bundled with credit)
    'pet_screening',                -- PetScreening.com result
    'bank_verification'             -- Plaid or manual bank statement review
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM (
    'not_sent',
    'sent',
    'reminded',     -- SLA breach, reminder sent
    'received',
    'failed',       -- timed out or refused
    'overrode'      -- VA overrode (e.g., couldn't reach landlord, marking complete)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Communications channel + direction + call outcomes
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE comm_direction AS ENUM ('outbound', 'inbound');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE comm_channel AS ENUM ('email', 'sms', 'call', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE call_outcome AS ENUM ('left_voicemail', 'spoke', 'refused', 'no_answer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Task statuses (for VA work queue items)
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('open', 'in_progress', 'done', 'overdue');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_type AS ENUM (
    'doc_review',
    'run_credit',
    'send_vor',
    'send_voe',
    'send_property_ownership_check',
    'call_landlord',
    'call_employer',
    'finalize_summary',
    'wait_for_response',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Term sheet response + broker decision
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE term_response AS ENUM ('accept', 'decline', 'counter');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE broker_decision AS ENUM ('approve', 'approve_with_conditions', 'deny');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE recommendation AS ENUM ('approve', 'approve_with_conditions', 'deny');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Calendar event types
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE calendar_event_type AS ENUM ('lease_signing', 'orientation', 'move_in_inspection');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------
-- Document types (uploaded by applicants)
-- ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE document_type AS ENUM (
    'gov_id',
    'paystub',
    'bank_statement',
    'mortgage_statement',     -- For homeowners (Joan's flag)
    'pet_vet_cert',
    'pet_photo',
    'esa_letter',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
