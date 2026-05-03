# Company Email Provisioning — Architecture & Setup Guide

**Audience:** project leads building a multi-agent platform that needs to give each new hire a `name@company.tld` email without paying $7/user/month for Google Workspace.

**Pattern in plain English:** when an agent joins the platform, our system automatically creates their company email address, sets it up to forward to their personal Gmail, and sends them a one-time onboarding message that walks them through replying *as* the company address. They keep using their normal Gmail (or Outlook) — no new app to learn.

This pattern works at any scale. Production cost for **1,000 agents sending ~100 emails/month each is roughly $10/month total**. Compare that to ~$7,000/month for Google Workspace at the same headcount.

---

## 1. Architecture overview

```
INBOUND (someone emails name@company.tld)
   │
   ├─ DNS MX records point to Cloudflare
   │
   ├─ Cloudflare Email Routing receives the message
   │     • Free tier — unlimited inbound volume
   │     • One "route" per agent (or one catch-all worker rule for scale)
   │
   ├─ Forwards to the agent's verified personal email (Gmail, Outlook, etc.)
   │
   └─ Agent reads in their normal inbox

OUTBOUND (agent replies / sends new mail)
   │
   ├─ Agent uses Gmail/Outlook "Send mail as" feature
   │
   ├─ Send goes via Amazon SES SMTP relay
   │     • $0.10 per 1,000 emails — pay only for what you send
   │     • Per-agent verified identity at company.tld
   │
   ├─ Recipient sees: From: name@company.tld
   │
   └─ Reply comes back through inbound flow
```

Two separate services, two separate purposes. **Cloudflare = inbound forwarding. SES = outbound sending.** Both are billed independently.

---

## 2. One-time setup per company domain

Do this once for each company (InvestPro, LYMX, CFS, etc.). Plan ~45 minutes per domain.

### 2.1 Cloudflare — inbound side

1. Add the domain to Cloudflare (free plan is fine). Update the registrar's nameservers to Cloudflare's.
2. In Cloudflare dashboard → **Email** → **Email Routing** → **Get Started**.
3. Cloudflare automatically adds the required MX + TXT records. Click **Add records** when prompted.
4. Add at least one verified destination (your own Gmail) so you can test.
5. Note the **Zone ID** under Overview → API → Zone ID. You'll need this in env vars.
6. Create an API token: **My Profile** → **API Tokens** → **Create Token** → use the "Edit zone DNS" template, restrict to this zone, plus add the **Email Routing Rules** permission. Copy the token — you only see it once.

### 2.2 Amazon SES — outbound side

1. AWS Console → **Simple Email Service** → pick a region (us-east-1 or us-west-2 are common).
2. **Verified identities** → **Create identity** → choose **Domain** → enter `company.tld`.
3. SES gives you 3 DKIM CNAME records → add them to Cloudflare DNS.
4. Wait ~5 minutes. SES marks the domain as verified.
5. **Request production access** — by default SES is in "sandbox" (you can only send to verified addresses, max 200/day). Production access is a one-paragraph form, usually approved within 24 hours.
6. Create an IAM user with policy `AmazonSESFullAccess`. Generate access key + secret. Save them.
7. **SMTP credentials** — in SES, "Get SMTP credentials" generates a username/password pair you'll use as Gmail's "Send mail as" SMTP login.

### 2.3 DNS records (final state per domain)

```
MX   @                    → Cloudflare's MX hosts (added by step 2.1)
TXT  @                    → "v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all"
TXT  _dmarc               → "v=DMARC1; p=none; rua=mailto:dmarc-reports@company.tld"
CNAME _domainkey-cf       → Cloudflare DKIM (set by Cloudflare automatically)
CNAME [3 SES DKIM records] → Amazon SES (from step 2.2)
```

The shared `SPF` record above is critical. It tells the world "messages claiming to be from this domain via Cloudflare *or* via Amazon SES are legitimate." Without this, outbound messages land in spam.

---

## 3. Per-agent automation (what the platform does)

When `agent_applications.status` flips to `joined` (manager approves them), this happens automatically:

### Step 1 — Generate the local-part
```
first.last  e.g. helen.smith@investprorealty.net
```
On collision, suffix with a digit:
```
helen.smith.2@investprorealty.net
helen.smith.3@investprorealty.net
```

