# InvestPro PM Platform — Architecture Plan

**Status:** Draft v1 · 2026-04-27
**Source policies:** Master P&P Manual (`17sKQpSjBqeH1SI-RY6j5RaekpVSRZ6HC`), GLVAR Rev. 11.19 Rental Application, plus Kenny's 2026-04-27 vision update.

This is the structure spec to build against. Read this BEFORE writing any code in
upcoming sessions. Any deviation is a decision to discuss with Kenny first.

---

## 1. What we're building

A property-management platform built **into** investprorealty.net, not bolted on. Every
PM action originates from and is logged in the platform: applicant submission, agent
introductions, document signing, payment confirmation, verifications (VOR/VOE/credit/
background/pet), screening summary generation, PM/owner approval, term-sheet send +
acceptance, lease scheduling/signing, owner archive, tenant onboarding, and post-signing
review requests.

Manual processes today (Buildium + K-Drive + IP Rentals spreadsheet + Constant Contact +
Monday.com + email + Mandy's manual VOR sends) get consolidated into one app with
explicit role-based dashboards, automated outbound messaging, AI-assisted result
parsing, and a complete audit trail per application.

**Scope boundary** for this plan:
- ✅ Application → screening → approval → lease → move-in (Phase 1–5)
- ✅ Agent registration + MLS-driven auto-populate
- ✅ Owner notifications (privacy-respecting)
- ⚠️ Maintenance, rent collection, owner statements, evictions, renewals — design
  considers them but builds in later phases (6+)

---

## 2. Real roles (mapped from the Master P&P Manual)

The manual reveals 7 named roles (plus Broker). The platform's role model **must mirror
this**, not invent simpler abstractions. Critical distinction: the person titled
"Property Manager" (Savan) handles **maintenance only** — not leases. Application/
screening/lease work runs through VA + Leasing Coordinator + Accounting + Broker.

| Platform role | Maps to (manual) | Person today | Primary responsibilities in the platform |
|---|---|---|---|
| `broker` | Broker / Owner | Kenny | Final approval/denial of applications, sets renewal rates, reviews legal/eviction matters, approves vendor quotes above threshold, owner relationships |
| `pm_service` | Property Manager / Service Coordinator | Savan | Maintenance dispatch, inspections (move-in/out/annual), turnovers, vendor coord. (Phase 6+ scope; not in initial app workflow.) |
| `accounting` | Accounting | Jeff | Confirms payment receipt (app fee + holding fee), posts ledger entries, ACH owner draws, reviews renewal letters, owner phone-followup escalation |
| `compliance` | Admin / Compliance | Mandy | Final tenant statement reviewer, deposit-disposition compliance, document filing, eviction prep. **Note: Mandy is COMPLIANCE, not the application VA Kenny mentioned.** |
| `admin_onsite` | Admin Assistant (On-Site) | (TBD) | Front-desk walk-ins, accepts in-office payments, key inventory/lockbox board, hard-copy filing, mails physical notices |
| `va` | Virtual Admin Assistant | (TBD — separate from Mandy) | **THE application processor.** Verifies application docs, runs credit (APM/SmartMove), sends VOR & VOE, follow-up calls, prepares Screening Summary, forwards to Broker |
| `leasing` | Leasing Coordinator | (TBD) | MLS/Zillow/Apartments listings, conducts showings, coordinates application process from inquiry → approval. Overlaps with VA on application work. |
| `applicant` | Applicant | external | Submits application, signs forms, pays fees, accepts/rejects/counters term sheet, signs lease |
| `tenant` | Tenant (post-lease) | external | Pays rent, submits maintenance, views lease/payment history, gets renewal notices |
| `owner` | Owner | external | Receives application updates (recommendation only, no raw screening data), monthly statements, ACH draws, renewal-rate decisions, vendor approvals, year-end 1099 |
| `agent_listing` | Listing Agent | external | Lists property on MLS, may conduct move-out inspections |
| `agent_showing` | Showing Agent | external | Shows property to applicants, brings them through the application |

**Key clarifications Kenny confirmed:**
- The "VA" who does application work is **NOT Mandy**. Mandy is Admin/Compliance. We need a separate VA persona/account.
- "Accounting" is a separate gate from VA. Payment must be confirmed by Accounting before VA proceeds with screening.

**Platform permission matrix (high level):**

| Action | broker | va | accounting | compliance | leasing | pm_service | applicant | tenant | owner | agent |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View all applications | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — |
| Confirm payment received | — | — | ✅ | — | — | — | — | — | — | — |
| Run credit check / send VOR/VOE | — | ✅ | — | — | ✅ | — | — | — | — | — |
| Generate Screening Summary | — | ✅ | — | — | — | — | — | — | — | — |
| Approve/deny application | ✅ | — | — | — | — | — | — | — | — | — |
| Generate/send term sheet | — | ✅ | — | — | ✅ | — | — | — | — | — |
| Adjust default 3-day lease-sign window | ✅ | — | — | — | — | — | — | — | — | — |
| View own application | — | — | — | — | — | — | ✅ | — | — | — |
| View own listings/applications referred | — | — | — | — | — | — | — | — | — | ✅ |
| View own properties (no PII) | — | — | — | — | — | — | — | — | ✅ | — |

---

## 3. Hard rules from the Master P&P Manual (non-negotiable in the platform)

These are quoted directly from the manual. The platform's defaults must respect them.

| Rule | SLA / Value | Source |
|---|---|---|
| Application processing time | **48 business hours** of complete app | Ch. 6.3 |
| Income requirement | **3× monthly rent** (combined gross) | Ch. 6.2.1 |
| Application fees | **$75 first / $50 each co-applicant** | Ch. 6.1 |
| Denial letter sent | **within 3 business days** of decision (FCRA adverse action) | Ch. 6.4 |
| Term sheet acceptance + holding fee | **3 business days** | Ch. 7.4 |
| Holding fee | **= security deposit** (typically 1 month rent) | Ch. 7.3 |
| Lease signing window | **3 business days** of receiving docs | Ch. 8.2 |
| Initial move-in payment | **certified funds only** (cashier's check or money order) | Ch. 8.2 |
| Move-In Condition Report | tenant returns **within 3 days of key release** | Ch. 9.2 |
| Lease processing fee | **$800** | Ch. 7.2 |
| Late fee | **5% of monthly rent**, assessed on the 6th | Ch. 11.1, Addendum #3 §1 |
| Trash service (tenant-paid) | $19/mo (\$31 if pool: sewer is $28/$31) | Ch. 21.1 |
| Tenant-caused repair markup | **15% admin fee** on cost | Ch. 15.6 |
| Renewal rate notice | **60+ days before** lease end (NV law) | Ch. 13.1 |
| Annual inspection notice | **24 hours** minimum | NV law / Ch. 17 |
| Owner non-response escalation | 24h email follow-up → another 24h → Jeff calls | Ch. 24.3 |
| Email standards | `[Property Address] – [Keyword]` subject | Ch. 39 |
| Tenant emails | BCC Savan, Jeff, Mandy | Ch. 39 |
| Owner emails | CC Accounting | Ch. 39 |
| **Never** email tenant + owner together | enforced in send code | Ch. 39 |
| Renewal preconditions | $0 balance + carpet shampoo receipt + filter + smoke detector test + satisfactory inspection | Addendum #3 §7 |
| Service emergency (gas/flood/fire/no heat) | immediate dispatch 24/7 | Ch. 15.2 |
| Service urgent (no hot water, HVAC extreme) | same business day | Ch. 15.2 |
| Service routine | 1–3 business days | Ch. 15.2 |

These become **defaults + validation rules** in the platform. Kenny can override per-property where allowed (e.g., he can extend the lease-signing window if a property has been on market a long time).

---

## 4. Data model (Supabase tables)

Core entities:

```
auth_users (Supabase auth)
  └─ profiles (1:1)
       role: broker | va | accounting | compliance | leasing | pm_service
            | applicant | tenant | owner | agent_listing | agent_showing | admin_onsite
       full_name, phone, email_verified, sms_opt_in, created_at

agents
  └─ profile_id (FK to profiles)
       license_number (NV S./B.)
       mls_member_id
       brokerage_name, brokerage_license, brokerage_address
       w9_received (bool), w9_storage_path
       commission_split_default_pct
       created_at, last_synced_with_mls_at

properties
  ├─ property_id (uuid)
  │  address_line1, address_line2, city, state, zip
  │  property_type, bedrooms, bathrooms, sqft, year_built
  │  monthly_rent, security_deposit_amount, pet_deposit_amount
  │  pets_allowed (none/cats/dogs/case-by-case)
  │  hoa_name, hoa_dues, has_pool
  │  mls_listing_id (FK to MLS feed)
  │  owner_id (FK to profiles where role=owner)
  │  listing_agent_id (FK to agents)
  │  pm_group ("KL" subgroup tag — Kenny Group properties)
  │  status: vacant | listed | application_in_progress | leased | renewal_pending
  │  days_on_market_started_at
  │  default_lease_signing_window_days (3, broker can override)
  └─ listing_at (date listed)

applications
  ├─ id, confirmation_number ("IPR-XXXXXXX")
  │  property_id (FK)
  │  applicant_role: primary | co_applicant
  │  primary_application_id (FK self — for co-apps to link to primary)
  │  showing_agent_id (FK agents — nullable)
  │  listing_agent_id (FK agents — copied from property)
  │  referral_company (text — separate from agent)
  │  status: pending_payment | payment_confirmed | va_review | screening_in_progress
  │          | summary_ready | broker_review | approved | denied | offer_sent
  │          | offer_accepted | offer_declined | offer_countered
  │          | lease_drafting | lease_sent | lease_signed | leased | withdrawn | refunded
  │  signed_at (timestamp — applicant's e-sig timestamp)
  │  payment_app_fee_cents, payment_holding_fee_cents
  │  payment_confirmed_at (set by Accounting)
  │  payment_confirmed_by (FK profiles)
  │  va_assigned_to (FK profiles)
  │  broker_decision_at, broker_decision_by, broker_decision_notes
  │  approval_with_conditions (jsonb — e.g. {"additional_deposit": 500})
  │  term_sheet_sent_at, term_sheet_acceptance_deadline (3 biz days from sent)
  │  term_sheet_response: accept | reject | counter | (null)
  │  term_sheet_counter (jsonb — applicant's counter terms)
  │  lease_signing_due (3 biz days from acceptance, broker-adjustable)
  │  lease_signing_scheduled_at, orientation_scheduled_at, move_in_at
  │  withdrawn_at, refund_amount_cents, refund_paid_at
  │  ts (created)
  │  → JSON blob with all GLVAR field data (employment, refs, household, etc.)

application_documents
  application_id (FK), doc_type, file_name, storage_path, signed (bool),
  e_sign_envelope_id (FK to esign_envelopes), uploaded_at, uploaded_by

application_co_applicants  -- denormalized list of co-app contacts on primary app
  application_id (FK primary), name, email, phone, relationship,
  their_application_id (FK applications — if they've applied separately)

application_pets
  application_id, name, type, breed, weight_lb, age, gender, fixed (bool),
  designation: pet | service | esa
  vet_cert_doc_id, photo_doc_id

application_signatures  -- one row per checkbox/signature acknowledgment
  application_id, signer_role: applicant | landlord_acknowledged
  field_name, signed_at, ip_address, user_agent

verifications
  application_id (FK)
  type: vor_current | vor_prior | voe_current | voe_prior | credit | background | pet_screening | bank_verification
  status: not_sent | sent | reminded | received | failed | overrode
  sent_to_email, sent_to_phone
  template_id (FK to email_templates), envelope_id (FK to esign if signed form)
  sent_at, last_reminder_sent_at, received_at, sla_due_at
  result_payload (jsonb — raw response or admin-uploaded PDF link)
  ai_parsed_summary (jsonb — Claude/AI-extracted fields: rent_paid_on_time, would_rerent, etc.)
  va_verified_by, va_notes

screening_reports
  application_id (FK, unique)
  meets_3x_income (bool, computed)
  credit_score (int, from APM/SmartMove)
  derogatory_summary (jsonb)
  background_summary (text)
  vor_summary (text — AI-generated from verifications)
  voe_summary (text — AI-generated from verifications)
  pet_screening_summary (text — from PetScreening.com)
  recommendation: approve | approve_with_conditions | deny
  ai_generated_at, va_finalized_at, va_finalized_by

communications  -- the audit log
  application_id (FK)
  direction: outbound | inbound
  channel: email | sms | call | system
  from_email, to_email, subject, body_html, body_text
  call_logged_by (FK profiles), call_outcome (left_voicemail | spoke | refused | no_answer)
  thread_id (string — for grouping email reply chains)
  attachments (jsonb)
  sent_at, received_at, read_by_va (bool)

tasks  -- VA work queue
  id, application_id (FK)
  type: doc_review | run_credit | send_vor | send_voe | call_landlord | call_employer
       | finalize_summary | wait_for_response | other
  assigned_to (FK profiles, defaults to active VA)
  status: open | in_progress | done | overdue
  due_at (sla-driven)
  created_at, completed_at, completed_by

term_sheets
  id, application_id (FK)
  monthly_rent, security_deposit, pet_deposit, lease_processing_fee, prorated_rent
  lease_term_months, lease_start, lease_end
  pet_rent_monthly, additional_terms (jsonb)
  esign_envelope_id, sent_at, acceptance_deadline
  applicant_response: accept | reject | counter
  applicant_counter (jsonb)
  broker_response_to_counter: accept | reject (broker reviews counter)

leases
  id, application_id (FK), property_id (FK)
  tenant_ids (jsonb — array of profile_ids of all tenants who signed)
  start_date, end_date, monthly_rent, security_deposit_held
  esign_envelope_id, fully_executed_at
  pdf_storage_path
  addendums_signed (jsonb — addendum_3, pool_addendum, esa_addendum, etc.)
  buildium_lease_id (text — for sync to existing system, optional)

calendar_events  -- lease signing, orientation, move-in
  application_id (FK)
  type: lease_signing | orientation | move_in_inspection
  scheduled_at, location, attendees (jsonb of profile_ids/emails)
  ics_sent_at, reminder_24h_sent_at
  completed (bool), completed_at

reviews  -- post-lease review request
  application_id (FK), recipient_email, recipient_role
  sent_at, response_received_at, rating (1-5), comment

mls_listings  -- pulled from MLS API daily
  mls_id (PK), address, photos, beds/baths/sqft, listing_agent_id, last_synced_at

email_templates  -- versioned, editable by Broker
  key: vor_request_to_landlord | voe_request_to_employer | denial_letter
     | term_sheet | welcome_tenant | thank_you_agent | application_received_owner
     | screening_complete_owner | etc.
  version, subject, body_html, variables (jsonb of placeholders)
  active (bool), updated_at, updated_by
```

**Storage buckets (Supabase Storage):**
- `application-docs/` — applicant-uploaded ID, paystubs, bank stmts, pet vet certs, photos
- `verification-results/` — uploaded VOR/VOE PDFs (when manually returned), credit/background reports
- `signed-documents/` — fully-signed term sheets, leases, addendums (from e-sign provider)
- `screening-summaries/` — generated PDFs of Screening Summary Report
- `communications/` — saved email/sms transcripts (optional; metadata in DB)

---

## 5. User journeys

### 5.1 Applicant journey
1. Lands on listing → clicks "Apply" → form pre-fills property + agent info from URL params
2. Fills the 13-section form (current site)
3. Adds pet details + acknowledgments (if any)
4. Uploads ID, paystubs, bank statements, pet docs
5. **E-signs** the application within the app (HelloSign embedded or Dropbox Sign)
6. **Pays** via Stripe Checkout: app fee ($75 or $50) + holding fee
7. Lands on confirmation page with confirmation # and timeline
8. Checks status anytime via `/forms/application-status.html` (confirmation # + email)
9. Gets emails at each milestone (received, payment confirmed, screening in progress, decision, term sheet sent)
10. **If approved:** clicks term sheet email → reviews → e-signs accept (or rejects, or counters)
11. Receives calendar invite for lease signing + orientation
12. Signs lease (e-sign), schedules move-in
13. Receives welcome email + tenant portal login info
14. ~14 days post move-in: review request

### 5.2 Showing/Listing Agent journey
1. **Registers free** at `/agent-register` → confirms NV license + MLS member ID
2. MLS API verifies license/membership → account auto-approved if valid
3. Gets a **personal share link** for each property: `https://investpro-realty.netlify.app/listing/123?agent=AGT-X9F2`
4. Sends share link to client → client opens application with **agent info pre-populated**
5. Receives email when application submitted on a property they shared
6. Receives email when payment confirmed, when screening complete, and final decision
7. Sees a personal dashboard at `/portal/agent` with: properties they referred + status of each application + commission ledger
8. After lease signs: receives thank-you email + 1099 reminder
9. Year-end: 1099 issued automatically (electronic + mailed copy)

### 5.3 VA journey (the application processor)
1. Logs in → sees **work queue** of applications by status
2. Clicks on an application in `payment_confirmed` status → opens Application Detail page
3. **Document review tab:** sees uploaded docs, marks each as verified/missing/issue. Each doc has a checkbox.
4. Once docs pass → status moves to `screening_in_progress`
5. **Verifications tab:** clicks "Send VOR to current landlord" → confirmation modal → email sent via SendGrid/Resend with templated form (signed e-form via HelloSign). Same flow for prior landlord, current/prior employer.
6. SLA timers tick: if no response in 48 hours, task pops up to "Call landlord" — VA logs the call result.
7. **Credit check tab:** clicks "Run credit check via SmartMove" → opens SmartMove embedded screening flow; tenant pays directly through SmartMove or VA pays from InvestPro's account.
8. As verifications return: **Claude AI auto-extracts key fields** (rent paid on time? would re-rent? salary confirmed? employment dates?) into a structured summary that the VA can edit.
9. **Summary tab:** Click "Generate Screening Summary" → AI assembles draft summary. VA edits/finalizes. PDF generated.
10. Click "Submit to Broker for review" → application moves to `broker_review`. Notification sent to Kenny.

### 5.4 Accounting journey
1. Logs in → sees **Payment Confirmation queue** of applications in `pending_payment` or `payment_attempted`
2. For each: sees Stripe payment intent ID, amount, applicant name. Checks the actual deposit in InvestPro's account. Clicks "Confirm received" → application moves to `va_review`
3. VA gets task: new application in queue
4. (Throughout the lease lifecycle) Posts charges, runs ACH owner draws, etc. — Phase 6+

### 5.5 Broker (Kenny) journey
1. Logs in → sees **Decision queue** of applications in `broker_review`
2. Opens an application → reads Screening Summary, sees green/yellow/red flags (income met? credit score? VOR clean?)
3. Three buttons: **Approve · Approve with Conditions · Deny**
   - "Approve with Conditions" opens a modal (additional security deposit? co-signer required?)
   - "Deny" prompts for FCRA-compliant reason codes
4. On Approve: term sheet auto-generates, VA gets task to review/send
5. On Deny: denial letter auto-generates, VA gets task to send within 3 business days
6. Also: Property Manager dashboard shows: properties under management, vacancy rates, applications in flight, agents most active, owner statements pending review
7. Owner relationships, vendor approvals, renewal rates, eviction approvals

### 5.6 Owner journey
1. Logs in → sees **My Properties** dashboard
2. For each property: status, current tenant (if leased), current lease term, monthly rent, last 12 months of rent + expense summary
3. **Application notifications**: when an application is received, owner gets an email (no detail). When PM has a recommendation, owner gets the recommendation only — never raw screening data.
4. **Owner approval gates:** approves rates above threshold, vendor quotes above pre-approved amount, CC&R responses
5. Year-end: 1099 + statements

### 5.7 Tenant journey (post-lease)
1. Receives welcome email + portal login link
2. First login: completes Move-In Condition Report (3-day deadline timer in portal)
3. Sets up auto-pay
4. Submits maintenance requests via portal (with photos)
5. Sees lease docs, payment history, lease end date
6. Renewal notices arrive 60+ days before end
7. Move-out: 30-day notice (must end on the 1st)

---

## 6. Notification matrix

Send-on conditions, recipients, and templates. Owner gets recommendations only — never PII or raw screening data.

| Event | Applicant | Showing Agent | Listing Agent | VA | Accounting | Broker | Owner | Tenant |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Application submitted | ✉️ Confirmation # | ✉️ App on your referral | ✉️ App on your listing | ✉️ Queue alert | ✉️ Payment to confirm | — | — | — |
| Payment confirmed | ✉️ Now in review | — | — | ✉️ Doc review task | — | — | ✉️ App received (no PII) | — |
| All docs verified, screening starts | ✉️ Screening underway | — | — | — | — | — | — | — |
| VOR sent to landlord | — | — | — | — | — | — | — | — |
| VOR received | — | — | — | ✉️ Result in | — | — | — | — |
| VOE received | — | — | — | ✉️ Result in | — | — | — | — |
| Credit returned | — | — | — | ✉️ Result in | — | — | — | — |
| Summary submitted to Broker | — | — | — | — | — | ✉️ Decision needed | — | — |
| **Approved** | ✉️ Term sheet incoming | ✉️ Approved! Term sheet sent | ✉️ Approved | — | — | — | ✉️ Recommend approve | — |
| **Denied** | 📜 FCRA denial letter (within 3 biz days) | ✉️ Update | ✉️ Update | — | — | — | ✉️ Recommend deny | — |
| Term sheet sent | ✉️ Review + e-sign within 3 biz days | ✉️ Term sent | ✉️ Term sent | — | — | — | — | — |
| Term accepted | ✉️ Lease drafting | ✉️ Accepted | ✉️ Accepted | ✉️ Draft lease | — | ✉️ FYI accepted | ✉️ Approved & accepted | — |
| Term countered | — | ✉️ Counter received | — | — | — | ✉️ Review counter | — | — |
| Term rejected | — | ✉️ Declined | ✉️ Declined | — | — | — | ✉️ Declined | — |
| Lease signing scheduled | 📅 Calendar invite + reminder 24h | ✉️ FYI date | ✉️ FYI date | — | — | — | — | — |
| Orientation scheduled | 📅 Calendar invite + reminder 24h | — | — | — | — | — | — | — |
| **Lease fully signed** | ✉️ Welcome packet | ✉️ 🎉 Thank you (+ 1099 reminder) | ✉️ 🎉 Thank you (+ 1099 reminder) | — | ✉️ Set up billing | — | ✉️ Lease copy + new tenant info | ✉️ Welcome + portal login |
| Move-in complete | ✉️ Review request (14 days later) | ✉️ Review request | ✉️ Review request | — | — | — | — | ✉️ Onboarding tips |

**Channel rules:**
- All applicants/tenants/owners/agents: email always; SMS optional (opt-in at registration)
- Internal staff (VA/Accounting/Broker): email + in-app notification
- Calendar invites: ICS attachment + Google Calendar API
- 24h reminder before scheduled events: email + SMS if opted in
- **Tenant emails always BCC Savan, Jeff, Mandy** (per Ch. 39)
- **Owner emails always CC Accounting** (per Ch. 39)
- **Never tenant + owner on same email** — enforced in send service

---

## 7. Integration stack

| Capability | Provider (recommended) | Cost | Why |
|---|---|---|---|
| **Email send/receive** | Resend | $0 (3k/mo free) → $20/mo (50k) | Modern API, reply webhook, simpler than SendGrid |
| **SMS** | Twilio Programmable Messaging | $0.0079/msg US | Industry standard, A2P 10DLC compliant |
| **E-signature** | Dropbox Sign (formerly HelloSign) | $25/mo Standard, ~$0/envelope | Best API + price for small biz; embedded signing UX is clean |
| **Payment** | Stripe Checkout + Connect | 2.9% + $0.30 per txn | Already planned; Connect for agent payouts later |
| **MLS data** | Kenny's existing MLS API (paid) | already paid | Listings + agent verification |
| **Credit check / Background / Eviction** | TransUnion SmartMove (Complete: $49) OR RentSpree ($30–35) | Per-screen, tenant-paid | SmartMove most established; RentSpree cheaper. Kenny said all 4 options should be supported (admin upload PDF + SmartMove + RentSpree + PetScreening.com) — build adapter pattern so VA picks per app |
| **Pet screening** | PetScreening.com | Free for PMs | Tenant pays $20–30 |
| **Bank verification (optional)** | Plaid | $0.20–$0.60/check | Income verification alternative to manual paystubs |
| **Calendar** | Google Calendar API | Free | InvestPro already uses Google Workspace; ICS attachments for non-Google users |
| **AI auto-summary** | Claude API (Anthropic) | ~$0.003 per VOR/VOE summary, ~$0.01 per Screening Summary | Best for structured extraction + summarization. Use claude-haiku-4-5 for speed. |
| **PDF generation** | Puppeteer or pdfkit (free, server-side) OR pdfshift.io ($9/mo for 250 PDFs) | varies | For Term Sheet, denial letter, Screening Summary PDFs |
| **Doc storage** | Supabase Storage | Included in Supabase plan | Centralizes all uploads + signed docs |
| **Database + auth** | Supabase Postgres + Auth | $0 → $25/mo Pro | Already planned |
| **Hosting** | Netlify (current) | $0 free tier | Static frontend; Edge Functions handle webhooks |

**Estimated all-in monthly recurring cost (excluding per-screen credit checks which tenant pays):**
- Free tier (low volume): ~$25/mo (Dropbox Sign Standard) + Resend free + Twilio low cost
- Active production (5–20 apps/mo): ~$50–80/mo
- + ~$0.05/application in AI tokens for summaries
- Credit checks: $30–49/applicant, paid by tenant (or pass through)

---

## 8. Page / screen inventory

### 8.1 Public site (already mostly built)
- `/` Homepage
- `/property-management.html` PM hub
- `/owner-services.html`, `/tenant-services.html`
- `/listings.html`, `/property-detail.html?id=X` (refactor to dynamic)
- `/sales.html`, `/recruiting.html`, `/about.html`, `/contact.html`
- `/forms/rental-application.html` (current, needs MLS auto-populate)
- `/forms/application-submitted.html`, `/forms/application-status.html`
- `/forms/maintenance-request.html`, `/forms/listing-inquiry.html`

### 8.2 Agent portal (NEW — Phase 2)
- `/portal/agent/register` Registration form (license #, MLS ID, brokerage)
- `/portal/agent/login` Login (Supabase auth)
- `/portal/agent/dashboard` Properties referred + apps in flight + commission ledger
- `/portal/agent/properties/[id]` Per-property: applications referred, status, share link
- `/portal/agent/share-link-generator` Generate trackable share URL with `?agent=X` param
- `/portal/agent/profile` Update license/MLS/brokerage info, upload W-9
- `/portal/agent/1099` Year-end form download

### 8.3 Applicant flow extensions (Phase 1B/2)
- `/forms/rental-application.html` — auto-populate from `?property=X&agent=Y` URL params
- `/forms/term-sheet/[id]` Sign-off page (e-sign embedded, accept/reject/counter)
- `/forms/lease-signing/[id]` Lease e-sign embedded
- `/forms/co-applicant-invite/[id]` Invite link for co-applicants to apply linked

### 8.4 VA dashboard (NEW — Phase 2-3)
- `/portal/va/dashboard` Work queue (open tasks + applications by status)
- `/portal/va/applications/[id]` Application detail (tabs: docs, verifications, summary, comms log)
- `/portal/va/applications/[id]/send-vor` Send VOR — picks landlord email + template + e-sign envelope
- `/portal/va/applications/[id]/send-voe` Same for VOE
- `/portal/va/applications/[id]/run-screening` Trigger SmartMove/RentSpree
- `/portal/va/applications/[id]/log-call` Log a phone call manually
- `/portal/va/applications/[id]/finalize-summary` Review AI-drafted summary, edit, submit to Broker

### 8.5 Accounting dashboard (NEW — Phase 2)
- `/portal/accounting/payment-queue` Confirm Stripe payments received
- `/portal/accounting/refunds` Issue holding fee refunds (denied applications)
- `/portal/accounting/owner-statements` (Phase 6+)
- `/portal/accounting/ach-disbursements` (Phase 6+)
- `/portal/accounting/1099` Year-end agent + owner 1099 generation

### 8.6 Broker (Kenny) dashboard (NEW — Phase 2)
- `/portal/broker/decisions` Apps awaiting decision
- `/portal/broker/applications/[id]` Detail w/ Approve · Approve-with-Conditions · Deny
- `/portal/broker/properties` All properties + vacancies + days on market
- `/portal/broker/agents` Agent activity
- `/portal/broker/owners` Owner relationships
- `/portal/broker/renewals` Renewal queue (60-75 days out)
- `/portal/broker/templates` Edit email/letter templates
- `/portal/broker/reports` Operational metrics

### 8.7 Owner portal (extends current)
- `/portal/owner/dashboard` already exists — add: pending recommendations, vendor approvals, renewal rate input
- `/portal/owner/properties/[id]` Per-property
- `/portal/owner/applications` List of recommendations (no PII)

### 8.8 Tenant portal (extends current)
- `/portal/tenant/dashboard` already exists — add: Move-In Condition Report (3-day countdown), maintenance request queue, lease end countdown, renewal flow

### 8.9 Compliance / On-site Admin / PM-Service dashboards (Phase 6+)
- `/portal/compliance/final-statements` Mandy's deposit-disposition review queue
- `/portal/admin-onsite/walkin` Front-desk tools
- `/portal/pm-service/maintenance-queue` Savan's dispatch board

---

## 9. Phased build sequence

**Phase 1 — DONE.** Public site, application form (GLVAR-aligned), status tracker, demo portal logins, preview gate, Netlify deploy.

**Phase 2 — Agent registration + Auth foundation + Role dashboards skeletons** (3–4 sessions)
- Build `/portal/agent/register` + `login` + `dashboard` pages (Supabase auth + agents table)
- Add role-based routing to existing portal pages (so VA/Accounting/Broker land on different dashboards)
- MLS API integration: agent verification on registration; daily MLS listing sync
- Property URL params `?agent=X` auto-populate the application form
- Agent receives email when their referred application is submitted
- Build skeleton VA, Accounting, Broker dashboards (just the queue UI, no automation yet)
- **Decision needed:** Is the existing MLS API REST/SOAP/CSV? What schema?

**Phase 3 — Workflow engine + e-signature + integrations** (5–6 sessions)
- Dropbox Sign integration: e-sign rental application, term sheet, lease, addendums
- Stripe webhooks: auto-mark `payment_confirmed` once Accounting confirms
- Resend email service: send templated emails on every status change
- Twilio SMS opt-in
- VA "Send VOR" / "Send VOE" buttons → templated emails with e-sign forms attached
- Verification status tracking + SLA-based reminders
- Manual call logging
- Communications log per application
- TransUnion SmartMove + RentSpree adapter (VA picks one per application)
- PetScreening.com link sender
- AI auto-extract from incoming verifications (Claude API)

**Phase 4 — Approval flow + Term Sheet generation + Counter logic** (3–4 sessions)
- Screening Summary auto-generation from verifications + AI
- Broker Approve/Deny/Approve-with-Conditions workflow
- Auto-generate FCRA-compliant denial letter (Appendix A.4 template)
- Term sheet PDF generation (from approved property + applicant data)
- Term sheet e-sign + accept/reject/counter applicant flow
- Broker counter-review interface
- Calendar event creation: lease signing, orientation
- Google Calendar API integration

**Phase 5 — Lease execution + Tenant onboarding + Owner archive** (3–4 sessions)
- Lease document e-sign (with addendums by property type)
- Move-in Condition Report 3-day countdown in tenant portal
- Welcome email + portal credential delivery
- Lease copy auto-emailed to owner
- Thank-you + 1099 reminder to listing/showing agents
- Review request scheduler (14 days post move-in)
- Buildium sync (optional — keep existing system in parallel until trust established)

**Phase 6+ (deferred)** — Maintenance queue (Savan), rent collection + late fees, monthly owner statements, ACH disbursement, 1099 generation, eviction workflow, renewal automation, IP Rentals spreadsheet replacement.

---

## 10. Open decisions

### Decisions confirmed (2026-04-27)

| # | Topic | Kenny's call |
|---|---|---|
| 2 | Internal team accounts | **Placeholder accounts for now.** Build role-based logins (va@, accounting@, compliance@). Hand out when staff is ready. |
| 3 | E-signature | **Decide later.** Build workflow with manual PDF download/upload first. Add e-sign integration in a later phase once we've validated the workflow. |

### Still to decide before Phase 2 build

1. **MLS API — provider unknown to Kenny.** Action item: identify which MLS Kenny subscribes to (likely GLVAR-area), what tool/portal he uses today, and what his vendor offers. Until format is known, agent verification + listing sync is blocked. **Most likely candidates for Las Vegas:** GLVAR via their Matrix / Paragon system (RESO Web API) · Spark Platform (FBS) · MLSGrid (RESO standardized).
4. **Credit-check default:** Confirm "all four options" still — do we want SmartMove as the default and others as fallback? Or VA picks per app?
5. **Email service:** Resend vs SendGrid. Recommend Resend.
6. **SMS:** Are we doing SMS in v1 or just email? (Twilio adds setup complexity — A2P 10DLC registration takes 1–2 weeks).
7. **AI summary:** Confirm using Claude API (Anthropic). Have Kenny fund an Anthropic account ($5 credit gets us through testing).
8. **Holding fee — Confirm "= security deposit":** The manual says holding fee is typically equal to security deposit (~1 month rent). That's an unusually high holding fee. Confirm we should default to that.
9. **Agent commission terms:** Manual is silent on agent commission for leasing. Need Kenny to define: % of first month? Flat fee? Paid at move-in or at lease signing? 1099 threshold? **This is the biggest gap to fill before Phase 5.**
10. **Owner account creation:** When a new owner signs a PMA, should the platform auto-provision their portal account? Or manual?
11. **Existing data migration:** Do current tenants/owners/leases need to be imported from Buildium / IP Rentals spreadsheet at platform launch? Or can we run parallel systems and migrate property-by-property at next renewal?
12. **Buildium future:** Replace eventually, or keep as accounting/financial system of record indefinitely while platform handles leasing/tenant lifecycle?
13. **Property "KL" subgroup:** Should the platform support multi-portfolio / sub-group filtering from day one? (Manual references "Kenny Group" properties ending in "KL".)

---

## 11. What we're NOT going to do

To keep scope honest:

- ❌ Replace Buildium entirely in v1. Keep Buildium for accounting/financial system of record. Sync key data via API or manual export. Migration to all-in-one is Phase 8+.
- ❌ Build our own credit-check engine. We integrate with TransUnion / RentSpree / SmartMove.
- ❌ Build our own e-signature. We integrate with Dropbox Sign.
- ❌ Auto-call landlords/employers (no AI voicebot in v1). VA logs calls manually.
- ❌ Replace MLS as the listing source — we sync from MLS, never edit listings outside MLS.
- ❌ Replace K-Drive filing entirely — we mirror new docs to K-Drive via Google Drive API for safety/audit.

---

## 12. Sources cited in this plan

- InvestPro Realty Master Policies & Procedures Manual (Drive id `17sKQpSjBqeH1SI-RY6j5RaekpVSRZ6HC`)
- GLVAR Rental Application Rev. 11.19 (Drive id `1RhyLQn6qV4abIFlMCa1DeuPifXeQ0TWQ`)
- Drive 001-PM Folder inventory: see `DRIVE-001-PM-FINDINGS.md`
- Workflow vision: see `PM-WORKFLOW-AUTOMATION-VISION.md`
- Kenny's expanded vision: 2026-04-27 chat
- Industry research: TransUnion SmartMove ($49 Complete), RentSpree ($30–35), Hemlane comparisons
