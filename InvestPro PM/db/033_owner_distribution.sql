-- ============================================================
-- 033 — Add 'owner_distribution' to payment_type enum
-- ============================================================
-- Track payouts InvestPro sends to property owners as their own
-- payment-type so they're filterable on the owner statement and
-- in the payment ledger reports.
--
-- Recorded as a NEGATIVE amount on the payments table — it reduces
-- the running owed-to-owner balance.
--
-- Background: Kenny 2026-05-04 — closes the financial loop on the
-- owner side (rent collected → PM fee → vendor expense → distribution paid).
-- ============================================================

ALTER TYPE payment_type ADD VALUE IF NOT EXISTS 'owner_distribution';

-- NOTE: cannot SELECT enum_range(NULL::payment_type) in the same transaction —
-- Postgres requires new enum values to be committed before being used. Run that
-- verification query separately if you want to confirm the value was added.
