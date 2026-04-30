# InvestPro PM Platform — Deep-Dives

**Companion to:** PM-PLATFORM-PLAN.md
**Status:** Draft v3.1 · 2026-04-28 (v3 incorporates Joan's review: corrected processing fee to $100, expanded orientation topics, added homeowner-applicant verification path. v3.1 adds Vincy's clarification on weekend/holiday rollover for 3-business-day deadlines.)
**Covers:** (1) Applicant journey · (2) VA work queue · (3) Notification & communication rules

This document zooms into the three areas Kenny wants to walk through in detail. Read alongside the main plan for full context.

---

## Deep-Dive 1: The Applicant Journey

End-to-end walkthrough of what someone applying for an InvestPro property experiences, from first click to move-in. Each numbered step is one screen or one event the applicant sees.

### 1. Discovery — Listing page

The applicant arrives at a listing page. Three ways they get there:

- **Public listings page** (`listings.html`) — direct browse on investprorealty.net
- **MLS syndication** — Zillow/Apartments.com → click-through to investprorealty.net listing detail
- **Agent share link** — their showing agent sent them `https://investprorealty.net/listing/123?agent=AGT-X9F2`

What they see: photos, rent, beds/baths, sqft, pet policy, application fee schedule, a big "Apply Online" button, and (if from an agent link) a "Your agent: Jane Smith — JaneSmith@xyz.com" badge confirming attribution.

**Why agent attribution matters:** if Jane shared the link, that gets baked into the application as `showing_agent_id`. Jane gets credit + 1099 income. The applicant doesn't have to remember to enter Jane's info.

### 2. The Apply button

Clicks "Apply Online" → routes to `/forms/rental-application.html?property=123&agent=AGT-X9F2`.

URL parameters trigger pre-populate:
- Property address, monthly rent, MLS #, listing agent, pet policy → filled from the `properties` table
- Showing agent name + email + license + brokerage → filled from the `agents` table

The applicant's only concern is filling out their personal info — all the property/agent context is already correct.

### 3. The form (13 sections)

This is the page that's already built. The applicant works through:

1. Property & Role — confirms property + chooses primary applicant or co-applicant
2. Personal info — name, DOB, SSN, NV license #, contact
3. Current residence — address, length of stay, reason for moving. **Branches based on "Do you currently rent or own?":**
   - **If renting:** landlord name, contact, monthly rent. VOR will be sent to landlord during screening.
   - **If owning:** mortgage holder, monthly mortgage payment, county-recorded deed reference. Verification path is mortgage statement upload + property-records lookup instead of VOR.
4. Prior residence — same fields (same rent/own branch) if at current under 2 years
5. Employment — employer, supervisor, salary, length, paystub upload requirement
6. Co-applicants — adds rows for each adult who'll be on the lease (each must apply separately)
7. Vehicles — make/model/plate
8. Pets — count + per-pet card with type/breed/weight/age/vet info + 8 pet acknowledgments
9. References — personal + credit references
10. Background questions — eviction history, criminal, bankruptcy
11. Document upload zones — ID, paystubs (2 most recent), bank statements (2 most recent), pet vet certs, pet photos
12. 10 GLVAR disclosures — checkboxes (lead-based paint, mold, etc.)
13. Holding fee agreement + 4 final authorization checkboxes — screen authorization, info-sharing consent, truth attestation, fee non-refundability

A "Save and finish later" button stores progress in `localStorage` so they can resume without re-entering everything (already built).

### 4. Sign the application

**Phase 1 (now / your decision):** Manual PDF flow. After completing the form, applicant downloads a generated PDF, signs by hand or via their preferred e-sign tool, uploads back. Slower but works without integration.

**Phase 3+ (later):** Embedded e-sign via Dropbox Sign or similar. Applicant clicks "Sign Application" → sees the populated PDF inline → adopts a signature → submits all in one flow. We'll add this once the workflow is validated.

### 5. Stripe Checkout