### Step 2 — Save record
Insert a row into `agent_emails`:
```
profile_id, company_id, local_part='helen.smith',
full_email='helen.smith@investprorealty.net',
forward_to='helen.personal.address@gmail.com',
status='pending'
```

### Step 3 — Add Cloudflare route
POST to `https://api.cloudflare.com/client/v4/zones/{zone_id}/email/routing/rules` with:
```json
{
  "name": "Forward helen.smith",
  "enabled": true,
  "matchers": [{"type":"literal","field":"to","value":"helen.smith@investprorealty.net"}],
  "actions":  [{"type":"forward","value":["helen.personal@gmail.com"]}]
}
```
Save the returned `id` as `cloudflare_route_id` so we can remove it later if the agent leaves.

### Step 4 — Verify SES sender identity
Call SES `CreateEmailIdentity` for the new address. SES emails the address (which forwards to the agent's Gmail) with a verification link. Once they click it, SES marks them verified and they can send-as that address.

### Step 5 — Send onboarding email
Email the agent's personal address (via Resend or SES) with:
- "Welcome — your new company email is helen.smith@investprorealty.net"
- Step-by-step Gmail "Send mail as" walkthrough with their SMTP credentials
- A "verify your sender identity" link from SES
- Where to ask for help

### Step 6 — Mark active
After the agent completes the SES verification email and confirms their Gmail setup, update `agent_emails.status='active'`.

---

## 4. Database schema (multi-tenant ready)

```sql
-- Companies / brands using the platform
CREATE TABLE companies (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                        TEXT UNIQUE NOT NULL,    -- 'investpro', 'lymx', 'cfs'
  name                        TEXT NOT NULL,           -- 'InvestPro Realty'
  primary_domain              TEXT NOT NULL UNIQUE,    -- 'investprorealty.net'
  cloudflare_zone_id          TEXT,                    -- from Cloudflare dashboard
  ses_region                  TEXT DEFAULT 'us-east-1',
  ses_domain_verified         BOOLEAN DEFAULT false,
  active                      BOOLEAN DEFAULT true,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- Per-agent provisioned emails
CREATE TABLE agent_emails (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id                  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company_id                  UUID NOT NULL REFERENCES companies(id),

  -- The generated address
  local_part                  TEXT NOT NULL,          -- 'helen.smith'
  full_email                  TEXT NOT NULL UNIQUE,   -- 'helen.smith@investprorealty.net'
  forward_to                  TEXT NOT NULL,          -- the agent's personal email

  -- Lifecycle
  status                      TEXT NOT NULL DEFAULT 'pending',
                                 -- pending → active → suspended → deleted
  cloudflare_route_id         TEXT,                   -- saved so we can DELETE on offboarding
  ses_identity_verified       BOOLEAN DEFAULT false,

  provisioned_at              TIMESTAMPTZ,
  onboarding_email_sent_at    TIMESTAMPTZ,
  agent_acknowledged_at       TIMESTAMPTZ,
  suspended_at                TIMESTAMPTZ,

  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(profile_id, company_id)
);
```

Each platform deployment uses the same schema. Multi-tenancy is achieved by `company_id` on every record.

---

## 5. Environment variables (Netlify / your hosting)

Per company you want to provision agents for:

```
CF_ZONE_ID_INVESTPRO              → Cloudflare zone ID for investprorealty.net
CF_API_TOKEN_INVESTPRO             → Cloudflare API token (Email Routing Rules + Edit zone DNS)
SES_AWS_ACCESS_KEY_INVESTPRO      → AWS access key with SES permissions
SES_AWS_SECRET_KEY_INVESTPRO      → AWS secret
SES_REGION_INVESTPRO              → e.g. us-east-1

# Repeat for each domain
CF_ZONE_ID_LYMX = ...
SES_AWS_ACCESS_KEY_LYMX = ...
```

Or store these on the `companies` table (encrypted) for true multi-tenant SaaS pattern. For 3 known domains, env vars are simpler.

---

## 6. Cost projections

Assuming each agent receives + sends about 100 messages per month.

| Headcount | Inbound (CF) | Outbound (SES) | Total / month |
|---|---|---|---|
| 100 agents | $0 | $1 | **$1** |
| 1,000 agents | $0 | $10 | **$10** |
| 10,000 agents | $0 | $100 | **$100** |
| 100,000 agents | $0 | $1,000 | **$1,000** |

Compare to **Google Workspace at $6 per user per month**:
- 1,000 agents → $6,000/mo
- 10,000 agents → $60,000/mo

The break-even is around **2 agents** — at 3+ agents this architecture is already cheaper than any traditional mailbox hosting.

---

## 7. Onboarding email template

Sent to the agent's personal email when their account is provisioned.

```
Subject: Welcome to [COMPANY] — your work email is ready

Hi [FIRST_NAME],

Your [COMPANY] email is ready: [GENERATED_EMAIL]

Incoming mail to that address forwards directly to this inbox
([PERSONAL_EMAIL]) — nothing for you to set up there.

To send messages that look like they're from [COMPANY] (instead of
your personal address), follow these one-time steps in Gmail:

  1. Gmail → Settings → "Accounts and Import" tab
  2. Under "Send mail as" click "Add another email address"
  3. Name: [FULL_NAME]
     Email: [GENERATED_EMAIL]
     Uncheck "Treat as an alias" (important — keeps your replies
     looking professional)
     Click Next

  4. SMTP Server: email-smtp.[SES_REGION].amazonaws.com
     Port: 587
     Username: [SMTP_USERNAME]
     Password: [SMTP_PASSWORD]
     Secured connection: TLS
     Click Add account

  5. Gmail emails [PERSONAL_EMAIL] with a verification code
  6. Enter the code → done

Now when you compose a message, you can pick [GENERATED_EMAIL] in
the From dropdown. Replies to messages that came in via [GENERATED_EMAIL]
default to that address automatically.

Need help? Reply to this email or call us at [SUPPORT_PHONE].

— [COMPANY]
```

Include the SMTP username/password from SES Step 2.7.

---

## 8. Offboarding (when an agent leaves)

1. Set `agent_emails.status = 'suspended'` and `suspended_at = NOW()`.
2. DELETE the Cloudflare route using the saved `cloudflare_route_id`.
3. Optionally remove the SES identity (or keep it suspended — costs nothing if dormant).
4. Inbound mail to that address now bounces.
5. Agent's Gmail "Send mail as" stops working (SMTP credentials revoked when SES identity is removed).

Audit trail: keep the `agent_emails` row forever — never delete. The audit_log table preserves the full history.

---

## 9. Troubleshooting

**Outbound emails landing in spam:**
- Verify SPF record includes both `_spf.mx.cloudflare.net` AND `amazonses.com`
- Check DKIM CNAMEs are deployed (in Cloudflare DNS)
- Set DMARC to `p=none` initially, monitor reports for a week, then move to `p=quarantine`
- New SES accounts have a "warm-up" period — send small volumes first

**Inbound forwarding not working:**
- Check Cloudflare Email Routing → "Routes" — is the rule enabled?
- Check the destination Gmail address is verified in Cloudflare
- Cloudflare adds `Auto-Submitted: auto-replied` headers — Gmail trusts these but other providers may flag

**SES "domain not verified" after 1 hour:**
- DKIM CNAMEs use long random strings — easy to typo. Re-check exact match in Cloudflare DNS.
- Cloudflare's CDN may cache old DNS — toggle the cloud icon to gray (DNS only, not proxied) for the CNAME records.

**Agent says "Send mail as" verification email never arrived:**
- Their SES identity isn't verified yet → SMTP relay rejects the message
- Verify SES identity in AWS Console first, THEN ask them to set up Gmail

**API rate limits:**
- Cloudflare: 1,200 requests / 5 minutes per token. Not a concern unless onboarding hundreds of agents in one batch.
- SES sandbox: 200 emails / 24 hours. Production access lifts this to 50,000/day initially.

---

## 10. Security notes

- API tokens (Cloudflare + AWS) live ONLY in server-side env vars. Never expose to the browser.
- SMTP credentials per agent: store encrypted (use a `pgcrypto` or app-side AES key). When agent's status flips to suspended, rotate or revoke.
- Audit-log every provisioning + offboarding action. Court-defensible per the platform's audit trail rules.
- DMARC alignment: ensure SES "Mail-From" domain matches the From: header — SES does this when domain identity is verified.

---

*Document version 1.0 — 2026-05-02. Update this doc when adding a new company or changing the email provisioning flow.*
