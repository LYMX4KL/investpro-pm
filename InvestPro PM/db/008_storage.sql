-- ============================================================
-- 008 — Storage Buckets
-- ============================================================
-- Supabase Storage buckets for file uploads. Run in Supabase SQL Editor;
-- Storage policies are then configured in the Storage UI or via the SQL below.
--
-- IMPORTANT: Bucket creation via SQL requires the supabase_admin role.
-- If running via the SQL Editor as a regular user, create buckets via the
-- Storage UI instead and skip the INSERT statements (just run the policies).

-- ----------------------------------------------------------------
-- Create buckets (run as admin, or skip + create in Storage UI)
-- ----------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('application-docs',
   'application-docs',
   FALSE,                                                       -- private
   10485760,                                                    -- 10 MB max
   ARRAY['image/jpeg', 'image/png', 'image/heic', 'application/pdf']::text[]),
  ('verification-results',
   'verification-results',
   FALSE,
   20971520,                                                    -- 20 MB
   ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]),
  ('signed-documents',
   'signed-documents',
   FALSE,
   20971520,
   ARRAY['application/pdf']::text[]),
  ('screening-summaries',
   'screening-summaries',
   FALSE,
   10485760,
   ARRAY['application/pdf']::text[]),
  ('agent-w9s',
   'agent-w9s',
   FALSE,
   5242880,                                                     -- 5 MB
   ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[])
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------
-- Storage RLS policies — run after buckets exist
-- ----------------------------------------------------------------

-- Policy: Authenticated users can upload to application-docs (during application submission)
DROP POLICY IF EXISTS "applicants upload application-docs" ON storage.objects;
CREATE POLICY "applicants upload application-docs"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'application-docs');

-- Policy: Authenticated users can read their own uploads (path convention: <user_id>/<filename>)
DROP POLICY IF EXISTS "users read own application-docs" ON storage.objects;
CREATE POLICY "users read own application-docs"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'application-docs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Internal staff (broker/va/accounting/compliance/leasing) can read all application-docs
DROP POLICY IF EXISTS "staff read all application-docs" ON storage.objects;
CREATE POLICY "staff read all application-docs"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id IN ('application-docs', 'verification-results', 'signed-documents', 'screening-summaries')
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('broker', 'va', 'accounting', 'compliance', 'leasing')
    )
  );

-- Policy: Staff can write to verification-results, signed-documents, screening-summaries
DROP POLICY IF EXISTS "staff write internal buckets" ON storage.objects;
CREATE POLICY "staff write internal buckets"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id IN ('verification-results', 'signed-documents', 'screening-summaries')
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('broker', 'va', 'accounting', 'compliance', 'leasing')
    )
  );

-- Policy: Agents can upload their own W-9
DROP POLICY IF EXISTS "agents upload w9" ON storage.objects;
CREATE POLICY "agents upload w9"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'agent-w9s'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('agent_listing', 'agent_showing')
    )
  );

-- Policy: Broker + Accounting can read all W-9s (for 1099 prep)
DROP POLICY IF EXISTS "staff read w9s" ON storage.objects;
CREATE POLICY "staff read w9s"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'agent-w9s'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('broker', 'accounting')
    )
  );
