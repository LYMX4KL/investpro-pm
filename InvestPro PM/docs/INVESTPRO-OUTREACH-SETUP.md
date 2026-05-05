# InvestPro Realty — Cold Outreach Domain Setup Runbook

**Concrete one-time steps to wire `investproleads.com` for outbound cold-prospecting email.**

This is the second-domain runbook for InvestPro. Read alongside:
- `INVESTPRO-EMAIL-SETUP.md` — main domain (`investprorealty.net`) setup for transactional + agent inboxes
- `STACK-PLAYBOOK.md` (in `Drive › Gemini › shared accross projects`) — canonical naming conventions
- `PAYMENT-PROVIDERS.md` and `LYMX-PROGRAM.md` — adjacent business-rule docs

**Drafted by Kenny + Claude, 2026-05-05.**

---

## Why a second domain

The two-domain pattern protects sender reputation. Cold prospecting (recruiting agents, owner acquisition pitches, seller leads) is high spam-flag risk and would tank `investprorealty.net`'s reputation if mixed with transactional mail. Keeping cold sends on `investproleads.com` isolates that risk so:

- Rent reminders, owner statements, work-order alerts, password resets always land in inbox
- A bad cold campaign affects only the cold domain, never the main one
- Per-agent reputation can be tracked separately

This mirrors the pattern Fellora uses (`thefellora.com` transactional, `thefellorapartners.com` cold).

---

## TL;DR

1. Domain registered at Cloudflare Registrar 2026-05-05 — already done.
2. SES: verify `investproleads.com` as a domain identity in `us-east-1`, MAIL FROM = `ses.investproleads.com`, paste DKIM CNAMEs into Cloudflare DNS.
3. **DO NOT enable Cloudflare Email Routing** on this zone — outbound only.
4. Reuse existing `investpro-ses-bot` IAM user (one IAM per project per playbook).
5. Add the domain to the existing **Fellora Resend Pro** account.
6. Wire 3 new Netlify env vars: `RESEND_API_KEY_INVESTPRO_LEADS`, `OUTREACH_FROM_DOMAIN`, `OUTREACH_REPLY_TO_DOMAIN`.
7. Run `db/035_outreach.sql` in Supabase.
8. Wait ~7-14 days from DKIM setup to first cold send so reputation has time to age.

---

## Step 1 — Cloudflare DNS (no Email Routing)

Domain is already at Cloudflare Registrar (registered 2026-05-05). Auto-lives on Cloudflare DNS — no nameserver change needed.

1. Cloudflare → `investproleads.com` → DNS → **Records**.
2. **Confirm there is NO MX record** pointing at `*.mx.cloudflare.net`. If you see one (auto-added when Email Routing was enabled by accident), delete it.
3. **Do NOT enable Email Routing** on this zone (Email tab → leave empty/disabled). Reason: we never want to receive mail at `investproleads.com`. Anyone replying to a cold blast should hit the main domain via Reply-To.
4. Get the **Zone ID** from the Overview tab (right rail). Save it as `CF_ZONE_ID_INVESTPRO_LEADS` for env vars later (you don't strictly need a CF API token here since we're not creating routes).

---

## Step 2 — Amazon SES domain identity for the new domain

Reuse Kenny's existing AWS account (the one running `investpro-ses-bot` for the main domain).

### 2a. Verify the domain identity

1. AWS console → SES → make sure region is **us-east-1 (N. Virginia)**.
2. **Verified identities** → **Create identity** → **Domain** → `investproleads.com`.
3. Check **"Use a custom MAIL FROM domain"** → enter `ses.investproleads.com`. (Same `ses` subdomain pattern as the main domain — playbook convention.)
4. Check **"Easy DKIM"** → RSA_2048_BIT (default). SES generates 3 CNAME records.
5. Copy each CNAME → Cloudflare DNS → **Add record** for each (`investproleads.com` zone). Save.
6. Back on SES → **Verify identity**. Within 15 min, SES marks DKIM as **Verified**.

### 2b. SPF record

```
TXT   investproleads.com   "v=spf1 include:amazonses.com ~all"
```

Note: the cold domain's SPF is **simpler** than the main domain's. No `_spf.mx.cloudflare.net` (no inbound), only `amazonses.com` (SES outbound).

### 2c. DMARC (start permissive, tighten later)

```
TXT   _dmarc.investproleads.com   "v=DMARC1; p=none; rua=mailto:dmarc@investprorealty.net"
```

`p=none` for the first 2-4 weeks — monitor reports without rejecting. After confirming all SES sends pass DKIM/SPF alignment, tighten to `p=quarantine` then `p=reject` to defend against spoofing.

