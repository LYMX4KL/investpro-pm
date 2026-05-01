-- ============================================================
-- 020 — In-site feedback system
-- ============================================================
-- Replaces the mailto: feedback button with a real database table so the
-- broker can see all feedback in one place, filter by status, and mark
-- items resolved. Helen suggested this 2026-04-30 — better than scattered
-- emails for soft-launch testing and beyond.
--
-- WHO CAN DO WHAT:
--   * Anyone signed in: INSERT (their own feedback)
--   * Broker, compliance: SELECT all, UPDATE (mark resolved)
--   * Submitter: SELECT their own only
-- ============================================================


-- ----------------------------------------------------------------
-- 1. feedback table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who sent it
  user_id            UUID REFERENCES profiles(id) ON DELETE SET NULL,
  user_name          TEXT,                          -- snapshot at submit time
  user_email         TEXT,
  user_role          TEXT,
  -- Where
  page_url           TEXT,
  page_title         TEXT,
  user_agent         TEXT,
  -- What
  category           TEXT NOT NULL DEFAULT 'general',  -- 'bug' | 'suggestion' | 'question' | 'praise' | 'general'
  message            TEXT NOT NULL,
  -- Workflow
  status             TEXT NOT NULL DEFAULT 'new',      -- 'new' | 'in_progress' | 'resolved' | 'wontfix'
  resolution_notes   TEXT,
  resolved_at        TIMESTAMPTZ,
  resolved_by        UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Audit
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);

DROP TRIGGER IF EXISTS trg_feedback_touch_updated ON feedback;
CREATE TRIGGER trg_feedback_touch_updated
  BEFORE UPDATE ON feedback
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMENT ON TABLE feedback IS
  'In-site feedback from team members and end users. Replaces ad-hoc email reports.';


-- ----------------------------------------------------------------
-- 2. RLS
-- ----------------------------------------------------------------
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can submit feedback (their own)
DROP POLICY IF EXISTS feedback_self_insert ON feedback;
CREATE POLICY feedback_self_insert ON feedback
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- Broker + compliance see all feedback, can update status
DROP POLICY IF EXISTS feedback_admin_all ON feedback;
CREATE POLICY feedback_admin_all ON feedback
  FOR ALL TO authenticated
  USING (current_user_role() IN ('broker', 'compliance'))
  WITH CHECK (current_user_role() IN ('broker', 'compliance'));

-- Submitter can read their own feedback
DROP POLICY IF EXISTS feedback_self_read ON feedback;
CREATE POLICY feedback_self_read ON feedback
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ----------------------------------------------------------------
-- 3. VERIFY
-- ----------------------------------------------------------------
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename = 'feedback'
ORDER BY policyname;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'feedback'
ORDER BY ordinal_position;
