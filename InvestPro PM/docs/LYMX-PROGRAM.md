# InvestPro × LYMX — Program Reference

**Status:** branding live; full earn-on-transaction wiring deferred.
**Owner:** Kenny — last updated 2026-05-03.

This doc is the single source of truth for how InvestPro Realty integrates with **LYMX** (the network-spendable cashback currency, run out of `LYMX Power/`, public site `getlymx.com`). Update this any time the rules change.

---

## What "Powered by LYMX" means here

InvestPro Realty is registering as a **LYMX Business** on the LYMX network. Every InvestPro customer (tenant, owner, agent, buyer, seller, free subscriber) holds the same LYMX wallet they would use at any other LYMX-network business — coffee shops, restaurants, retail, etc. LYMX issued by InvestPro is spendable across the entire LYMX network, and LYMX earned elsewhere can be redeemed against InvestPro fees.

**Phase 1 (today):** branding only. Subscribers earn LYMX into a local InvestPro ledger (`subscribers.lymx_balance` + `subscriber_lymx_log`). The 100-LYMX welcome bonus is live. Earn-on-transaction is **not yet wired** — earn rates are documented below as policy, not enforced.

**Phase 2 (TBD):** sync to real LYMX network wallet via `getlymx.com` API. Local balance becomes a mirror of the network balance.

---

## Who earns LYMX, on what, at what rate

Earn rates are **TBD by Kenny** — defaults below are placeholders to drive design decisions. Adjust before wiring. **Rent itself does not earn LYMX** (it's not InvestPro's revenue), and LYMX **cannot be redeemed against rent**.

| Actor              | Earning event                                | Default rate (placeholder) | Funded from              | Source enum                   |
| ------------------ | -------------------------------------------- | -------------------------- | ------------------------ | ----------------------------- |
| Tenant             | Pays monthly rent on time                    | 1% of rent (marketing)     | InvestPro PM-fee margin¹ | `earn_rent_payment`           |
| Tenant             | Pays rental application fee ($35–$50)        | 5% of fee                  | Application-fee revenue  | `earn_application_fee`        |
| Owner              | PM fee debited from monthly rent             | 5% of PM fee               | PM-fee revenue           | `earn_pm_fee`                 |
| Owner              | Lease processing fee ($100)                  | 5% of fee                  | Lease-fee revenue        | `earn_pm_fee`                 |
| Agent              | Office dues paid                             | 5% of dues                 | Office-due revenue       | `earn_office_dues`            |
| Agent              | Agent transaction fee paid                   | 5% of txn fee              | Agent-txn-fee revenue    | `earn_agent_transaction_fee`  |
| Buyer / Seller     | Closing transaction fee paid to InvestPro    | 5% of fee                  | Transaction-fee revenue  | `earn_transaction_fee`        |
| Free subscriber    | Welcome bonus (live today)                   | 100 LYMX flat              | Marketing budget         | `signup_bonus`                |
| Subscriber sponsor | Their referral signs up free                 | 50 LYMX flat               | Marketing budget         | `referral_signup`             |
| Subscriber sponsor | Their referral becomes an InvestPro agent    | 500 LYMX flat              | Marketing budget         | `referral_agent_joined`       |

¹ **Open question on tenant-rent LYMX:** rent goes to the owner, not InvestPro. If InvestPro gives 1% LYMX on rent ($20 on a $2,000 lease), it's a marketing expense — eats ~$16 of margin per month per leased unit. Kenny to decide: (a) pull from PM-fee margin, (b) bill the owner, or (c) drop it and only earn on fees actually paid to InvestPro.

---

## Where LYMX can be redeemed

| Redeemable against                | Allowed?       | Notes                                                    |
| --------------------------------- | -------------- | -------------------------------------------------------- |
| Rental application fee            | ✅ Yes         |                                                          |
| Lease processing fee              | ✅ Yes         |                                                          |
| PM fee (owner)                    | ✅ Yes         |                                                          |
| Office dues (agent)               | ✅ Yes         |                                                          |
| Agent transaction fee             | ✅ Yes         |                                                          |
| Closing transaction fee (buy/sell)| ✅ Yes         |                                                          |
| Maintenance charges               | ✅ Yes         | At Kenny's discretion — TBD                              |
| **Rent**                          | **❌ No**      | Hard rule — rent flows to owner, not InvestPro           |
| Security deposit                  | ❌ No          | Held in trust, not InvestPro revenue                     |
| Pet fee / late fee                | TBD            | Defer to per-fee policy                                  |

LYMX is also redeemable across the LYMX network (any participating business — see `getlymx.com`). InvestPro doesn't control off-network redemption.

---

## Conversion convention

Following the LYMX-network convention: **1 LYMX ≈ $0.01 face value**, i.e. 100 LYMX = $1. A LYMX Business buys promotional credit at 80% face value (so 100 LYMX issued = $0.80 cost to InvestPro, $1.00 face value to the customer). When LYMX is redeemed, the redeeming business is paid back at 80% of face value out of the network pool.

---

## Schema notes

The local ledger lives in `db/030_subscribers.sql`:

- `subscribers.lymx_balance`, `subscribers.lymx_lifetime` — cached running totals (NUMERIC(12,2))
- `subscribers.lymx_network_synced`, `subscribers.lymx_network_id` — placeholders for the future API sync to `getlymx.com`
- `subscriber_lymx_log` — append-only ledger; every issuance and redemption
- `award_lymx(subscriber_id, lymx, source, source_ref_id, source_ref_type, description)` — atomic insert + balance update; **always use this**, never UPDATE the cached columns directly
- `lymx_source` enum — earn/redemption sources, includes the `earn_*` events listed above for when we wire them up

When earn-on-transaction is wired, each fee-payment Netlify function (or DB trigger on the `payments` table) should call `award_lymx()` with the appropriate `source` enum and a `source_ref_id` pointing to the payment row. Idempotency must be preserved — don't double-award if a webhook retries.

---

## Open decisions

1. **Funding source for tenant-rent LYMX** (see footnote ¹ above) — Kenny to pick.
2. **Final earn rates** per fee type — placeholders above; Kenny to lock.
3. **Real LYMX API sync** — InvestPro's LYMX Business sign-up on `getlymx.com` and webhook plumbing for wallet sync. Phase 2.
4. **Redemption flow UX** — where does a tenant click "use LYMX" when paying an application fee? Tenant portal payment page; not built yet.
5. **Agent dashboard LYMX widget** — show balance + recent earnings on portal. Not built yet.

---

## Public copy

Pages already updated with "Powered by LYMX" branding:

- `index.html` — hero "Join Free · Earn LYMX", LYMX band before recruiting, footer line
- `subscribe.html` — full LYMX-first copy
- `forms/subscriber-welcome.html` — wallet messaging + share code
- All public pages — "Powered by LYMX" line in footer-bottom

Tone: factual, light on hype. We say "earn LYMX cashback" and "redeemable against fees", never "rewards points". The yellow strong-tag (`#FFD66B`) on dark navy footer keeps the LYMX brand colour distinct.
