-- ============================================================
-- 013 — Fix: auth trigger blocked by RLS during user creation
-- ============================================================
-- Issue: When Supabase creates a new auth.users row, the trigger
-- handle_new_auth_user() tries to INSERT into public.profiles, but
-- RLS blocks the INSERT (no INSERT policy was defined in 009).
-- Symptoms: "Database error creating new user" when adding users
-- via Authentication → Users → Create new user.
--
-- Fix:
--   1. Grant supabase_auth_admin permission to insert into profiles
--   2. Add a permissive INSERT policy on profiles
--   3. Recreate the trigger function with explicit search_path

-- 1. Grants — let the auth admin role write to profiles
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT INSERT ON public.profiles TO supabase_auth_admin;

-- 2. Permissive INSERT policy (the trigger and authenticated users
--    creating their own profile during signup both pass this)
DROP POLICY IF EXISTS profiles_insert_policy ON profiles;
CREATE POLICY profiles_insert_policy ON profiles
  FOR INSERT
  WITH CHECK (TRUE);

-- 3. Recreate the trigger function with proper search_path
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $f$
BEGIN
  INSERT INTO public.profiles (id, role, full_name, email)
  VALUES (
    NEW.id,
    COALESCE((NEW.raw_user_meta_data ->> 'role')::user_role, 'tenant'),
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.email),
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$f$;

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();