Submit triggers Stripe Checkout in a new tab. Two line items:
- Application fee — $75 (primary) or $50 (co-applicant)
- Holding fee — equal to security deposit (defaults to one month's rent, refundable if denied)

**Holding-fee priority rule (Kenny's policy):** Holding fees can only be paid **in person with certified funds** (cashier's check or money order — no online holding-fee payment). When an applicant has paid the holding fee, their application must be **fully processed and decided before the property is offered to anyone else** — even if another applicant has also paid a holding fee. If no holding fee has been paid on a property, applications are processed **first-come, first-served**, and the platform may have multiple applications in flight on the same property simultaneously. We will offer the property to whichever qualified applicant is approved first. When that happens, the platform automatically emails the applicants who weren't selected (and their showing agent — or the listing agent if there's no showing agent) a list of other available InvestPro properties they're qualified for, so the relationship and the lead aren't lost.

After payment succeeds, Stripe redirects back to `/forms/application-submitted.html?c=IPR-XXXXXXX&session_id=...`.

### 6. Confirmation page

Shows:
- Confirmation number (IPR-XXXXXXX) — also emailed
- Receipt for both payments
- "What happens next" timeline:
  1. Accounting confirms payment (typically same business day)
  2. VA reviews documents (within 24 hrs of payment confirmation)
  3. Verifications sent to landlord + employer (within 48 hrs)
  4. Screening summary submitted to broker
  5. Decision within **48 business hours from when the application is submitted AND fee is paid** (per Master P&P Manual Ch. 6.3) — the SLA clock starts at the later of those two events, not at the application form submission alone.
- Link to `/forms/application-status.html`
- Reminder of 3-business-day windows for term sheet acceptance + lease signing

### 7. Status tracking page

Anytime, the applicant can revisit `/forms/application-status.html`, enter their confirmation # + email, and see:
- Current status (e.g., "Verifications in progress — 2 of 3 received")
- Each milestone with a green checkmark or pending dot
- Estimated time to next milestone
- A "Contact us" link if anything looks stuck

### 8. Email milestones

The applicant receives an email at each of these events (templates in plan §6 Notification Matrix):
- Application submitted — confirmation #
- Payment confirmed — "Now in review"
- Screening underway — "All docs verified, pulling reports"
- Decision: approved → term sheet incoming · denied → FCRA letter (mailed within 3 biz days)

### 9. Term sheet review (if approved)

Email with link → `/forms/term-sheet/[id]`. Shows:
- **Monthly rent**
- **Security deposit** — note this *can be higher than what was advertised on the MLS* if the applicant's financial profile warrants it (e.g., lower credit score → higher deposit). Deposits are refundable.
- **Pet fee** (note: a "fee," not a "deposit"). InvestPro policy: **fees are non-refundable; deposits are refundable.** This distinction is enforced in the term sheet line items and disclosed to the applicant.
- **Processing fee** — $100 per Master P&P Manual Ch. 7.2
- **Prorated rent rules:**
  - If the move-in date falls **on or before the 10th** of the month → move-in cost = prorated rent for the current month only
  - If the move-in date falls **on or after the 11th** of the month → move-in cost = prorated rent for the current month **plus the following month's full rent**
  - In some cases, InvestPro may allow a portion of the move-in cost to be **deferred to the following month** (paid on the 1st), but this deferred amount must **never equal or exceed the prorated rent amount**. Deferred terms are negotiated through the **counter offer flow**, not granted automatically.
- **Sewer & trash:** Per a recent NV law change, InvestPro can no longer charge sewer and trash fees on top of the rent — they must be **included in the rent**. Existing addendums and templates need to be updated accordingly. The platform should not generate term sheets with separate sewer/trash line items going forward.
- **Lease term** (12 months default), start date, end date
- **Pet rent** (if applicable), additional terms
- Three buttons: **Accept** · **Decline** · **Counter**
- 3-business-day countdown timer (per Master P&P Manual Ch. 7.4)

**Accept:** e-signs (or signs manual PDF) → status moves to lease drafting.
**Decline:** holding fee is refunded, application closes.
**Counter:** opens a form for proposed changes (rent, deposit, term length, deferred move-in cost, etc.). Counter goes to broker.

### 10. Counter-offer flow

If the applicant counters, the broker sees the counter terms in his decision queue. Three responses:
- Broker accepts counter → revised term sheet generated, applicant e-signs
- Broker rejects → original term sheet stands; applicant can re-accept original or walk away
- Broker counter-counters → ping-pong continues until accepted or one side walks