The `rua` address points back to the main domain so reports converge with the main domain's DMARC reports.

### 2d. Production access

If your AWS account is already out of SES sandbox (after the main domain's production-access request was approved), this step is **skipped** — the production-access grant is account-wide, not per-domain. New domains automatically inherit the production cap (50,000/day, 14 msg/sec).

If you're still in sandbox, request production access now per the main runbook. Use case description: "Cold outreach campaigns for agent recruiting and property-owner prospecting at InvestPro Realty. Daily volume <500 sends initially. Industry-standard opt-out and bounce handling."

---

## Step 3 — IAM (reuse, do not create new)

**No new IAM user.** The `investpro-ses-bot` user with `AmazonSESFullAccess` already covers any domain identity in the AWS account. Same access keys (`SES_AWS_ACCESS_KEY_INVESTPRO`, `SES_AWS_SECRET_KEY_INVESTPRO`) work for both domains.

Per the STACK-PLAYBOOK convention: one IAM user per project, not per domain. If you ever rotate the keys, both domains stop working at once — but that's a feature, not a bug, since they're both InvestPro.

---

## Step 4 — Resend (add domain to existing Fellora Pro account)

Resend Pro hosts up to 10 domains. Kenny already has `thefellora.com`, `thefellorapartners.com`, `investprorealty.net` (or it'll be there once the main runbook is run). `investproleads.com` becomes the next slot.

1. Resend dashboard (Fellora account) → **Domains** → **Add domain** → `investproleads.com`. Region: us-east-1.
2. Resend gives you 3-4 DNS records (DKIM, MX for tracking, SPF, DMARC).
3. **Skip the MX record** — Resend's MX is for tracking opens/clicks via their inbound, but we don't want any inbound on this domain. Either skip it or add it pointing at Resend's tracking endpoint if you want delivery tracking.
4. Keep the DKIM CNAMEs **separate from SES's DKIM CNAMEs** — they're different keys for different sending paths. Both can coexist; SES signs mail it sends, Resend signs mail it sends.
5. Verify in Resend → status flips Verified within 5-15 min.
6. Resend → **API Keys** → Create → name `investproleads-prod` → save the key starting with `re_` to your password manager.

**Decision: SES vs Resend for cold sends.**
- **SES** — cheaper at high volume ($0.10 per 1,000), supports SNS bounce/complaint webhooks natively, requires more wiring.
- **Resend** — easier API, built-in tracking dashboard, $20/mo Pro plan covers it (already paid), 50k emails/mo.

For InvestPro's first 6-12 months of cold outreach, **use Resend** — Kenny's already paying for it, the tracking UI is good, and 50k/mo is plenty for thousands of leads at controlled cadence. Switch to SES later if volume grows past ~30k/mo regularly.

---

## Step 5 — Netlify env vars

Add these to the InvestPro Netlify site (in addition to the env vars from the main runbook):

| Key | Value | Mark secret? |
|---|---|---|
| `RESEND_API_KEY_INVESTPRO_LEADS` | `re_...` (from step 4.6) | ✅ |
| `OUTREACH_FROM_DOMAIN` | `investproleads.com` | — |
| `OUTREACH_REPLY_TO_DOMAIN` | `investprorealty.net` | — |
| `CF_ZONE_ID_INVESTPRO_LEADS` | (zone ID for investproleads.com) | — |

Trigger a deploy after adding (Deploys → Trigger deploy → Clear cache and deploy site).

---

## Step 6 — Database migration

Run `db/035_outreach.sql` in Supabase (created alongside this runbook). Adds:

- `lead_lists` — buckets you can group prospects under (e.g., "LV Owners 2026-Q2")
- `leads` — individual prospects with email, name, source, status, unsubscribed_at, bounced_at
- `outreach_campaigns` — a sending job: From/Reply-To, subject template, body template, lead_list link
- `outreach_sends` — one row per send attempt (status: queued/sending/sent/bounced/complained/unsubscribed)
- `outreach_unsubscribes` — append-only log of unsubscribe events with email + reason + source
- `outreach_bounces` — append-only log of SES/Resend bounce/complaint events

After migration, verify:

```sql
SELECT count(*) FROM lead_lists;       -- 0 (empty)
SELECT count(*) FROM leads;            -- 0
SELECT count(*) FROM outreach_campaigns; -- 0
```

---

## Step 7 — Reputation aging

**Do not send your first cold campaign for 7-14 days after DKIM is verified.** Reasons:
1. ISPs (Gmail, Outlook, Yahoo) score new domains heavily on age. A 1-day-old domain blasting 1000 cold emails goes straight to spam or gets blacklisted.
2. The longer your DKIM CNAME has been published with no sending, the more "innocent" the domain looks.
3. Industry recommendation is 2-4 weeks of warmup; 7 days is the minimum.

**Warmup ramp** when you do start (per send):
- Day 1: 20 sends, only to addresses you control (test inbox + 1-2 friend addresses) to confirm rendering and tracking
- Day 2-3: 50 sends per day, real but warm leads (people who've expressed interest)
- Day 4-7: 100 sends per day, expanding to cold but high-quality
- Day 8+: 250-500 sends per day max, spread across 4-hour window
- Throttle: never more than 1 send per second from a single sender address

Stay under these caps until you've seen 3 weeks of <2% bounce rate and <0.1% complaint rate. After that, you can ramp to 1k+ sends/day.

---

## Step 8 — Smoke test

Once steps 1-6 are complete and you've waited the warmup period:

1. Sign in to the InvestPro broker portal as broker/compliance/admin_onsite.
2. Go to `/portal/broker/outreach.html` (we'll build this UI in the next session).
3. Create a tiny `lead_lists` row with one lead: your own gmail.
4. Create a campaign: From `kenny@investproleads.com`, Reply-To `kenny@investprorealty.net`, subject "test", body "Hello {first_name}, this is a test."
5. Send. Check both inboxes:
   - **Recipient inbox (your gmail):** the email should arrive showing `kenny@investproleads.com` in the From line, with `Reply-To: kenny@investprorealty.net` in the headers.
   - **Hit reply:** the reply should land in `kenny@investprorealty.net`'s Cloudflare-routed forwarding → your broker gmail. (This is the Reply-To trick — the magic that keeps cold replies converging with normal mail.)
6. Verify the unsubscribe link in the body works — clicks the public landing page → flips the lead's `unsubscribed_at`.
7. Check Resend dashboard → see the send logged, status Delivered.

---

## Routine operations

- **Importing leads:** broker portal → Outreach → Lead Lists → Import CSV. Map columns to `email`, `first_name`, `last_name`, `source`. Duplicates are deduped by email.
- **Composing a campaign:** Outreach → Campaigns → New. Pick a lead list, write subject + body using `{first_name}` / `{last_name}` / `{property_address}` template variables. Save as draft; preview the rendered version against the first 3 leads before sending.
- **Sending:** Click "Queue all" — campaign goes into `outreach_sends` table with status `queued`. The scheduled Netlify function `dispatch-outreach.js` (cron every 10 min) drains the queue at the daily warmup cap.
- **Unsubscribes:** automatic via the public landing page link. Manually unsubscribe by email: SQL update or a future portal action.
- **Bounces / complaints:** Resend webhooks fire to `/.netlify/functions/outreach-webhook` → marks the lead row + appends to `outreach_bounces`. After 1 hard bounce or any complaint, the lead is auto-suppressed (won't receive future sends).

---

## Cost (steady state, 2026-05)

| Item | Volume | Cost |
|---|---|---|
| Cloudflare zone (DNS only, no Email Routing) | 1 | **$0** |
| Cloudflare Registrar | $10.46/yr | **~$0.87/mo** |
| AWS SES | (only if used; Resend covers initial volume) | **$0** |
| Resend Pro (shared with Fellora) | already paid | **$0 incremental** |
| Netlify Functions invocations | <100 / day | covered by free tier |
| Total **incremental** for cold-outreach domain | | **~$0.87/mo** |

The whole second-domain pattern adds less than $1/mo to the project's run rate. Reputation insurance for the main domain is worth it.

---

## Open TODOs (build sequence)

- [ ] Run `db/035_outreach.sql` in Supabase (migration drafted alongside this runbook).
- [ ] Build `/portal/broker/outreach.html` — broker UI: lead lists, campaigns, sends queue, suppression list.
- [ ] Build Netlify function `import-leads-csv.js` — CSV parser that creates `leads` rows.
- [ ] Build Netlify function `send-outreach-test.js` — sends a single campaign to one recipient (for preview/test).
- [ ] Build scheduled Netlify function `dispatch-outreach.js` — cron every 10 min, drains queue under daily/per-second caps.
- [ ] Build Netlify function `outreach-webhook.js` — Resend webhook handler for delivered/bounced/complained events.
- [ ] Build public unsubscribe landing page `/unsubscribe.html?token=...`.
- [ ] Add `outreach.html` link to the broker dashboard navigation.

These will land in subsequent sessions.
