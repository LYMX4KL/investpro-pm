# InvestPro Realty — Company Email Setup Runbook

**Concrete one-time steps to wire `@investprorealty.net` company emails for staff and shared inboxes.**

This is the project-specific cookbook. Read alongside:
- `COMPANY-EMAIL-ARCHITECTURE.md` — general inbound + outbound design
- `STACK-PLAYBOOK.md` (in `Drive › Gemini › shared accross projects`) — canonical naming conventions for ALL Lin family projects (Fellora, LYMX, CFS, InvestPro, etc.). This runbook follows those conventions.

**Drafted by Kenny + Claude, 2026-05-04.**

---

## TL;DR

1. Cloudflare: add `investprorealty.net` as a zone, enable Email Routing, point GoDaddy MX to Cloudflare.
2. SES: verify domain identity in `us-east-1` with MAIL FROM = `ses.investprorealty.net`, paste DKIM CNAMEs into Cloudflare DNS, request production access.
3. IAM: create the `investpro-ses-bot` user with `AmazonSESFullAccess`, save its access keys.
4. Netlify: paste 5 env vars into the InvestPro site (`CF_API_TOKEN_INVESTPRO`, `CF_ZONE_ID_INVESTPRO`, `SES_REGION_INVESTPRO`, `SES_AWS_ACCESS_KEY_INVESTPRO`, `SES_AWS_SECRET_KEY_INVESTPRO`).
5. Run `db/027_company_emails.sql` and `db/034_shared_inbox.sql` in Supabase (027 may already be applied).
6. Test by provisioning a single email from `/portal/broker/email-management.html`.

Once step 6 works for one address, marketing teams (`marketing@`, `info@`, `sales@`, `support@`) can be created with the **Shared inbox** tab on the same page.

---

## Step 1 — Cloudflare zone + Email Routing

### 1a. Add the zone

1. Cloudflare dashboard → **Add a Site** → enter `investprorealty.net` → Free plan.
2. Cloudflare scans existing DNS records from GoDaddy. Confirm the A / CNAME for the Netlify site is preserved.
3. Cloudflare gives you two nameservers (e.g. `andre.ns.cloudflare.com`, `lara.ns.cloudflare.com`).
4. **GoDaddy → My Domains → investprorealty.net → DNS → Nameservers → Change → enter the two CF nameservers.** Save.
5. Wait 5–60 minutes for propagation. CF dashboard will say **"Active"** once it's done.

### 1b. Enable Email Routing

1. Cloudflare → `investprorealty.net` → **Email** (left sidebar) → **Email Routing** → **Get Started**.
2. CF asks you to verify a destination address — use Kenny's gmail (`zhongkennylin@gmail.com`). CF emails a 6-digit code; paste it back.
3. CF auto-adds 3 MX records and 1 SPF TXT — **leave them**. They look like:
   ```
   MX   investprorealty.net   isaac.mx.cloudflare.net   86400
   MX   investprorealty.net   linda.mx.cloudflare.net   86400
   MX   investprorealty.net   amir.mx.cloudflare.net    86400
   TXT  investprorealty.net   "v=spf1 include:_spf.mx.cloudflare.net ~all"
   ```
4. **DON'T** enable the "Catch-all" rule — we want each provisioned address to be explicit so Suspend works.

### 1c. Add destination addresses