### 11. Lease signing

After term acceptance, leasing coordinator drafts the lease (NV-specific lease + applicable addendums: pool, pet, ESA, etc.).

**InvestPro lease-signing policy (mandatory unless PM approves an exception):**
- **In-person lease signing + lease orientation** is required at the InvestPro office before any keys are released. Orientation runs **30–45 minutes** and covers: tenancy policies (resident liability, smoking, yards & ground care, etc.), office policies, expectations, and key info.
- If a tenant on the lease cannot attend in person, they **must join via Zoom during the in-person session**, and may e-sign during that Zoom session.
- Fully remote / asynchronous e-signing is **only allowed with explicit PM approval** on a case-by-case basis (e.g., out-of-state military, hardship cases). Default is in-person.

**Two paths in the platform:**
- **Phase 1:** Manual PDF emailed to applicant in advance → applicant **reviews before their in-person signing appointment**. Final signing happens at the office.
- **Phase 5+:** Embedded e-sign at `/forms/lease-signing/[id]` — used during the in-person/Zoom orientation session. PM-approved fully-remote signings can also use this flow.

Either way: 3-business-day window to complete (per Master P&P Manual Ch. 8.2). Broker can extend per-property if it's been on the market a long time.

### 12. Calendar invites

Once lease is signed, applicant receives:
- Calendar invite for **lease signing in person** (if office-based) OR confirmation if signed remotely
- Calendar invite for **orientation / key release** with location, parking, what to bring (certified funds for first-month + deposit per Master P&P Manual Ch. 8.2)
- 24-hour reminder via email + SMS (if opted in)

### 13. Move-in day

On the orientation/move-in date, the applicant arrives at the office, signs the lease (if not already signed), completes the lease orientation walkthrough, and **receives** (rather than signs in advance) the Move-In Condition Report.

**Move-In Condition Report (MICR) policy:**
- Tenant has **3 business days from key release** to return the completed MICR.
- **If the 3-day period falls on a weekend or holiday, the deadline rolls to the next business day.** This applies to all 3-business-day SLAs throughout the system (MICR, term sheet acceptance, lease signing, FCRA denial letter send) — the platform calculates deadlines using this rule automatically.
- If the MICR is not returned within 3 business days, **the property is deemed to be in perfect/move-in-ready condition** for deposit purposes.
- During orientation, we explicitly advise tenants to **protect their own deposit** by emailing supporting **photos** of any pre-existing condition issues alongside the MICR. The tenant portal accepts photo uploads tied to the MICR for this reason.

After keys are handed over, status flips to `leased`. The applicant becomes a tenant in the system.

### 14. Welcome packet (post-move-in email)

Tenant receives:
- Welcome email with portal login link (Supabase auto-creates account, password reset link sent)
- Reminder: Move-In Condition Report due within 3 days of key release
- Auto-pay setup link
- Maintenance request portal info
- Renter's insurance reminder
- Trash service info ($19/mo or $31/mo if pool, per Master P&P Manual Ch. 21.1)

### 15. Review request (14 days post move-in)

Applicant gets an email asking for a Google review + InvestPro internal review. Their showing agent and listing agent get the same prompt independently.

---

## Deep-Dive 2: The VA Work Queue

This is what daily life looks like for the application processor (the VA — separate person from Mandy/Compliance).

### Login & Dashboard

VA goes to `/portal/va/login` → Supabase auth → lands on `/portal/va/dashboard`.

The dashboard is a **work queue** organized into columns by application status. Think Kanban-board layout:

| Column | What's here | What VA does |
|---|---|---|
| 📥 Payment confirmed | Apps that just had Accounting confirm payment | Click in → start document review |
| 📑 Doc review | Apps where VA has started but not finished verifying uploads | Mark each doc verified/missing/issue |
| 📤 Verifications out | Apps where VOR/VOE/credit have been sent but not all received | Watch SLA timers; call landlord/employer if stalled |
| 🤖 AI summary draft | Apps where all verifications are in and AI has drafted summary | Review/edit/finalize summary |
| ✅ Sent to Broker | Apps awaiting Kenny's decision | Just informational — no VA action |
| ⏰ Overdue | Anything past SLA | Highlighted in red — escalation |

