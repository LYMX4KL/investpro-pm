-- ============================================================
-- 012 — Business-day deadline helpers
-- ============================================================
-- Adds reviewer Vincy's 2026-04-28 clarification: "If the 3-day period
-- falls on a weekend or holiday, the deadline will be extended to the
-- next business day." Applies to MICR return, term sheet acceptance,
-- lease signing, FCRA denial letter, etc.

-- ----------------------------------------------------------------
-- Federal + Nevada state holidays observed (editable by Broker)
-- Stored as a JSONB array of YYYY-MM-DD strings.
-- This list ships with 2026 holidays — update annually via
-- /portal/broker/templates → Holidays.
-- ----------------------------------------------------------------
-- 2026 holidays observed (in order):
--   Jan 01 — New Year's Day
--   Jan 19 — Martin Luther King Jr. Day
--   Feb 16 — Presidents Day
--   May 25 — Memorial Day
--   Jun 19 — Juneteenth
--   Jul 03 — Independence Day (observed; Jul 4 is Saturday)
--   Sep 07 — Labor Day
--   Oct 30 — Nevada Day (observed)
--   Nov 11 — Veterans Day
--   Nov 26 — Thanksgiving
--   Nov 27 — Family Day (Black Friday; InvestPro observes)
--   Dec 25 — Christmas Day
INSERT INTO app_config (key, value, description) VALUES
('observed_holidays_2026',
'["2026-01-01","2026-01-19","2026-02-16","2026-05-25","2026-06-19","2026-07-03","2026-09-07","2026-10-30","2026-11-11","2026-11-26","2026-11-27","2026-12-25"]'::jsonb,
'2026 federal + Nevada holidays. Used by add_business_days() to skip non-business days. Edit annually.')
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------
-- is_business_day(d) — returns TRUE if `d` is a Monday-Friday and
-- not in the observed_holidays list.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_business_day(d DATE)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  dow INT;
  holidays JSONB;
BEGIN
  dow := EXTRACT(ISODOW FROM d)::INT;
  IF dow >= 6 THEN
    RETURN FALSE;
  END IF;

  SELECT value INTO holidays FROM app_config WHERE key = 'observed_holidays_2026';
  IF holidays IS NOT NULL AND holidays @> to_jsonb(to_char(d, 'YYYY-MM-DD')) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

-- ----------------------------------------------------------------
-- add_business_days(start_ts, n) — returns the timestamp that is
-- `n` business days after `start_ts`. If `start_ts` lands on a weekend
-- or holiday, counting starts from the next business day.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION add_business_days(start_ts TIMESTAMPTZ, n INT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
DECLARE
  cursor_date DATE := start_ts::DATE;
  added INT := 0;
BEGIN
  WHILE NOT is_business_day(cursor_date) LOOP
    cursor_date := cursor_date + INTERVAL '1 day';
  END LOOP;

  WHILE added < n LOOP
    cursor_date := cursor_date + INTERVAL '1 day';
    IF is_business_day(cursor_date) THEN
      added := added + 1;
    END IF;
  END LOOP;

  RETURN cursor_date + (start_ts::TIME)::INTERVAL;
END;
$$;

-- ----------------------------------------------------------------
-- Test cases (commented out — uncomment to verify after applying):
-- ----------------------------------------------------------------
-- SELECT add_business_days('2026-04-30 17:00:00-07'::TIMESTAMPTZ, 3);  -- expect Tue May 5
-- SELECT add_business_days('2026-07-02 17:00:00-07'::TIMESTAMPTZ, 3);  -- expect Thu Jul 9 (skips Independence Day + weekend)


-- ----------------------------------------------------------------
-- Trigger: when a lease's keys-released timestamp is set, auto-set
-- the lease's micr_due_at = key release time + 3 business days.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_micr_deadline_on_lease()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fully_executed_at IS NOT NULL AND NEW.micr_due_at IS NULL THEN
    NEW.micr_due_at := add_business_days(NEW.fully_executed_at, 3);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lease_set_micr_deadline ON leases;
CREATE TRIGGER trg_lease_set_micr_deadline
  BEFORE INSERT OR UPDATE OF fully_executed_at ON leases
  FOR EACH ROW EXECUTE FUNCTION set_micr_deadline_on_lease();

-- ----------------------------------------------------------------
-- Trigger: when a term sheet is sent, auto-set acceptance_deadline = sent_at + 3 biz days
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_term_sheet_deadline()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sent_at IS NOT NULL AND NEW.acceptance_deadline IS NULL THEN
    NEW.acceptance_deadline := add_business_days(NEW.sent_at, 3);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_term_set_deadline ON term_sheets;
CREATE TRIGGER trg_term_set_deadline
  BEFORE INSERT OR UPDATE OF sent_at ON term_sheets
  FOR EACH ROW EXECUTE FUNCTION set_term_sheet_deadline();

-- ----------------------------------------------------------------
-- Trigger: when a tenant MICR inspection is created, auto-set deadline_at
-- (3 business days from now) — unless caller already set it.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_inspection_deadline()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inspection_type IN ('move_in_tenant', 'move_out_tenant')
     AND NEW.deadline_at IS NULL THEN
    NEW.deadline_at := add_business_days(COALESCE(NEW.scheduled_for, NOW()), 3);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_insp_set_deadline ON inspections;
CREATE TRIGGER trg_insp_set_deadline
  BEFORE INSERT ON inspections
  FOR EACH ROW EXECUTE FUNCTION set_inspection_deadline();
