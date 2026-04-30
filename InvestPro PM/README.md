# InvestPro Realty — Website (v1)

A complete rebuild of investprorealty.net, written as plain HTML/CSS/JS so it
runs on any host with no build step. The Owner & Tenant portals use **Supabase**
(free tier) for real authentication.

This README is written for a **beginner**. Follow it top-to-bottom.

---

## What's in this folder

```
InvestPro PM/
├─ index.html                 ← Homepage
├─ about.html                 ← About / Kenny Lin bio
├─ property-management.html   ← PM hub page
├─ owner-services.html        ← PM details for owners
├─ tenant-services.html       ← PM details for tenants
├─ listings.html              ← Filterable property listings
├─ property-detail.html       ← Sample listing detail page
├─ sales.html                 ← Buy / sell page
├─ recruiting.html            ← Agent recruiting + comp ladder
├─ contact.html               ← Contact form + map
├─ forms/
│   ├─ rental-application.html
│   ├─ maintenance-request.html
│   └─ listing-inquiry.html   ← "Free rental analysis"
├─ portal/
│   ├─ login.html             ← Sign in (owner OR tenant)
│   ├─ signup.html
│   ├─ reset.html             ← Forgot password
│   ├─ owner-dashboard.html   ← Owner portal
│   └─ tenant-dashboard.html  ← Tenant portal
├─ css/styles.css             ← All styling (navy / gold / cream)
├─ js/
│   ├─ main.js                ← Nav, forms, listings filter
│   └─ auth.js                ← Supabase auth helper
├─ images/
│   ├─ hero-bg.svg
│   └─ property-placeholder.svg
└─ README.md                  ← You're reading this
```

You can preview the site right now by **double-clicking `index.html`** — it
will open in your browser. The portal works in **Demo Mode** until you wire up
Supabase (instructions below).

---

## Step 1 — Preview locally

Just double-click `index.html`. Click around the menu, try the forms, log in to
the portal with any email and a 4+ character password — it'll show you a sample
dashboard.

---

## Step 2 — Deploy to a free host (Netlify)

Netlify is the easiest beginner-friendly host. Free tier covers everything you
need.

1. Go to **https://app.netlify.com** and sign up (use your Google account).
2. Click **"Add new site" → "Deploy manually"**.
3. **Drag this entire `InvestPro PM` folder** onto the page.
4. Wait ~30 seconds. Netlify gives you a free URL like
   `https://relaxed-coyote-12345.netlify.app`.
5. Click **"Site settings" → "Change site name"** and rename it to something
   like `investpro-realty` (URL becomes `investpro-realty.netlify.app`).
6. **HTTPS is automatic.** No configuration needed.

That's it — your site is live on the internet, free.

### Pointing investprorealty.net to Netlify

When you're ready to replace the existing site:

1. In Netlify: **Site settings → Domain management → Add custom domain**.
2. Enter `investprorealty.net`.
3. Netlify will show you DNS records (one A record + one CNAME).
4. Log in to your domain registrar (whoever you bought investprorealty.net
   from — GoDaddy, Namecheap, etc.).
5. Update the DNS records to match what Netlify gave you.
6. Wait 1–24 hours for DNS to propagate. Done.

---

## Step 3 — Turn on real authentication (Supabase)

The Owner & Tenant portals work in **Demo Mode** out-of-the-box (any
email/password logs in, sample data shown). To accept real users:

### 3a. Create a Supabase project
1. Go to **https://supabase.com** and sign up (free).
2. Click **"New project"**. Name it `investpro-realty`. Pick the closest region
   (US-West-1 for Las Vegas). Set a database password (save it somewhere safe).
3. Wait ~2 minutes for it to provision.

### 3b. Create the `profiles` table
1. In Supabase: **SQL Editor → New query**.
2. Paste this and click **Run**:

```sql
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  role text check (role in ('owner','tenant')) not null default 'tenant',
  created_at timestamptz default now()
);

-- Allow users to read & update their own profile only:
alter table public.profiles enable row level security;
create policy "self read"   on public.profiles for select using ( auth.uid() = id );
create policy "self update" on public.profiles for update using ( auth.uid() = id );
create policy "self insert" on public.profiles for insert with check ( auth.uid() = id );
```