Above the columns: counters, search by confirmation #/applicant name/property, filter by listing agent.

### Application Detail Page

VA clicks an application → opens `/portal/va/applications/[id]`. The page has tabs across the top:

#### Tab 1: Overview
- Applicant photo (from ID upload), name, contact info, role badge (primary/co-app)
- Property card: address, rent, listing agent
- Showing agent card (if any)
- Co-applicants list with their statuses (linked applications)
- Payment summary (app fee + holding fee, who confirmed, when)
- Big status banner across top
- Audit-log sidebar showing every event in chronological order

#### Tab 2: Documents
Each required doc (ID, paystubs, bank stmts, pet docs) appears as a row:
- Thumbnail preview
- Filename, size, upload date
- Three status pills: ✅ Verified · ⚠️ Issue · ❌ Missing
- "Add note" textarea (e.g., "Paystub is from gig work — flagging for VA's discretion")
- "Request re-upload" button — sends templated email to applicant

When all required docs marked ✅, status auto-advances to `screening_in_progress`.

#### Tab 3: Verifications
For each verification type (Current VOR or Property Ownership · Prior VOR or Prior Property Ownership · Current VOE · Prior VOE · Credit · Background · Pet Screening):

**Note (added per Joan's review):** "VOR" stands for Verification of Rental — but for applicants who currently OWN their home, the VOR step is replaced with a **Property Ownership Verification** step (mortgage statement review + county records check). The platform branches automatically based on the applicant's "rent or own" answer in Section 3 of the form.
- Recipient (auto-filled from application data: e.g., current landlord's email + phone)
- Status: not_sent · sent · reminded · received · failed
- Big button: **Send VOR to current landlord**
  - Click → confirmation modal showing the templated email + form attached
  - Send → email goes via Resend, signed e-form attached (Phase 3 with Dropbox Sign; Phase 1 = downloadable PDF link)
- SLA timer: "Sent 26 hours ago — 22 hours until reminder auto-sends"
- "Log a phone call" button:
  - Modal: who called, who they spoke with, outcome (left voicemail · spoke · refused · no answer), notes textarea
  - Saves to `communications` table; visible in audit log

When verification comes back (manual upload or webhook):
- VA reviews the response
- **AI auto-extract** runs on the form:
  - "Did tenant pay rent on time? Yes/No"
  - "Would you re-rent? Yes/No"
  - "Lease length confirmed?"
  - For VOE: "Income matches? Salary $___? Length of employment ___?"
- VA can edit the extracted summary; click "Mark verified."

#### Tab 4: Credit & Background
Big button: **Run credit check via SmartMove** OR **Send RentSpree link** OR **Upload manual report**.

Why all 3 options: per Kenny's request, VA picks per applicant based on cost, applicant comfort, or client preference.

After the report comes back:
- Score, derogatory items, eviction history, public records
- AI generates plain-English summary alongside raw report

#### Tab 5: Screening Summary
Shows the AI-drafted **Screening Summary Report** assembled from all verifications + credit + background + pet screening.

Format mirrors what Kenny uses today:
- Summary paragraph (income vs. rent, residency stability, credit highlight)
- Recommendation: Approve · Approve with Conditions · Deny
- Green/yellow/red flags grid (income met? credit ≥ X? VOR clean? etc.)

VA can edit any field. Click **Submit to Broker** → status → `broker_review`, Kenny gets notified.

#### Tab 6: Communications Log
Every email, SMS, and logged phone call for this application, threaded:
- Outbound and inbound
- Email replies auto-thread by `In-Reply-To` header
- VA can hit "Reply" to reply directly from the app (sends through Resend)

This is the audit trail. Every send is logged with timestamp, sender, recipient, template used.

### A Typical VA Day (illustrative)

8:00 — VA logs in. Dashboard shows:
- 3 apps in `payment_confirmed` (Accounting confirmed overnight)
- 5 apps in `verifications_out` with SLA timers
- 2 apps in `summary_draft` ready to finalize
- 1 app in `overdue` — VOR not received in 48 hours

8:05 — Opens overdue app. Clicks "Log call to landlord" → calls → talks to landlord → fills in form: "Spoke. Said tenant paid rent on time, no issues, would re-rent." Marks verification as received with manual notes. AI drafts a summary line for the screening report.

8:30 — Goes to `payment_confirmed` column. Opens first new app. Reviews 6 uploaded docs in Documents tab. Marks 5 ✅. One paystub is illegible — clicks "Request re-upload" with note. Status stays in doc review until applicant re-uploads.

9:00 — Goes to `summary_draft` column. Reviews AI summary, tweaks language, checks all fields. Clicks Submit to Broker. Notification fires to Kenny.

10:00 — Verifies new VOE that came in. AI extracted: "Salary $5,200/mo, employed 3.5 years." VA confirms, marks verified.

…and so on. The platform turns "I have 30 emails to chase" into "I have 4 things to do today, sorted by urgency."

---

## Deep-Dive 3: Notification & Communication Rules

How the platform talks to people. The rules come from Master P&P Manual Ch. 39 (Email Standards) — they're enforceable in code so they can't be skipped.

### Channel rules

| Recipient | Default channel | Optional |
|---|---|---|
| Applicant | Email | SMS opt-in at registration |
| Tenant | Email | SMS opt-in at lease signing |
| Owner | Email | None (no SMS for owners — phone calls instead per Master P&P Manual Ch. 24.3) |
| Agents | Email | SMS opt-in at agent registration |
| VA / Accounting / Broker / Compliance | Email + in-app notification | None |

### Hard rules from the manual (enforced in code)

1. **Tenant emails BCC Savan + Jeff + Mandy** — every outbound email to a tenant gets these BCCs added by the send service. Cannot be skipped.
2. **Owner emails CC Accounting** — every outbound email to an owner CCs accounting@investprorealty.net. Cannot be skipped.
3. **Never tenant + owner on the same email** — the send service rejects any send that has both a tenant and owner in to/cc/bcc.
4. **Email subject convention:** `[Property Address] – [Keyword]` (e.g., `3601 W Sahara #207 – Application Received`). Templates enforce this format.

### Per-event detail (full notification matrix)

| Event | Applicant | Showing Agent | Listing Agent | VA | Accounting | Broker | Owner | Tenant |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Application submitted | ✉️ Confirmation | ✉️ App on referral | ✉️ App on listing | ✉️ Queue alert | ✉️ Payment to confirm | — | — | — |
| Payment confirmed | ✉️ Now in review | — | — | ✉️ Doc review task | — | — | ✉️ App received (no PII) | — |
| All docs verified | ✉️ Screening underway | — | — | — | — | — | — | — |
| VOR received | — | — | — | ✉️ Result in | — | — | — | — |
| VOE received | — | — | — | ✉️ Result in | — | — | — | — |
| Credit returned | — | — | — | ✉️ Result in | — | — | — | — |
| Summary submitted | — | — | — | — | — | ✉️ Decision needed | — | — |
| **Approved** | ✉️ Term sheet incoming | ✉️ Approved! | ✉️ Approved | — | — | — | ✉️ Recommend approve | — |
| **Denied** | 📜 FCRA letter (3 biz days) | ✉️ Update | ✉️ Update | — | — | — | ✉️ Recommend deny | — |
| Term sheet sent | ✉️ Review (3 biz days) | ✉️ Term sent | ✉️ Term sent | — | — | — | — | — |
| Term accepted | ✉️ Lease drafting | ✉️ Accepted | ✉️ Accepted | ✉️ Draft lease | — | ✉️ FYI | ✉️ Accepted | — |
| Term countered | — | ✉️ Counter | — | — | — | ✉️ Review | — | — |
| Term rejected | — | ✉️ Declined | ✉️ Declined | — | — | — | ✉️ Declined | — |
| Lease signing scheduled | 📅 Invite + 24h reminder | ✉️ FYI | ✉️ FYI | — | — | — | — | — |
| Orientation scheduled | 📅 Invite + 24h reminder | — | — | — | — | — | — | — |
| **Lease fully signed** | ✉️ Welcome | ✉️ 🎉 Thank you + 1099 | ✉️ 🎉 Thank you + 1099 | — | ✉️ Set up billing | — | ✉️ Lease copy | ✉️ Welcome + portal |
| Move-in complete | ✉️ Review request (14 days) | ✉️ Review request | ✉️ Review request | — | — | — | — | ✉️ Onboarding tips |

### Sample email templates

These would live in the `email_templates` table, editable by Kenny via `/portal/broker/templates`. Versioned, so changes don't retroactively alter past sends.

#### Template: Application Received → Applicant
```
Subject: {{property_address}} – Application Received

Hi {{applicant_first_name}},

We've received your application for {{property_address}}. Your
confirmation number is {{confirmation_number}}.

What happens next:
1. Our accounting team will confirm your payment (usually same business day).
2. Your documents are reviewed by our processor.
3. We'll contact your landlord and employer to verify the information.
4. We'll pull credit and background reports.
5. You'll hear from us with a decision within 48 business hours of
   step 1 above (per our policy, Master P&P Manual Ch. 6.3).

If we need anything else, we'll email you. You can also check status
anytime: {{status_url}}

Questions? Reply to this email or call 702-816-5555.

— InvestPro Realty
```

#### Template: VOR Request → Current Landlord
```
Subject: {{property_address}} – Verification of Rental for {{applicant_full_name}}

Hello {{landlord_name}},

{{applicant_full_name}} has applied for {{property_address}} and listed
you as their current landlord at {{their_current_address}}.

Could you please complete the brief verification form linked below? It
takes 2-3 minutes:

   {{vor_form_url}}

If you'd prefer to call, you can reach our processor at 702-816-5555.

This information helps us process the application within our 48-hour
service standard. Thank you!

— InvestPro Realty
```

#### Template: Owner Notification — Application Received (no PII)
```
Subject: {{property_address}} – Application Received

Hi {{owner_first_name}},

We've received an application for your property at {{property_address}}.
We'll process screening over the next 48 business hours and follow up
with our recommendation.

We'll send you a recommendation summary once screening is complete —
no detailed personal information of the applicant will be shared, per
our privacy policy.

— InvestPro Realty (CC: accounting@investprorealty.net)
```

#### Template: Owner Notification — Approval Recommended (no PII)
```
Subject: {{property_address}} – Approval Recommended

Hi {{owner_first_name}},

Screening is complete for the application on {{property_address}} and
we recommend **approval**.

Summary of our findings (no personal details per our privacy policy):
- Income: meets our 3x rent requirement
- Credit: above our minimum threshold
- Rental history: positive verification from current landlord
- Background: clean

We'll proceed with the term sheet to the applicant unless you respond
within 24 hours with concerns. Standard terms apply per your
management agreement.

Move-in target: {{anticipated_move_in_date}}

— InvestPro Realty (CC: accounting@investprorealty.net)
```

### SLA reminders

The platform watches each verification's `sla_due_at` timestamp. When breached:
- VA gets an in-app + email notification: "VOR for IPR-XXXXXXX overdue — please follow up"
- Task auto-created in VA queue: "Call current landlord for IPR-XXXXXXX"
- After 24 more hours: escalates to Kenny

Per Master P&P Manual Ch. 24.3 (owner non-response): same 24h email follow-up → another 24h → Jeff calls escalation pattern is reused for unresponsive landlords/employers.

### Calendar invites

For events that have a specific time (lease signing, orientation, move-in inspection):
- ICS file attached to email (works in Outlook, Apple Mail, etc.)
- Google Calendar API call adds the event directly to staff calendars (Kenny, leasing coordinator, applicant if Google Workspace user)
- 24-hour-before reminder via email + SMS (if opted in)

### Review requests

14 days after a successful move-in, three review requests fire automatically:
- Applicant → "How was your application experience?" + Google review link
- Showing agent → "Thank you again. If you have a minute, would you leave us a Google review?"
- Listing agent → same as showing

Responses come back to a `reviews` table for Kenny to monitor.

---

## Recap

These three deep-dives walk through the surface area Kenny will see and operate. The full data model, integrations, phasing, and remaining open decisions are in `PM-PLATFORM-PLAN.md`.

Once Kenny has confirmed his GLVAR Matrix IDX vendor (so we know which API to wire up), Phase 2 build can start. In the meantime: read these, push back on anything that doesn't match how InvestPro actually works, and we'll iterate.
