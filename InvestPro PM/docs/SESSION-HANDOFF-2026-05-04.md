# Session Handoff — 2026-05-04 (rolling into 2026-05-05)

**For:** future-Claude picking up tomorrow
**From:** Kenny + Claude session ending ~1:15 AM 2026-05-05

---

## What got shipped today

### 1. Shared role-based inboxes (marketing@, info@, support@…)
Extended the existing single-agent email provisioning system so InvestPro can also create shared inboxes that fan out to multiple recipients.

- **`db/034_shared_inbox.sql`** — applied in Supabase. Makes `agent_emails.profile_id` nullable, adds `is_shared`, `shared_forward_to_list (jsonb)`, `shared_display_name`, replaces old `UNIQUE(profile_id, company_id)` with a partial unique index, and adds a CHECK constraint that shared rows must carry 1–5 destinations.
- **`netlify/functions/provision-agent-email.js`** — now accepts three modes:
  - `{ application_id }` — original flow
  - `{ profile_id, company_slug, forward_to, local_part_override? }` — direct staff with optional custom local-part
  - `{ shared: true, company_slug, local_part, forward_to_list: [...1-5...], display_name? }` — shared inbox
  Cloudflare route fans out to all destinations on shared inboxes. New `buildSharedOnboardingEmail()` helper sends a different onboarding template to every recipient.
- **`portal/broker/email-management.html`** — new "+ Provision Email" button + modal with two tabs (Staff member / Shared inbox).
- **`docs/INVESTPRO-EMAIL-SETUP.md`** — runbook for the Cloudflare + SES + IAM setup, aligned with the conventions in `STACK-PLAYBOOK.md` (env-var names suffixed with `_INVESTPRO`, MAIL FROM = `ses.investprorealty.net`, IAM user uses `AmazonSESFullAccess`, CF token name = `investpro-email-routing-bot` with scope = Email Routing Rules → Edit only).

### 2. Live deploy
- Netlify is wired to git auto-publish from `LYMX4KL/investpro-pm`, base directory `InvestPro PM`.
- Final commit `49dbb1d` published in 20s after a no-cache retry.
- Smoke test: `https://investprorealty.net/portal/broker/email-management.html` correctly redirects to login (auth gate works).

---

## Decisions made today (don't re-litigate)

1. **Use Resend Pro on the existing Fellora account** to host InvestPro's outbound domains (no separate Resend account).
2. **Cold outreach goes on a second domain — `investproleads.com`** — bought separately when the first cold campaign is ready. Main domain (`investprorealty.net`) stays clean for transactional. Reply-To pattern: cold sends from `kenny@investproleads.com`, replies route via `Reply-To: kenny@investprorealty.net`.
3. **Buy `investproleads.com` "the week before" the first campaign launches** — not now. Reason: domain reputation isn't worth protecting until there's actually traffic.
4. **Reuse the `investpro-ses-bot` IAM user** for the second domain when it's added. One IAM user covers all InvestPro-owned sender domains (per playbook: one IAM user per project, not per domain).
5. **Runbook conventions match `STACK-PLAYBOOK.md`** — every project (Fellora, InvestPro, future LYMX/CFS) reads from the same naming source.

---

## Today's gotcha — DO NOT REPEAT

The GitHub repo has duplicated structure:
```
investpro-pm/
├── InvestPro PM/         ← Netlify watches this
│   ├── db/, docs/, netlify/, portal/, ...
└── db/, docs/, netlify/, portal/  ← orphaned root-level copies
```

Netlify is configured with **base directory = `InvestPro PM`**. If files are uploaded to repo ROOT instead of inside `InvestPro PM/`, Netlify says "no changes detected in base directory" and skips the deploy entirely.

**When uploading via GitHub web UI:** the URL must include `InvestPro%20PM` (URL-encoded space). Examples:
- ✓ `https://github.com/LYMX4KL/investpro-pm/upload/main/InvestPro%20PM/db`
- ✗ `https://github.com/LYMX4KL/investpro-pm/upload/main/db`

I did this wrong on the first round today; we re-uploaded everything to fix it. The orphaned root copies are still there as clutter — see "Open items" below.

---

## Open items for tomorrow (pick one)

### A. Clean up orphaned repo paths (15 min)
Delete the duplicate root-level `db/`, `docs/`, `netlify/functions/`, `portal/broker/` folders from the GitHub repo. Use GitHub's web UI: navigate into each, click each file → trash icon → commit. Or just leave them; they don't hurt anything except aesthetics.

### B. Wire the `verify-agent-ses.js` button on the email-management modal (30 min)
Currently the "🔐 Verify SES sender" button in the row-detail modal hits `verify-agent-ses.js`, which expects `SES_AWS_ACCESS_KEY_INVESTPRO`/`SES_AWS_SECRET_KEY_INVESTPRO`/`SES_REGION_INVESTPRO` env vars. Those don't exist yet. Setting them up requires Kenny to do the SES + IAM steps in `INVESTPRO-EMAIL-SETUP.md`. Block: needs Kenny to do steps 2 + 3 of the runbook first.