### 3c. Get your API keys
1. In Supabase: **Settings → API**.
2. Copy your **Project URL** (looks like `https://abcd1234.supabase.co`).
3. Copy your **anon / public** key (long string starting with `eyJ...`).

### 3d. Paste keys into `js/auth.js`
Open `js/auth.js` and replace the two placeholder lines:

```js
const SUPABASE_URL      = 'YOUR_SUPABASE_URL';      // ← paste Project URL here
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // ← paste anon key here
```

Save the file. Re-deploy to Netlify (drag the folder again, or set up Git auto-deploy).

### 3e. Configure Supabase Auth URLs
1. In Supabase: **Authentication → URL Configuration**.
2. **Site URL:** your Netlify URL (e.g. `https://investpro-realty.netlify.app`).
3. **Redirect URLs:** add `https://investpro-realty.netlify.app/portal/*`.

That's it — real auth is on. Visitors signing up at `/portal/signup.html` get
real Supabase accounts and confirmation emails.

---

## Step 4 — Wire up form submissions (optional)

Right now, contact / application / maintenance forms show a "thank you"
message but don't email you. Three options:

**Option A — Formspree (easiest, free for 50 submissions/month)**
1. Sign up at https://formspree.io
2. Create a form, copy the URL (looks like `https://formspree.io/f/abcd1234`).
3. In each form HTML file, change `action="#"` to `action="https://formspree.io/f/abcd1234"`.

**Option B — Netlify Forms (free, built-in)**
1. Add `data-netlify="true"` and a `name` attribute to each `<form>`:
   `<form data-validate name="contact" data-netlify="true" action="#" method="post">`
2. Re-deploy to Netlify.
3. Submissions appear in **Netlify dashboard → Forms**.

**Option C — Supabase database**
For more advanced setups, store submissions in a Supabase table. Ask Claude to
help when you're ready.

---

## Step 5 — Replace placeholder content

A few things you should personalize before launch:

1. **Logos & photos** — replace `images/property-placeholder.svg` with your
   real property photos. Save them in `images/` and update the `<img src="">`
   references.
2. **Hero image** — replace `images/hero-bg.svg` with a real photo of Las Vegas
   or your office. Keep file size under 300KB and use `.jpg`.
3. **Email address** — search the codebase for `info@investprorealty.net` and
   replace if you use a different email.
4. **Sample listings** — `listings.html` has 9 sample property cards. Replace
   the data, or wire up an MLS / IDX feed (most Nevada MLS providers offer one
   for ~$50/month).
5. **Owner/tenant names** — the dashboards show sample names ("J. Rivera",
   "K. Nguyen") to demonstrate the design. Real data will populate once
   Supabase tables are connected.

---

## Sharing the Preview With Your Team

The site has a built-in **password gate** so you can share a Netlify preview
URL with your team without making it public. Reviewers enter a shared
password once and can click around freely. Search engines can't index the
site while the gate is on.

### One-time setup

1. **Pick your password.** Open `js/preview-gate.js` and edit:
   ```js
   const PREVIEW_PASSWORD = 'investpro2026';   // ← change this
   const PREVIEW_VERSION  = 'v0.3-preview';    // ← bump this each time you redeploy
   ```
   Save the file.

2. **Deploy to Netlify** (free).
   - Go to **https://app.netlify.com** and sign up (free).
   - Click **"Add new site" → "Deploy manually"**.
   - **Drag the entire `InvestPro PM` folder** onto the page.
   - Wait ~30 seconds. You get a URL like `https://relaxed-coyote-12345.netlify.app`.
   - Click **Site settings → Change site name** and rename to e.g.
     `investpro-preview` so the URL becomes `investpro-preview.netlify.app`.

3. **Email or Slack your team:**
   ```
   Hi team — we're rebuilding investprorealty.net. Take a look:

   URL:      https://investpro-preview.netlify.app
   Password: investpro2026
   Build:    v0.3-preview

   Click the blue 🔒 badge in the bottom-right of any page to email me feedback,
   or just reply with notes. Thanks!
   ```

