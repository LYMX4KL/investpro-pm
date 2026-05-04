# Online Rent Collection — Provider Comparison

**Status:** decision pending. Tenant portal currently captures auto-pay enrollment intent only; broker calls tenant to set up bank info securely. This doc compares cheap eCheck/ACH options for actual rent pulls.

**Drafted by Kenny + Claude, 2026-05-04.**

---

## The math: why not Stripe (for rent)

A $2,000/mo rent payment on Stripe credit card = **2.9% + $0.30 = $58.30 per transaction**. On 100 properties that's $5,830/month — completely unworkable for PM.

Stripe ACH is much more reasonable (0.8% capped at $5), but there are even cheaper options that are PM-industry standard.

---

## Comparison

### Recommended for InvestPro: Dwolla or Forte

| Provider | Per-transaction fee | Setup | Strengths | Weaknesses |
|---|---|---|---|---|
| **Dwolla** | **$0.50 flat** ($1 expedited) | KYC + bank verification | White-label friendly. Direct ACH. Robust APIs. Used by ~5,000 fintechs. | Requires monthly minimum on Pro tier ($1,500 setup, $99/mo). Standard tier has volume caps. |
| **Forte (CSG)** | $0.40–$1 eCheck | Merchant account application | PM-industry default. Integrated with Buildium, AppFolio, Yardi. | Slightly higher fees on micro-volume. Older API. |
| **Plaid Transfer** | $0.50 ACH ($1 expedited) | Plaid Link + Transfer | Best UX (tenant logs into their bank instead of typing routing/account). Reduces fraud. | Newer product, less PM-specific. |
| **Authorize.net eCheck** | $0.75 + 0.75% (capped) | Merchant account | Mature, reliable. Already used by many PM shops. | Older UX. Slightly more expensive on big rents. |
| Stripe ACH | 0.8% capped at $5 | Existing Stripe account | Fastest to set up if you already have Stripe. | Higher fees on $625+ rents. |
| GoCardless | 1% capped at $4 | UK-based, US growing | Good for international tenants. | Less common in US PM. |

### Why Dwolla or Forte typically win for PM

1. **Predictable per-transaction cost** ($0.50 flat) — easier to communicate to tenants and bake into your fee structure.
2. **PM-friendly compliance**: both handle NACHA rules, return-item handling, NSF fees natively.
3. **White-label flows**: tenant sees "InvestPro Realty" branding, not "Pay via Dwolla".

---

## Recommendation

**Phase 1 (now → 50 properties):** Stay with mailed checks + phone-collected ACH info entered into your bank's biz banking online ACH module. Cost: **free** (or whatever your bank charges per ACH, usually $0–$1).

**Phase 2 (50–250 properties):** Pick **Dwolla** or **Forte** depending on which has the better integration with your accounting (QuickBooks, Buildium, etc.). Pass the $0.50 fee through to the tenant or absorb it as a cost of doing business — most PMs absorb it, since tenants pick AutoPay only when it's "free" to them.

**Phase 3 (250+ properties / multi-broker):** Consider a full PM-native solution like AppFolio or Buildium with their integrated payments stack. Their fees are higher but they collapse the whole stack (accounting + portal + payments + maintenance + lease docs) into one system.

---

## What the system does today

When a tenant clicks "Request Auto-pay Setup" on `/portal/tenant-dashboard.html`:

1. They submit: phone, best time to call, preferred method (ACH/eCheck/unsure), preferred pull day (1st / 3rd / 5th / 15th), notes.
2. **No bank account info is collected via the form** (security + compliance reason).
3. Netlify function `autopay-enroll.js` emails the broker with the enrollment intent + tenant phone.
4. Tenant gets an auto-acknowledgment email with the broker's call window expectations.
5. Broker calls tenant, captures routing + account number over the phone, enrolls them in your bank's online business banking ACH module (or Dwolla/Forte once selected).

This means we don't need PCI/NACHA compliance on the InvestPro web app — bank data lives only in your bank or your eventual ACH provider's vault.

---

## Questions to lock before picking a provider

1. **What's your monthly rent collection volume today?** (If <$50K/mo, Dwolla's monthly minimum may not pencil out; Forte or Stripe ACH might be better.)
2. **Are you using QuickBooks or Buildium for your books?** That likely dictates the easiest integration.
3. **Do you want to charge tenants the ACH fee, or absorb it?** If you charge it, set the fee on your fee schedule (we have an `nsf_fee` already, but you'd add a new payment_method called 'ach_with_fee').
4. **Will agents (as Stage-2 LYMX Businesses) need their own ACH for collecting commission from clients?** If so, the provider needs to support sub-merchant accounts (Dwolla and Forte both do).

---

## Implementation outline (when ready)

When you've picked a provider, the wiring is:

1. New table `tenant_payment_methods` — columns: `id`, `tenant_profile_id`, `lease_id`, `provider_account_id` (token from Dwolla/Forte/Plaid — never raw bank info), `last_four`, `bank_name`, `verification_status`, `created_at`.
2. New Netlify function `process-rent-charge.js` — runs after `generate-rent-charges.js`. For each "due" rent row where the tenant has an active payment method, calls the provider API to initiate transfer.
3. Webhook handler `provider-webhook.js` — receives provider events (transfer settled, returned, etc.) and updates the matching `payments` row's status (pending → paid → failed).
4. Tenant portal Pay Rent section: add "Manage payment methods" link that uses the provider's hosted UI (Plaid Link, Dwolla Drop-In, etc.) to add a verified bank account.
