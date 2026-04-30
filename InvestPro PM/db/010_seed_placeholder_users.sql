-- ============================================================
-- 010 — Seed staff accounts (real emails)
-- ============================================================
-- Per Kenny's 2026-04-29 update: using real emails so staff can log in
-- and use the platform from day one.
--
-- HOW TO USE THIS FILE:
-- 1. In Supabase Dashboard → Authentication → Users → "Add user → Create
--    new user" — create one user per row in the table below.
-- 2. Use whatever temporary password you'd like — share it with each
--    person and have them reset it on first login.
-- 3. Once all 7 users exist, run this file in the SQL Editor. It assigns
--    each user the correct role + display name.
-- 4. Hand the temporary credentials to each person via Slack / phone /
--    in-person. They log in and reset password on first sign-in.
--
-- ┌──────────────────────────────────────────────────────────────────────────────────────┐
-- │ EMAIL                                  │ ROLE          │ DISPLAY NAME              │
-- ├──────────────────────────────────────────────────────────────────────────────────────┤
-- │ zhongkennylin@gmail.com                │ broker        │ Kenny Lin                 │
-- │ admin.va@investprorealty.net           │ va            │ Neil (VA)                 │
-- │ accounting@investprorealty.net         │ accounting    │ Jeff (Accounting)         │
-- │ mandy.investprorealty@gmail.com        │ compliance    │ Mandy (Compliance)        │
-- │ chen-helen0510c@gmail.com              │ leasing       │ Helen Chen (Leasing)      │
-- │ service@investprorealty.net            │ pm_service    │ Elizabeth (PM/Service)    │
-- │ johnson-admin@investprorealty.net      │ admin_onsite  │ Omyko Johnson (Admin)     │
-- └──────────────────────────────────────────────────────────────────────────────────────┘

-- After creating the auth.users rows in the Dashboard, the trigger from
-- 002_core_identity.sql auto-creates a profiles row with role='tenant'.
-- This block UPDATES those profiles to set the correct role + name.
--
-- NOTE: Supabase normalizes emails to lowercase, so we use LOWER() in the
-- WHERE clause to match regardless of capitalization at signup time.

UPDATE profiles SET role = 'broker',       full_name = 'Kenny Lin'
  WHERE LOWER(email) = LOWER('zhongkennylin@gmail.com');

UPDATE profiles SET role = 'va',           full_name = 'Neil (VA)'
  WHERE LOWER(email) = LOWER('admin.va@investprorealty.net');

UPDATE profiles SET role = 'accounting',   full_name = 'Jeff (Accounting)'
  WHERE LOWER(email) = LOWER('accounting@investprorealty.net');

UPDATE profiles SET role = 'compliance',   full_name = 'Mandy (Compliance)'
  WHERE LOWER(email) = LOWER('mandy.investprorealty@gmail.com');

UPDATE profiles SET role = 'leasing',      full_name = 'Helen Chen (Leasing)'
  WHERE LOWER(email) = LOWER('helen0510c@gmail.com');

UPDATE profiles SET role = 'pm_service',   full_name = 'Elizabeth (PM/Service)'
  WHERE LOWER(email) = LOWER('service@investprorealty.net');

UPDATE profiles SET role = 'admin_onsite', full_name = 'Omyko Johnson (Admin)'
  WHERE LOWER(email) = LOWER('admin@investprorealty.net');

-- Verify — should return all 7 staff with their assigned roles:
SELECT email, role, full_name FROM profiles
WHERE role IN ('broker','va','accounting','compliance','leasing','pm_service','admin_onsite')
ORDER BY
  CASE role
    WHEN 'broker' THEN 1
    WHEN 'va' THEN 2
    WHEN 'accounting' THEN 3
    WHEN 'compliance' THEN 4
    WHEN 'leasing' THEN 5
    WHEN 'pm_service' THEN 6
    WHEN 'admin_onsite' THEN 7
  END;