### What your reviewers see

- A clean **"Preview · Team Review"** password page when they first land.
- Once entered, the password is remembered for the rest of the browser
  session — they can click around all 20 pages without re-entering.
- A small **🔒 Preview v0.3-preview** badge in the bottom-right corner of
  every page. Clicking it opens their email client pre-addressed to
  `info@investprorealty.net` with the page URL and build number filled
  in — making feedback frictionless.

### Recommended feedback workflow

For 4–10 reviewers across the office, the simplest workflow is:
1. **Single inbox.** All feedback goes to `info@investprorealty.net` (the
   badge button does this automatically). One person triages.
2. **Build versions.** Each time we ship changes, we bump
   `PREVIEW_VERSION` in `preview-gate.js` (e.g. `v0.4-preview`). Reviewers
   know which build they're seeing because of the badge.
3. **Weekly review meeting.** A 30-min standing meeting to walk through
   feedback, decide what to change, and agree on the next round.

### Updating the preview after changes

Two ways to redeploy:

**Drag-and-drop (simplest):**
- In Netlify: **Deploys → "Drag and drop"** — drop the `InvestPro PM`
  folder again. Netlify swaps to the new build in ~30 seconds.

**Auto-deploy from Git (recommended once you're comfortable):**
- Push the project to a free GitHub repo, connect it in Netlify, and any
  push to `main` will auto-deploy. We'll set this up when you're ready.

### Changing the password

Edit `js/preview-gate.js` → change `PREVIEW_PASSWORD` AND change
`STORAGE_KEY` (e.g. `investpro_gate_v3` → `investpro_gate_v4`). The
storage-key bump forces everyone to re-enter, even reviewers who already
unlocked the previous version. Redeploy to Netlify.

### Going live (turning the gate off)

When you're ready to launch publicly:
1. Open `js/preview-gate.js` and change `GATE_ENABLED = true` → `false`.
2. Redeploy. Done.

### Honest disclaimer about the password gate

This is a **preview-grade** gate. The password is in JavaScript, which
means anyone who opens the browser's "View Source" can find it. For a
website with sample/dummy data shared with trusted team members, this is
fine — it stops casual visitors and search engines, which is the goal.

**Once you have real client data on the site** (real applications, real
owner statements, etc.), do **not** rely on this gate alone. By that
point we'll have Supabase auth on every page (already built for the
portal), or you can put the whole site behind **Cloudflare Access**
(free for up to 50 users) for proper enterprise SSO.

### If you want richer review tools later

If your team wants pin-to-page sticky-note comments, video walkthroughs,
or a real review dashboard:
- **Markup.io** — free tier, embed-able. Reviewers click anywhere on the
  page to drop a comment. Works on top of any deployed site.
- **BugHerd** — paid (~$49/mo), more polished workflow with kanban.
- **Loom** — free tier, team records voice walkthroughs of pages.

Just ask Claude to wire any of these in when you're ready.

---

## Phase 1 — Application Workflow (rental application + Stripe fee)

The rental application form (`forms/rental-application.html`) is aligned to
the GLVAR Rev. 11.19 official rental application Kenny uses. It collects
applicant info, household, pets (with 8 acknowledgments), documents, agent
info, 10 GLVAR disclosures, and a Holding Fee Agreement. Stripe collects
**$75 from the primary applicant or $50 from each co-applicant**, plus the
holding fee amount entered on the form. Until Stripe + Supabase are wired up,
the form runs in **demo mode** (saves to browser localStorage so you can
click through the entire flow).

### 1.1 — Add new tables & storage bucket to Supabase

In Supabase **SQL Editor → New query**, paste and run:

