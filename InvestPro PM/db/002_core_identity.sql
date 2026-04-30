-- ============================================================
-- 002 — Core Identity Tables
-- ============================================================
-- Profiles (1 row per Supabase auth user) and Agents (subset of profiles
-- with agent-specific fields like license #, MLS member ID, brokerage).
-- Run after 001.

-- ----------------------------------------------------------------
-- profiles — extends auth.users with role + display info
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role            user_role NOT NULL DEFAULT 'tenant',
  full_name       TEXT,
  email           TEXT,
  phone           TEXT,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  sms_opt_in      BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_url      TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);

-- Auto-touch updated_at on every UPDATE
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_touch_updated ON profiles;
CREATE TRIGGER trg_profiles_touch_updated
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Auto-create a profiles row when a new auth user signs up.
-- Reads role + full_name from the user's signup metadata; defaults to 'tenant'.
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, role, full_name, email)
  VALUES (
    NEW.id,
    COALESCE((NEW.raw_user_meta_data ->> 'role')::user_role, 'tenant'),
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.email),
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- ----------------------------------------------------------------
-- agents — agent-specific data, joined to profiles
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id                  UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  agent_share_code            TEXT UNIQUE,                 -- e.g. 'AGT-X9F2' for ?agent= URL params
  license_number              TEXT NOT NULL,               -- NV S./B. number
  license_type                TEXT,                        -- 'salesperson' | 'broker' | 'broker_associate'
  license_expiry              DATE,
  mls_member_id               TEXT,                        -- GLVAR Matrix MLS ID (manually entered until IDX feed wired up)
  mls_verified                BOOLEAN NOT NULL DEFAULT FALSE,
  mls_verified_at             TIMESTAMPTZ,
  brokerage_name              TEXT,
  brokerage_license           TEXT,
  brokerage_address           TEXT,
  brokerage_phone             TEXT,
  w9_received                 BOOLEAN NOT NULL DEFAULT FALSE,
  w9_storage_path             TEXT,                        -- Supabase Storage path
  w9_received_at              TIMESTAMPTZ,
  commission_split_default_pct NUMERIC(5,2),               -- e.g. 50.00 for 50%
  notes                       TEXT,                        -- broker-only notes
  approved                    BOOLEAN NOT NULL DEFAULT FALSE,  -- broker approves new agents
  approved_at                 TIMESTAMPTZ,
  approved_by                 UUID REFERENCES profiles(id),
  last_synced_with_mls_at     TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_profile ON agents(profile_id);
CREATE INDEX IF NOT EXISTS idx_agents_share_code ON agents(agent_share_code);
CREATE INDEX IF NOT EXISTS idx_agents_license ON agents(license_number);
CREATE INDEX IF NOT EXISTS idx_agents_approved ON agents(approved);

DROP TRIGGER IF EXISTS trg_agents_touch_updated ON agents;
CREATE TRIGGER trg_agents_touch_updated
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Generate a unique 8-char agent share code on insert if not set.
-- Format: 'AGT-XXXX' (4 alphanumeric chars after dash).
CREATE OR REPLACE FUNCTION gen_agent_share_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  candidate TEXT;
  attempts INT := 0;
BEGIN
  IF NEW.agent_share_code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  LOOP
    candidate := 'AGT-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 4));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM agents WHERE agent_share_code = candidate);
    attempts := attempts + 1;
    IF attempts > 10 THEN
      RAISE EXCEPTION 'Could not generate unique agent share code after 10 attempts';
    END IF;
  END LOOP;

  NEW.agent_share_code := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_gen_share_code ON agents;
CREATE TRIGGER trg_agents_gen_share_code
  BEFORE INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION gen_agent_share_code();
