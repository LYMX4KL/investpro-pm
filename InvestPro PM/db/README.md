# InvestPro PM Platform — Database Migrations

This folder contains the SQL files that build the platform's data model in Supabase.

## How to apply (one-time setup)

1. Log into your Supabase project at https://supabase.com
2. Go to **SQL Editor** (left sidebar)
3. Open each file in this folder **in numerical order**, paste contents, and click **Run**
4. After each file: check the **Database → Tables** view to confirm new tables appeared

**Run files in this exact order — later files reference earlier ones:**

| # | File | What it creates |
|---|---|---|
| 001 | `001_extensions_enums.sql` | UUID extension + all enum types (roles, statuses) |
| 002 | `002_core_identity.sql` | `profiles` (1 per auth user) + `agents` |
| 003 | `003_properties.sql` | `properties` + `mls_listings` |
| 004 | `004_applications.sql` | `applications` + co-apps + pets + signatures + documents |
| 005 | `005_screening_workflow.sql` | `verifications`, `screening_reports`, `communications`, `tasks` |
| 006 | `006_lease_lifecycle.sql` | `term_sheets`, `leases`, `calendar_events`, `reviews` |
| 007 | `007_email_templates.sql` | `email_templates` table + seed templates |
| 008 | `008_storage.sql` | Storage buckets (application-docs, etc.) |
| 009 | `009_rls_policies.sql` | Row Level Security policies for every table |
| 010 | `010_seed_placeholder_users.sql` | Placeholder VA / Accounting / Compliance accounts |
| 011 | `011_inspections.sql` | Inspections (pre-move-in + tenant MICR + future annual/move-out) + checklist seed |
| 012 | `012_business_day_helpers.sql` | `is_business_day()` / `add_business_days()` + auto-deadline triggers (Vincy's weekend/holiday rollover rule) |

## Re-running migrations

Each file is **idempotent** (uses `CREATE TABLE IF NOT EXISTS` etc.) so you can re-run safely. To start from scratch, run `999_drop_all.sql` first (DESTRUCTIVE — only on a dev project).

## Auth model

We use the 12-role permission model defined in PM-PLATFORM-PLAN.md §2:

```
Internal: broker · va · accounting · compliance · leasing · pm_service · admin_onsite
External: applicant · tenant · owner · agent_listing · agent_showing
```

Every Supabase auth user gets a corresponding `profiles` row (auto-created via trigger) with their assigned role. RLS policies enforce who can see what.

## Storage buckets

After running `008_storage.sql`, four buckets exist:
- `application-docs` — applicant uploads (ID, paystubs, bank statements)
- `verification-results` — VOR/VOE/credit reports
- `signed-documents` — signed term sheets, leases, addendums
- `screening-summaries` — generated PDF summaries

All have RLS so applicants can only see their own files, VA/Broker can see everything for apps assigned to them, etc.

## Notes

- **Why so many enums?** Postgres enums make impossible states unrepresentable (you can't typo a status). The trade-off is adding a new value requires a migration. We accept that.
- **Why TEXT for some fields instead of varchar(N)?** Postgres treats them identically; TEXT removes arbitrary length limits.
- **Why JSONB for some fields (like `additional_terms`, `ai_parsed_summary`)?** Flexibility for fields whose shape will evolve. Trade-off: harder to query into. We accept that for non-critical metadata.