```sql
-- Applications table
create table public.applications (
  id              uuid primary key default gen_random_uuid(),
  confirmation    text unique not null,             -- e.g. "IPR-A1B2C3"
  property_address text not null,
  move_in_date    date,
  lease_term      text,
  applicant_first text not null,
  applicant_last  text not null,
  applicant_email text not null,
  applicant_phone text,
  applicant_dob   date,
  ssn_last4       text,
  monthly_income  numeric,
  employment      jsonb,                            -- {employer, title, duration, supervisor}
  household       jsonb,                            -- {other_adults, children, vehicles}
  pets            jsonb,                            -- array of pet objects
  current_residence jsonb,
  prior_residence   jsonb,
  disclosures     jsonb,
  signature       text,
  signature_date  date,
  status          text not null default 'pending_payment',  -- pending_payment | submitted | screening | approved | declined | term_sent | accepted | leased
  fee_paid_cents  int default 0,
  stripe_session_id text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Documents table (one row per file)
create table public.application_documents (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references public.applications(id) on delete cascade,
  doc_type        text not null,                    -- 'docs_id' | 'docs_income' | 'docs_bank' | 'docs_references' | 'docs_pets' | 'docs_other'
  file_name       text not null,
  storage_path    text not null,                    -- e.g. "{application_id}/docs_id/passport.pdf"
  file_size       int,
  mime_type       text,
  uploaded_at     timestamptz default now()
);

-- Showing/listing agent info (separate table so we can re-use across applications)
create table public.application_agents (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references public.applications(id) on delete cascade,
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  license_number  text,
  pid             text,
  brokerage       text,
  brokerage_license text,
  brokerage_address text,
  showing_date    date,
  notes           text,
  w9_received     boolean default false,
  w9_storage_path text
);

-- Storage bucket for application documents
insert into storage.buckets (id, name, public)
values ('application-docs', 'application-docs', false)
on conflict do nothing;

-- RLS: applicants can read their own application via confirmation # + email
alter table public.applications enable row level security;
alter table public.application_documents enable row level security;
alter table public.application_agents enable row level security;

-- Service role (your backend / Edge Function) can do everything:
create policy "service all apps"  on public.applications        for all to service_role using (true);
create policy "service all docs"  on public.application_documents for all to service_role using (true);
create policy "service all agts"  on public.application_agents   for all to service_role using (true);

-- Authenticated tenants/owners (when logged into portal) can see their linked applications:
-- (We'll add policies once we link applications to tenant accounts in Phase 4.)
```

### 1.2 — Wire up Stripe (application fee + holding fee)

