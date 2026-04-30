# InvestPro PM Platform — v1 Launch & Test Guide

**Version:** Phase 2.8 (Manual property entry) · 2026-04-28
**Status:** Ready for real-case testing — IDX feed deferred until Kenny is back at office (~1 week)

This is the playbook for deploying the platform and running it through real cases before final launch.

---

## What's in v1

| Capability | Status | Notes |
|---|---|---|
| Public website + listings | ✅ Live | Already deployed at investpro-realty.netlify.app |
| Rental application form (renter + homeowner paths) | ✅ Live | Joan's homeowner branch added |
| Application save + Stripe checkout (demo mode) | ✅ | Falls back to localStorage until Stripe keys added |
| Status tracking page for applicants | ✅ Live | |
| 12-role auth (broker · va · accounting · compliance · leasing · pm_service · admin_onsite · agent · applicant · tenant · owner) | ✅ | Demo mode ready; Supabase wiring on first real-case test |
| **Pre-move-in inspection (PM staff)** | ✅ NEW | Full checklist + per-item photo upload + autosave |
| **Tenant Move-In Condition Report** | ✅ NEW | 3-business-day deadline (rolls past weekends/holidays per Vincy's rule) |
| Inspection editor (shared by PM + tenant) | ✅ NEW | Saves continuously to localStorage; Supabase upload in v1.1 |
| Role-specific dashboards (PM · VA · Broker · Accounting · Compliance · Leasing · Admin · Agent · Applicant · Tenant · Owner) | ✅ NEW | Live with demo data |
| Database schema (20 tables, 17 enums, 50 indexes, 43 RLS policies) | ✅ NEW | 12 numbered SQL migration files in `db/` |
| Business-day deadline helpers | ✅ NEW | Auto-extends past weekends + 2026 holidays |

| **Deferred to later phases** | Phase | Notes |
|---|---|---|
| MLS API integration (agent verification + listing sync) | 3 | Blocked on identifying GLVAR Matrix IDX vendor |
| E-signature (Dropbox Sign embedded) | 3 | Manual PDF upload works in v1 |
| Resend email service + automated emails | 3 | Manual emails in v1 |
| Twilio SMS | 3 | Email-only in v1 |
| Credit-check API (SmartMove / RentSpree) | 3 | Manual upload of credit reports in v1 |
| Claude AI auto-extract from VOR/VOE | 3 | VA writes summaries manually in v1 |
| Maintenance ticket queue (Savan) | 6+ | |
| Rent collection + late fees | 6+ | Buildium continues to run in parallel |
| Owner statements + ACH | 6+ | |
| 1099 generation | 6+ (year-end) | |

---

## Deploy sequence

### Step 1 — Supabase project
1. Log into https://supabase.com (use Kenny's existing project, or create a new one for testing)
2. Go to **Settings → API** and copy:
   - `Project URL` → e.g. `https://abcd1234.supabase.co`
   - `anon` / `public` key → starts with `eyJ...`

### Step 2 — Run database migrations
1. In Supabase Dashboard, go to **SQL Editor**
2. Open each file in `db/` **in numerical order**, paste contents, click **Run**:
   - `001_extensions_enums.sql` → `002_core_identity.sql` → … → `012_business_day_helpers.sql`
3. Verify in **Database → Tables**: should see 20+ tables (profiles, agents, properties, applications, etc.)
4. Holidays for 2026 are pre-seeded — update annually via `/portal/broker/templates` once we build that page

### Step 3 — Create placeholder staff accounts
1. In Supabase Dashboard, go to **Authentication → Users → Add user → Create new user**
2. Create one user for each role (per `db/010_seed_placeholder_users.sql`):
   - `broker@investprorealty.net` — Kenny
   - `va@investprorealty.net` — Application VA
   - `accounting@investprorealty.net` — Jeff
   - `compliance@investprorealty.net` — Mandy
   - `leasing@investprorealty.net` — Leasing Coord
   - `pm@investprorealty.net` — Savan
3. Use temporary strong passwords (you'll hand them out)
4. After all 6 are created, run `db/010_seed_placeholder_users.sql` in SQL Editor — it assigns each one their correct role

### Step 4 — Create storage buckets
1. Go to **Storage** in Supabase
2. Either run `db/008_storage.sql` (if you have admin access) OR manually create:
   - `application-docs` (private, 10MB limit)
   - `verification-results` (private, 20MB)
   - `signed-documents` (private, 20MB)
   - `screening-summaries` (private, 10MB)
   - `agent-w9s` (private, 5MB)

### Step 5 — Wire Supabase keys into the site
Edit `js/auth.js`:
```js
const SUPABASE_URL      = 'https://abcd1234.supabase.co';        // your URL
const SUPABASE_ANON_KEY = 'eyJ.....your-anon-key.....';
```
And same in `js/applications.js` (Stripe is still placeholder — set later).

### Step 6 — Redeploy to Netlify
- Drag-drop the entire `InvestPro PM` folder to https://app.netlify.com/drop
- Confirm preview password still works: `investpro2026`
- New build version: bump `js/preview-gate.js` → `PREVIEW_VERSION = 'v1.0-launch-test'`

---

## Manual property entry (start testing without IDX)

Until Kenny gets the GLVAR Matrix IDX vendor info (next week), properties are entered manually.

**Where:** `/portal/properties/list.html` (linked from Broker / Leasing / Admin dashboards as "🏠 Manage Properties")

**Three sample properties are seeded** automatically on first load so the public listings page is never empty:
- 3601 W Sahara Ave #207 — $1,850/mo (2BD/2BA condo)
- 2440 Vegas Drive — $2,400/mo (3BD/2BA SFH)
- 9100 N Decatur #11 — $1,650/mo (2BD/1.5BA condo)

**To test the application flow:**
1. From Broker dashboard → click **🏠 Manage Properties**
2. Click **+ Add Property** — fill in address, monthly rent, beds/baths, listing description
3. Save → the property appears on the public listings page automatically + a unique apply link is generated
4. Click **Copy apply link** → share with your test applicant via email/text
5. The applicant clicks the link → application form auto-fills the property address + rent + beds/baths
6. Application flows through Accounting → VA → Broker → Term Sheet → Lease → MICR

**On the public listings page** (`/listings.html`): manually-added properties show at the top of the grid with an "Apply Now" button. Sample/static listings still appear below as legacy.

---

## Real-case test plan

Run these scenarios end-to-end in production (with the live Supabase backend). Have someone other than Kenny do most of these to catch UX issues an insider would miss.

### Test 1 — Renter applicant happy path
Goal: prove the original flow still works after all the changes.
1. From the homepage, click **Listings → 3601 W Sahara #207 → Apply Online**.
2. Fill out the application as a real renter would. Include a co-applicant.
3. Upload 3-5 fake documents (any PDFs / images — could be redacted bank statements).
4. Submit. Confirm the status page shows your confirmation #.
5. Log into Accounting → confirm the payment.
6. Log into VA → see your app in the queue → mark docs verified → click "Send VOR" (in v1 this is a manual email, but the button should log a task).
7. Log into Broker → approve the application.
8. **Bug to watch for:** does the status auto-advance correctly? Are notifications visible in the comms log?

### Test 2 — Homeowner applicant (Joan's flag)
Goal: confirm the new homeowner branch works.
1. Start an application.
2. In Section 3 ("Current Residence"), select **Owned**.
3. The form should:
   - Show Mortgage Holder + County Records Reference + Home Value fields
   - Hide the Landlord Name/Phone/Email fields
   - Show a callout asking for a mortgage statement upload
4. The Documents section should show a new "Mortgage Statement" required upload zone.
5. Submit, then check the application detail in VA dashboard — verifies should include `property_ownership_current` instead of `vor_current`.

### Test 3 — Pre-move-in inspection
Goal: replace paper inspections.
1. Log in as PM (`pm@investprorealty.net`).
2. From PM dashboard, click **+ Schedule Pre-Move-In Inspection**.
3. Pick a property + date/time. Confirm.
4. Open the inspection. Walk through each room. Mark items as Good / Fair / Damaged / Missing. Take + upload photos for damaged items. Add notes.
5. Hit **Save draft**. Close the page. Reopen — verify your work is still there.
6. Submit. Confirm it shows up under "Inspections — In Flight" with status "Submitted".

### Test 4 — Tenant Move-In Condition Report (MICR)
Goal: replace paper MICR with portal upload + deadline reminders.
1. As Admin (or via Supabase update), set up a fake lease for a test tenant.
2. Mark the lease's `fully_executed_at` to today's timestamp — the trigger should auto-set the MICR `deadline_at` to 3 business days later (skipping weekends/holidays per Vincy's rule).
3. Log in as the tenant. Click **Move-In Inspection** in the sidebar.
4. Verify the alert banner shows the deadline countdown.
5. Fill out at least 5 items, attach photos to 2 of them.
6. Save progress. Log out. Log back in. Verify your work persisted.
7. Submit. Status should flip to "Submitted ✓".

### Test 5 — Overdue MICR auto-flag
Goal: enforce the "deemed perfect" rule when tenant misses deadline.
1. Set up another fake lease, but back-date the `fully_executed_at` so the MICR deadline has already passed.
2. (Once we add the cron job in v1.1) the inspection's `status` should auto-flip to `deemed_perfect`.
3. For now, manually verify: the PM dashboard's "Overdue MICRs" tile counts this correctly.

### Test 6 — Agent share link
Goal: confirm referral attribution works.
1. Log in as an agent (`agent_showing` role).
2. Copy your share link.
3. Open it in a private browsing window. Click **Apply Online**.
4. Verify the application form auto-populates the agent info (name, email, license, brokerage).
5. Submit. As the agent, verify your dashboard shows the new application under "Apps in flight".

### Test 7 — Role-based access (RLS check)
Goal: confirm no role can see what they shouldn't.
1. Log in as a tenant. Navigate to `/portal/broker/dashboard.html` → should redirect to your tenant dashboard.
2. Log in as an agent. Try to view another agent's referrals → blocked.
3. Log in as an owner. Try to view raw screening data → blocked (only sees recommendation).
4. Log in as VA. Verify you can see all applications but no W-9s.

### Test 8 — Weekend/holiday rollover (Vincy's rule)
Goal: confirm deadlines skip weekends + holidays.
1. In Supabase SQL Editor, run:
   ```sql
   SELECT add_business_days('2026-07-02 17:00:00-07'::TIMESTAMPTZ, 3);
   ```
   Expected: `2026-07-09 17:00:00-07` (skips Independence Day Friday + weekend)
2. Run more cases:
   ```sql
   SELECT add_business_days('2026-04-30 17:00:00-07'::TIMESTAMPTZ, 3);  -- expect Tue May 5
   SELECT add_business_days('2026-12-22 17:00:00-08'::TIMESTAMPTZ, 3);  -- expect Tue Dec 29 (skips Christmas)
   ```

---

## Known v1 limitations (be ready to explain to testers)

These are NOT bugs — they're scoped to later phases:

1. **No real emails get sent** — email templates are stored but the actual send via Resend isn't wired. Testers will see "would-send" log messages instead. v1.1 (Phase 3).
2. **Credit checks are manual** — VA uploads a PDF of the SmartMove report. Auto-pull comes in Phase 3.
3. **Term sheets are manual PDFs** — generated on the fly but signed offline. Embedded e-sign comes in Phase 3.
4. **Lease signing is in person** — per Kenny's policy, the platform doesn't auto-trigger remote signing. PM approval required for any exception.
5. **No MLS auto-sync** — listings are entered manually until Kenny's IDX vendor is confirmed.
6. **Maintenance / rent collection / owner statements** — Phase 6+. Buildium continues running in parallel.

---

## Reporting bugs during testing

Use this template when filing issues (Slack the team or email Kenny):

```
[BUG / UX / QUESTION] — short title

Role I was logged in as: ____________
Page URL: ____________
What I tried to do: ____________
What happened: ____________
What I expected: ____________
Screenshot: (attach)
Steps to reproduce: 1. _____ 2. _____ 3. _____
```

---

## Rollback plan

If anything goes wrong:
1. Revert Supabase: run `db/999_drop_all.sql` to wipe the schema, re-run migrations from scratch
2. Revert Netlify: redeploy the previous build (Netlify keeps every deploy — pick from history)
3. Restore `js/auth.js` from the previous version (git or saved copy in Drive)

The website itself stays up regardless — testing happens behind the preview password gate, not on the public domain yet.

---

## What ships next (Phase 3 prep)

Things to start asking now so they're ready when we reach Phase 3:

1. **MLS IDX vendor info** (Kenny — see open task #27)
2. **Stripe live keys** + Connect setup for agent payouts
3. **Resend** account + verified sender domain
4. **Dropbox Sign** account
5. **Anthropic API key** (Claude API for AI summaries)
6. **VA hire** (real person to take over the placeholder account)
7. **Twilio account + A2P 10DLC registration** (1-2 weeks lead time)

---

## Files added in this build

```
db/
  README.md                       — How to apply migrations
  001_extensions_enums.sql        — UUID + 17 enums
  002_core_identity.sql           — profiles + agents + auto-trigger
  003_properties.sql              — properties + mls_listings
  004_applications.sql            — applications + 6 sub-tables
  005_screening_workflow.sql      — verifications + screening_reports + comms + tasks
  006_lease_lifecycle.sql         — term_sheets + leases + cal events + reviews
  007_email_templates.sql         — templates + 5 seed templates
  008_storage.sql                 — buckets + RLS
  009_rls_policies.sql            — Row Level Security for all tables
  010_seed_placeholder_users.sql  — staff account assignments
  011_inspections.sql             — pre-move-in + tenant MICR + checklist
  012_business_day_helpers.sql    — Vincy's weekend/holiday rollover
  999_drop_all.sql                — destructive reset for dev

js/
  auth.js                         — REWRITE: 12-role auth + role-based routing
  inspection-editor.js            — NEW: shared editor for PM + tenant inspections

css/
  dashboard.css                   — NEW: shared dashboard styles

portal/
  broker/dashboard.html           — NEW
  va/dashboard.html               — NEW
  pm/dashboard.html               — NEW (with inspection scheduling)
  pm/inspection-edit.html         — NEW (inspection editor host)
  accounting/dashboard.html       — NEW
  compliance/dashboard.html       — NEW
  leasing/dashboard.html          — NEW
  admin/dashboard.html            — NEW
  agent/dashboard.html            — NEW
  applicant/dashboard.html        — NEW
  tenant-dashboard.html           — UPDATED: added MICR section
  login.html                      — UPDATED: 12-role dropdown + redirect

forms/
  rental-application.html         — UPDATED: rent/own branch + mortgage upload

LAUNCH-V1-GUIDE.md                — THIS FILE
```