### C. Build the cold-outreach platform foundations (2-3 sessions)
Once `investproleads.com` is bought:
1. Write `docs/INVESTPRO-OUTREACH-SETUP.md` (mirror of the main runbook for the cold-only domain).
2. New schema: `db/035_outreach.sql` with `lead_lists`, `leads`, `outreach_campaigns`, `outreach_sends`, `outreach_unsubscribes`, `outreach_bounces` tables.
3. Broker portal: leads CSV import, campaign composer, send queue, unsubscribe management.
4. Netlify function `send-outreach-campaign.js` (uses SES with `From: kenny@investproleads.com`, `Reply-To: kenny@investprorealty.net`).
5. Webhook handler for SES bounce/complaint SNS events.
6. Public unsubscribe landing page.

Kenny has thousands of leads ready to send (recruiting, owner prospecting, seller prospecting). This is the next major build whenever he's ready.

### D. Run the full email setup per `INVESTPRO-EMAIL-SETUP.md` (45 min)
The 6 steps in the runbook. Requires Kenny to do CF zone setup, GoDaddy nameserver change, SES domain verification + DKIM CNAMEs, IAM user creation, 5 Netlify env vars, and seed the company row's `cloudflare_zone_id`. After that, he can provision real agent emails.

---

## Suggested first move tomorrow

Ask Kenny: "What do you want to tackle — clean up the orphaned folders (A), do the live SES + Cloudflare setup (D), or jump into the cold-outreach scope (C)?"

If he says C, the natural sequence is: buy `investproleads.com` first → SES domain identity for it → schema + portal + send function → unsubscribe + bounce handling.

---

## Reference files added today

- `db/034_shared_inbox.sql` — applied to Supabase
- `docs/INVESTPRO-EMAIL-SETUP.md` — runbook (review before doing setup steps)
- `docs/SESSION-HANDOFF-2026-05-04.md` — this file
- `netlify/functions/provision-agent-email.js` — updated (3 modes)
- `portal/broker/email-management.html` — updated (Provision modal)

All paths above are inside `Desktop\Gemini\InvestPro PM\` locally and inside `InvestPro PM\` in the GitHub repo.

---

*End of 2026-05-04 handoff.*

---

## Session 2026-05-05 update — Path C kicked off

- Bought `investproleads.com` at Cloudflare Registrar (~$10.46/yr, auto-renew on).
- Wrote `docs/INVESTPRO-OUTREACH-SETUP.md` — second-domain runbook (mirror of main runbook, scoped to outbound-only — no CF Email Routing on this zone).
- Wrote `db/035_outreach.sql` — schema for `lead_lists`, `leads`, `lead_list_members`, `outreach_campaigns`, `outreach_sends`, `outreach_unsubscribes`, `outreach_bounces`. Plus helpers `lead_can_receive(lead, campaign)` and `refresh_outreach_campaign_counts(campaign)`.

**Outreach platform built end-to-end (10 files):**

| File | Purpose |
|---|---|
| `docs/INVESTPRO-OUTREACH-SETUP.md` | Second-domain runbook (CF DNS without Email Routing, SES, IAM reuse, Resend, warmup ramp) |
| `db/035_outreach.sql` | 7 tables + 5 enums + RLS + audit + 2 helper functions (`lead_can_receive`, `refresh_outreach_campaign_counts`) |
| `netlify/functions/import-leads-csv.js` | CSV ingest with fuzzy column mapping, dedupe, dry-run preview |
| `netlify/functions/queue-outreach-campaign.js` | Creates `outreach_sends` rows for every active lead in the campaign's list |
| `netlify/functions/dispatch-outreach.js` | Scheduled (every 10 min) — drains queue, calls Resend, persists message-id, writes List-Unsubscribe headers |
| `netlify/functions/outreach-webhook.js` | Resend Svix-signed webhook — auto-suppresses on hard bounce / complaint |
| `netlify/functions/unsubscribe-outreach.js` | Public no-auth GET/POST — flips `lead.unsubscribed_at`, writes audit row |
| `portal/broker/outreach.html` | 4-tab broker UI: Lead Lists, Campaigns, Sends, Suppression |
| `portal/broker/dashboard.html` | Modified — added Outreach nav link |
| `unsubscribe.html` | Public landing page (root) — confirm email, capture optional reason |

**End-to-end flow that's wired (but not deployed yet):**
1. Broker uploads CSV → leads + lead_list_members rows created
2. Broker composes campaign → "Save & queue all" → outreach_sends rows queued
3. Dispatch cron renders templates, calls Resend, marks sent
4. Resend webhook marks delivered / bounced / complained
5. Recipient clicks unsubscribe link → public page → audit row written

**Tomorrow's pickup checklist:**
- [ ] Run `db/035_outreach.sql` in Supabase
- [ ] Push all 10 files to GitHub at `InvestPro PM/...` paths
- [ ] Verify Netlify deploy picks up the new scheduled function
- [ ] Walk through the SES + CF DNS setup for `investproleads.com` per `INVESTPRO-OUTREACH-SETUP.md` (steps 1-2)
- [ ] Add domain to Fellora's Resend Pro → grab API key
- [ ] Wire 4 new Netlify env vars: `RESEND_API_KEY_INVESTPRO_LEADS`, `OUTREACH_FROM_DOMAIN`, `OUTREACH_REPLY_TO_DOMAIN`, `RESEND_WEBHOOK_SECRET_INVESTPRO_LEADS`
- [ ] Configure Resend webhook URL → `/.netlify/functions/outreach-webhook`
- [ ] Wait 7-14 days for DKIM aging before first cold send

**Update 2026-05-05 PM:** all 10 files pushed to GitHub.
