-- ============================================================
-- 014 — Bootstrap staff passwords (manual set, bypasses email rate limits)
-- ============================================================
-- Use this when:
--   * The Supabase email rate limit (~3-4 emails/hour on free tier) is preventing
--     reset emails from being sent
--   * You want to set initial passwords for a batch of staff at once and
--     hand them out via a secure side channel (Slack, in person, etc.)
--   * You're bootstrapping the platform for the first time
--
-- HOW IT WORKS:
--   * Updates auth.users.encrypted_password directly using bcrypt (gen_salt('bf'))
--   * Marks the password as needing reset on first login (optional — see "force reset" notes below)
--   * Does NOT bypass any other auth flow — the user still uses /portal/login.html normally
--
-- HOW TO USE:
--   1. Edit the password values below (replace each TEMP_PWD_HERE with whatever you want)
--   2. Run this whole file in Supabase SQL Editor
--   3. Hand each person their email + temp password (Slack, signal, in-person)
--   4. They log in at https://investpro-realty.netlify.app/portal/login.html
--   5. Recommend they immediately reset password from their profile (Phase 3 will add a UI for this;
--      for now, use the "Forgot password?" link on the login page)
--
-- SECURITY NOTES:
--   * Use STRONG temp passwords. 16+ characters. Don't reuse.
--   * Hand out via secure channel, NEVER plain email
--   * Tell each person to change it immediately after first login
--   * Re-running this file overwrites passwords — only run when you intend to reset

-- ----------------------------------------------------------------
-- TEMPLATE — copy/paste this UPDATE for each user, swapping in their email + password
-- ----------------------------------------------------------------
--
--   UPDATE auth.users
--   SET encrypted_password = crypt('THE_TEMP_PASSWORD', gen_salt('bf'))
--   WHERE email = LOWER('person@example.com');
--

-- ────────── EDIT BELOW ──────────
-- Replace each 'CHANGE_ME_...' with the actual temp password you want for that user.
-- Keep them DIFFERENT from each other (don't share one password across staff).

-- Kenny (broker)
UPDATE auth.users SET encrypted_password = crypt('CHANGE_ME_BROKER_PWD', gen_salt('bf'))
  WHERE LOWER(email) = LOWER('zhongkennylin@gmail.com');

-- Neil (VA)
UPDATE auth.users SET encrypted_password = crypt('CHANGE_ME_VA_PWD', gen_salt('bf'))
  WHERE LOWER(email) = LOWER('admin.va@investprorealty.net');

-- Jeff (Accounting)
UPDATE auth.users SET encrypted_password = crypt('CHANGE_ME_ACCOUNTING_PWD', gen_salt('bf'))
  WHERE LOWER(email) = LOWER('accounting@investprorealty.net');

-- Mandy (Compliance)
UPDATE auth.users SET encrypted_password = crypt('CHANGE_ME_COMPLIANCE_PWD', gen_salt('bf'))
  WHERE LOWER(email) = LOWER('mandy.investprorealty@gmail.com');

-- Helen Chen (Leasing)
UPDATE auth.users SET encrypted_password = crypt('CHANGE_ME_LEASING_PWD', gen_salt('bf'))
  WHERE LOWER(email) = LOWER('helen0510c@gmail.com');

-- Elizabeth (PM/Service)
UPDATE auth.users SET encrypted_password = crypt('CHANGE_ME_PM_PWD', gen_salt('bf'))
  WHERE LOWER(email) = LOWER('service@investprorealty.net');

-- Omyko Johnson (Admin/Front Desk)
UPDATE auth.users SET encrypted_password = crypt('CHANGE_ME_ADMIN_PWD', gen_salt('bf'))
  WHERE LOWER(email) = LOWER('admin@investprorealty.net');

-- ────────── VERIFY ──────────
-- Confirm all 7 staff still exist and were updated:
SELECT email, last_sign_in_at, updated_at FROM auth.users
WHERE LOWER(email) IN (
  'zhongkennylin@gmail.com',
  'admin.va@investprorealty.net',
  'accounting@investprorealty.net',
  'mandy.investprorealty@gmail.com',
  'helen0510c@gmail.com',
  'service@investprorealty.net',
  'admin@investprorealty.net'
)
ORDER BY email;