**Application fee:** $75 primary applicant, $50 each additional adult (the form's `applicant_role` radio drives this — `primary` → $75, `co` → $50).
**Holding fee:** variable amount entered by applicant on the form (typically equal to one month's rent). Refunded on denial; forfeited on approval-but-no-lease; applied to deposit on approval-and-sign.

The Stripe Checkout session should create TWO line items:
1. "Application Fee — Primary Applicant ($75)" or "Application Fee — Co-Applicant ($50)" depending on `applicant_role`
2. "Holding Fee ($X)" where X is `holding_fee_amount` from the form


1. Sign up at **https://stripe.com** (free; pay-as-you-go).
2. **Dashboard → Developers → API keys** — copy your **publishable key**
   (`pk_test_...` for test mode, `pk_live_...` for production).
3. Open `js/applications.js` and replace:
   ```js
   const STRIPE_PUBLISHABLE_KEY = 'pk_test_REPLACE_ME';
   ```
4. **Create a server endpoint** that creates a Checkout session. The simplest
   way is a **Netlify Function**. Create `netlify/functions/create-checkout-session.js`
   in your project root with this content:

   ```js
   // netlify/functions/create-checkout-session.js
   const Stripe = require('stripe');
   const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

   exports.handler = async (event) => {
     const { application, adults, feeUsd } = JSON.parse(event.body);
     const session = await stripe.checkout.sessions.create({
       mode: 'payment',
       payment_method_types: ['card'],
       line_items: [{
         price_data: {
           currency: 'usd',
           product_data: { name: `Rental Application Fee (${adults} adult${adults>1?'s':''})` },
           unit_amount: feeUsd * 100
         },
         quantity: 1
       }],
       customer_email: application.email,
       success_url: `${process.env.URL}/forms/application-submitted.html?session_id={CHECKOUT_SESSION_ID}`,
       cancel_url: `${process.env.URL}/forms/rental-application.html?canceled=1`,
       metadata: { applicant_email: application.email }
     });
     return { statusCode: 200, body: JSON.stringify({ checkoutUrl: session.url }) };
   };
   ```
5. In Netlify dashboard: **Site settings → Environment variables → Add**:
   - `STRIPE_SECRET_KEY` = `sk_test_...` (from Stripe dashboard)
6. Add `npm install stripe` in your project root (Netlify auto-installs deps).

### 1.3 — Webhook for "payment succeeded" (recommended)

Stripe sends a webhook event when payment clears. You'll add another Netlify
Function to: insert the application row in Supabase, upload documents, send
email confirmation, and notify the listing/showing agent. We'll wire this up
in Phase 1B once you've signed up for Stripe.

### 1.4 — Screening services (architected for later)

The application is built to support **multiple screening services** that the
admin can choose from per application. Each has its own integration cost:

| Service | What it does | Setup |
|---|---|---|
| **Admin uploads PDF** | Admin runs check externally, uploads result | No setup — works today |
| **TransUnion SmartMove** | Credit + criminal + eviction; tenant pays direct | Free partner application; ~$25–30/check (tenant-paid) |
| **RentSpree** | Similar to SmartMove | Free signup; ~$30/check |
| **PetScreening.com** | Pet/ESA/service-animal screening | Free for property managers |

You'll connect these in Phase 4 of the workflow (admin review). For now, all
the fields and UI are ready to receive results from any of them.

### 1.5 — Email notifications (Phase 1B)

Notifications fire at three points: applicant submission, status change,
final decision. We'll wire up a free email service (Resend, ~3000 free
emails/month, or SendGrid free tier) in Phase 1B.

### What Phase 1 includes vs. doesn't (yet)

✅ **Includes now:**
- Comprehensive applicant form (info, docs, pets, household, disclosures)
- Showing/listing agent info collection (license #, brokerage, contact)
- Auto-save draft to browser (resume later)
- Document drag-and-drop upload (10MB max each)
- Confirmation # + status tracking pages
- Demo mode that simulates the full flow without external services

🚧 **Coming in next phases:**
- Stripe payment (Phase 1B — needs your Stripe account)
- Supabase persistence + email notifications (Phase 1B)
- Admin review dashboard (Phase 2)
- Credit/background/pet screening integrations (Phase 3)
- PM/Owner approval workflow + term sheet generation (Phase 4)
- Lease signing + accounting handoff + portal archive (Phase 5)

---

## Step 6 — When you want to extend

The site is plain HTML, so editing content is just opening any `.html` file in
a text editor and changing the words inside `<p>` or `<h1>` tags.

Common edits:
- **Change a phone number** — search-and-replace `702-816-5555` across all files.
- **Add a new page** — copy `about.html`, rename it, edit the title and content,
  add a link in the nav of every page.
- **Update colors** — open `css/styles.css` and change the values at the top
  under `:root` (search for `--navy`, `--gold`).

---

## What's NOT included (and why)

| Feature | Why it's not built yet | When you'll want it |
|---|---|---|
| MLS / IDX live listings feed | Requires paid MLS subscription + IDX provider integration. | When you're ready to spend ~$50/mo on Lone Wolf or similar. |
| Online rent payments | Requires Stripe/Plaid integration + bank verification. | After Supabase is live and you have real tenants in the portal. |
| Property management software integration | Each PM platform (AppFolio, Buildium, etc.) has its own API. | If you use a PM platform, we can replace the sample dashboards with real data from it. |
| Email automation (drip campaigns) | Use a free tier of Mailchimp or Loops. | When you're ready to nurture leads from the contact form. |
| Spanish version | Real estate in Las Vegas often benefits from this. | Easy to add — copy each `.html` file into `/es/`, translate. |

---

## Need help?

Ask Claude in this same Cowork session — every file has comments showing what
the code does and where to edit. You can say things like:

- "Add a new service to the PM page about renovations."
- "Change the gold color to a darker shade."
- "Add a new property to the listings page."
- "Connect the contact form to Formspree."

Good luck with the launch! 🚀
