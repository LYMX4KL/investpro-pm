-- ============================================================
-- 007 — Email Templates + Seeds
-- ============================================================
-- Versioned email templates. Editable by Broker via /portal/broker/templates.
-- Includes seed templates from PM-PLATFORM-DEEP-DIVES §3 sample templates.

-- ----------------------------------------------------------------
-- email_templates — versioned templates with variable substitution
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key    TEXT NOT NULL,                                -- 'vor_request_to_landlord' | 'denial_letter' | etc.
  version         INT NOT NULL DEFAULT 1,
  subject         TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  body_html       TEXT,
  -- Variables this template expects, e.g. ["applicant_first_name", "property_address"]
  variables       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Channel: most templates are email, but a few are SMS too
  channel         comm_channel NOT NULL DEFAULT 'email',
  -- Default recipients beyond the primary `to`
  default_cc      JSONB,                                        -- ["accounting@investprorealty.net"] for owner emails
  default_bcc     JSONB,                                        -- ["savan@", "jeff@", "mandy@"] for tenant emails
  -- Lifecycle
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES profiles(id),
  -- Only one active version per key
  UNIQUE (template_key, version)
);

CREATE INDEX IF NOT EXISTS idx_templates_key_active ON email_templates(template_key, active) WHERE active = TRUE;

DROP TRIGGER IF EXISTS trg_templates_touch_updated ON email_templates;
CREATE TRIGGER trg_templates_touch_updated
  BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------
-- Seed templates (from PM-PLATFORM-DEEP-DIVES §3)
-- ----------------------------------------------------------------

INSERT INTO email_templates (template_key, version, subject, body_text, variables) VALUES
('application_received_applicant', 1,
'{{property_address}} – Application Received',
$$Hi {{applicant_first_name}},

We''ve received your application for {{property_address}}. Your
confirmation number is {{confirmation_number}}.

What happens next:
1. Our accounting team will confirm your payment (usually same business day).
2. Your documents are reviewed by our processor.
3. We''ll contact your landlord and employer to verify the information.
4. We''ll pull credit and background reports.
5. You''ll hear from us with a decision within 48 business hours of when both
   the application AND fee payment are received (per Master P&P Manual Ch. 6.3).

If we need anything else, we''ll email you. You can also check status
anytime: {{status_url}}

Questions? Reply to this email or call 702-816-5555.

— InvestPro Realty$$,
'["applicant_first_name", "property_address", "confirmation_number", "status_url"]'::jsonb)
ON CONFLICT (template_key, version) DO NOTHING;

INSERT INTO email_templates (template_key, version, subject, body_text, variables) VALUES
('vor_request_to_landlord', 1,
'{{property_address}} – Verification of Rental for {{applicant_full_name}}',
$$Hello {{landlord_name}},

{{applicant_full_name}} has applied for {{property_address}} and listed
you as their current landlord at {{their_current_address}}.

Could you please complete the brief verification form linked below? It
takes 2-3 minutes:

   {{vor_form_url}}

If you''d prefer to call, you can reach our processor at 702-816-5555.

This information helps us process the application within our 48-hour
service standard. Thank you!

— InvestPro Realty$$,
'["landlord_name", "applicant_full_name", "property_address", "their_current_address", "vor_form_url"]'::jsonb)
ON CONFLICT (template_key, version) DO NOTHING;

-- New template (Joan's flag): for homeowner-applicants, request property ownership verification instead of VOR
INSERT INTO email_templates (template_key, version, subject, body_text, variables) VALUES
('property_ownership_check', 1,
'{{property_address}} – Property Ownership Verification for {{applicant_full_name}}',
$$Hello,

{{applicant_full_name}} has applied for {{property_address}} and listed
you as the mortgage holder for their current home at {{their_current_address}}.

We are processing their rental application and need brief verification of
their mortgage status. Could you complete the form linked below?

   {{verification_form_url}}

If you''d prefer to call, you can reach our processor at 702-816-5555.

Thank you!

— InvestPro Realty$$,
'["applicant_full_name", "property_address", "their_current_address", "verification_form_url"]'::jsonb)
ON CONFLICT (template_key, version) DO NOTHING;

INSERT INTO email_templates (template_key, version, subject, body_text, variables, default_cc) VALUES
('owner_application_received', 1,
'{{property_address}} – Application Received',
$$Hi {{owner_first_name}},

We''ve received an application for your property at {{property_address}}.
We''ll process screening over the next 48 business hours and follow up
with our recommendation.

We''ll send you a recommendation summary once screening is complete —
no detailed personal information of the applicant will be shared, per
our privacy policy.

— InvestPro Realty$$,
'["owner_first_name", "property_address"]'::jsonb,
'["accounting@investprorealty.net"]'::jsonb)
ON CONFLICT (template_key, version) DO NOTHING;

INSERT INTO email_templates (template_key, version, subject, body_text, variables, default_cc) VALUES
('owner_recommendation_approve', 1,
'{{property_address}} – Approval Recommended',
$$Hi {{owner_first_name}},

Screening is complete for the application on {{property_address}} and
we recommend approval.

Summary of our findings (no personal details per our privacy policy):
- Income: meets our 3x rent requirement
- Credit: above our minimum threshold
- Rental history: positive verification from current landlord
- Background: clean

We''ll proceed with the term sheet to the applicant unless you respond
within 24 hours with concerns. Standard terms apply per your
management agreement.

Move-in target: {{anticipated_move_in_date}}

— InvestPro Realty$$,
'["owner_first_name", "property_address", "anticipated_move_in_date"]'::jsonb,
'["accounting@investprorealty.net"]'::jsonb)
ON CONFLICT (template_key, version) DO NOTHING;

-- Add link FK from verifications.template_id to email_templates.id (couldn't add in 005 — circular)
DO $$ BEGIN
  ALTER TABLE verifications
    ADD CONSTRAINT verifications_template_fk
    FOREIGN KEY (template_id) REFERENCES email_templates(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