For every personal email that will receive forwarded mail (every staff member's gmail, every member of a shared inbox), add it once as a verified destination:

1. CF Email Routing → **Routes** → **Destination addresses** → **Add destination**.
2. Enter `helen@gmail.com` (or whichever) → CF emails them → recipient clicks the link.
3. Until they click, CF will refuse to use that address as a forward target.

This is a one-time per-recipient step. The provision-agent-email function will fail gracefully (route returns an error in `cloudflare_last_error`) until the destination is verified.

### 1d. Get the API token + Zone ID

**Zone ID:** CF → `investprorealty.net` → **Overview** → right rail, copy **Zone ID**.

**API token:**
1. CF → My Profile (top right) → **API Tokens** → **Create Token** → **Custom token**.
2. Token name: `investpro-email-routing-bot` (matches the playbook `<project>-email-routing-bot` pattern).
3. Permissions (least privilege — only this one):
   - Zone → **Email Routing Rules** → Edit
4. Zone Resources: Include → Specific zone → `investprorealty.net`.
5. TTL: leave blank (no expiration) or set 1 year for rotation.
6. Create → save the token (starts with `cfut_`). You only see it once.

You now have:
- `CF_ZONE_ID_INVESTPRO` = the zone ID
- `CF_API_TOKEN_INVESTPRO` = the token

---

## Step 2 — Amazon SES

### 2a. Verify the domain identity

1. AWS console → make sure region is **us-east-1 (N. Virginia)** (top right). All env vars assume this region; pick a different one only if you have a reason and update `SES_REGION_INVESTPRO` accordingly.
2. SES → **Verified identities** → **Create identity** → **Domain** → `investprorealty.net`.
3. Check **"Use a custom MAIL FROM domain"** → enter `ses.investprorealty.net`. (Per the STACK-PLAYBOOK convention — subdomain is `ses`, not `mail`.)
4. Check **"Easy DKIM"** → RSA_2048_BIT (default). SES generates 3 CNAME records like:
   ```
   xyz123._domainkey.investprorealty.net   →   xyz123.dkim.amazonses.com
   ```
5. Copy each CNAME. Cloudflare → DNS → **Add record** for each. Save.
6. Back on SES → **Verify identity**. Within 15 min, SES marks DKIM as **Verified**.

### 2b. Update SPF to include SES

In Cloudflare DNS, find the existing SPF TXT for `investprorealty.net` (from CF Email Routing — `v=spf1 include:_spf.mx.cloudflare.net ~all`) and **change it to**:

```
v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all
```

This is the critical SPF-alignment line. Without it, your outbound mail will hit recipient spam folders.

### 2c. Add DMARC

```
TXT   _dmarc.investprorealty.net   "v=DMARC1; p=none; rua=mailto:dmarc@investprorealty.net"
```

`p=none` means "monitor only, don't reject" — switch to `p=quarantine` once you've watched the DMARC reports for a couple of weeks and confirmed no legitimate mail is being marked.

### 2d. Request production access

By default SES is in **sandbox mode** — you can only send to verified addresses. To send to anyone:

1. SES → **Account dashboard** → **Request production access**.
2. Use case: "Transactional and team email for InvestPro Realty agents and shared role-based inboxes (marketing@, info@, support@). One company per identity. Daily volume: under 1,000 emails. Bounce/complaint handling: configured via SNS to a dedicated mailbox; will suspend identities with bounce >5% or complaint >0.1%."
3. AWS approves within 24 hours typically.

Until production access is granted, only the email addresses you've verified can receive mail from your SES sender — staff Gmail addresses you've already verified for inbound forwarding will work as test recipients.

---

## Step 3 — IAM user for SES

Per the STACK-PLAYBOOK pattern: one IAM user per project (`<project>-ses-bot`), attached to the AWS managed `AmazonSESFullAccess` policy.

1. AWS console → **IAM** → **Users** → **Create user** → name: `investpro-ses-bot`. Don't enable console access.
2. **Permissions** → **Attach policies directly** → search **"AmazonSESFullAccess"** → check it. (Managed policy, matches Fellora setup. If you want stricter scope later, you can swap in a custom inline policy that allows only `ses:SendEmail`, `ses:SendRawEmail`, `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`, `ses:DeleteEmailIdentity`.)
3. Create user → click into the user → **Security credentials** tab → **Create access key** → **Application running outside AWS**.
4. Description tag: `Netlify production - SES API access for InvestPro`.
5. Copy (only shown once):
   - `SES_AWS_ACCESS_KEY_INVESTPRO` = AKIA...
   - `SES_AWS_SECRET_KEY_INVESTPRO` = (long string)

---

## Step 4 — Netlify env vars

Netlify dashboard → InvestPro site → **Site settings** → **Environment variables** → **Add a variable**. Add all five:

All env-var names follow the playbook's `<KEY>_<PROJECT>` suffix pattern so credentials don't collide if multiple projects share the AWS account later.

| Key | Value | Source | Mark secret? |
|---|---|---|---|
| `CF_API_TOKEN_INVESTPRO` | (CF token from 1d) | Cloudflare API tokens | ✅ |
| `CF_ZONE_ID_INVESTPRO` | (CF zone ID from 1d) | Cloudflare → Overview | — |
| `SES_REGION_INVESTPRO` | `us-east-1` | Hardcoded | — |
| `SES_AWS_ACCESS_KEY_INVESTPRO` | `AKIA...` | IAM user access key | ✅ |
| `SES_AWS_SECRET_KEY_INVESTPRO` | (secret) | IAM user access key | ✅ |

You should already have these from earlier steps:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `FROM_EMAIL` (e.g. `InvestPro Realty <onboarding@resend.dev>`)

Trigger a deploy after adding them (Deploys → Trigger deploy → Clear cache and deploy site).

---

## Step 5 — Database migrations

Run in Supabase SQL editor in order, only if not already applied:

1. `db/027_company_emails.sql` — creates `companies` + `agent_emails` tables, seeds InvestPro row.
2. `db/034_shared_inbox.sql` — adds shared-inbox columns and makes `profile_id` nullable.

After both are run, sanity-check:

```sql
SELECT slug, name, primary_domain, active FROM companies;
-- Expect: investpro | InvestPro Realty | investprorealty.net | true

SELECT column_name, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'agent_emails'
    AND column_name IN ('profile_id', 'is_shared');
-- Expect: profile_id | YES   AND   is_shared | NO
```

Then manually update the InvestPro company row with the Cloudflare zone ID:

```sql
UPDATE companies
   SET cloudflare_zone_id = 'PASTE-ZONE-ID-HERE',
       cloudflare_setup_complete = TRUE
 WHERE slug = 'investpro';
```

---

## Step 6 — Smoke test

1. Sign in to the InvestPro broker portal (you must be `broker`, `compliance`, or `admin_onsite`).
2. Go to **Email Management** (`/portal/broker/email-management.html`).
3. Click **+ Provision Email** (top right).
4. **Mode = Staff member.**
5. Pick a profile from the dropdown (yourself works for the first test). Leave local-part blank — it will auto-generate `first.last`. Forward-to should auto-fill from the profile email.
6. Click **Provision**. Expected:
   - The new row appears in the table with status **Active** and the **Routed** pill (green).
   - The agent's personal inbox receives the onboarding email.
   - Sending a test email from any external account to `first.last@investprorealty.net` lands in their gmail within ~30 seconds.
7. Now test shared-inbox mode:
   - **+ Provision Email** → **Shared inbox**.
   - Local-part: `marketing`.
   - Forward to (one per line): your gmail + one teammate's verified gmail.
   - Display name: `Marketing Team`.
   - Click **Provision**. The new row should appear with `is_shared = TRUE`.
   - Send a test email to `marketing@investprorealty.net` — every recipient on the list should receive a copy.
8. Click the row in the table to open the detail modal → **Verify SES sender** → SES emails the address (which forwards back to the agent's gmail). They click the verification link → row's `ses_identity_verified` flips to true.

If any step fails, check:
- Cloudflare → Email Routing → Routes — does the route exist?
- The `cloudflare_last_error` column on the agent_emails row — is the destination verified?
- Resend dashboard — was the onboarding email sent?
- Netlify function logs — any 500s in `provision-agent-email`?

---

## Routine operations

- **Suspend:** broker portal → Email Management → click the row → **⏸ Suspend**. The CF route stays in place but the row is marked suspended in the audit trail. (TODO: have suspend also disable the CF route via API.)
- **Reactivate:** same modal, **▶ Reactivate**.
- **Add a new shared inbox member:** today this means deleting the route in CF and re-provisioning with the updated list. (TODO: in-place edit endpoint.)
- **Offboard an agent:** suspend the row, then in Cloudflare Email Routing → Routes → delete the matching route manually. (TODO: `deprovision-agent-email.js` function.)

---

## Cost (steady state, 2026-05)

| Item | Volume | Cost |
|---|---|---|
| Cloudflare Email Routing inbound | unlimited | **$0** |
| Cloudflare zone | 1 | **$0** (Free plan) |
| SES outbound | 1,000 emails/mo | **$0.10** |
| SES outbound | 50,000 emails/mo | **$5.00** |
| AWS Route 53 / IAM | n/a | **$0** |
| Resend onboarding emails | ~200/mo | covered in your existing Resend tier |

Even at 1,000 staff and 100,000 outbound emails/mo, the bill is around **$10/mo**. Compare with Google Workspace at ~$7/seat/mo = $7,000/mo for the same headcount.

---

## Open TODOs

- [ ] Hook the **Verify SES sender** button to call `verify-agent-ses.js` — currently uses hardcoded SES region; should read `SES_REGION` env var.
- [ ] Build `deprovision-agent-email.js` to clean up CF route on suspend/delete.
- [ ] Add a "regenerate local-part" flow when a name changes.
- [ ] Wire the SMTP credential delivery: when SES identity verifies, generate IAM SMTP creds and email them to the agent (encrypted), so they can complete Gmail "Send mail as".
- [ ] Add SES bounce/complaint webhook → SNS → Netlify function → flip the row's status to suspended automatically when bounce >5%.
