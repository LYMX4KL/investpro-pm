-- ============================================================
-- 003 — Properties + MLS Listings
-- ============================================================
-- Properties under InvestPro management, plus a cache of MLS data
-- pulled from the IDX feed (when wired up).

-- ----------------------------------------------------------------
-- mls_listings — daily-synced cache of GLVAR Matrix listings via IDX
-- (When IDX vendor is identified, a sync job populates this table)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mls_listings (
  mls_id              TEXT PRIMARY KEY,             -- vendor's listing ID
  address             TEXT NOT NULL,
  city                TEXT,
  state               TEXT NOT NULL DEFAULT 'NV',
  zip                 TEXT,
  bedrooms            INT,
  bathrooms           NUMERIC(3,1),
  sqft                INT,
  monthly_rent        NUMERIC(10,2),
  listing_agent_mls_id TEXT,                        -- joins to agents.mls_member_id
  photos              JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of URLs
  raw_payload         JSONB,                         -- full IDX response (for debugging / future fields)
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mls_listing_agent ON mls_listings(listing_agent_mls_id);

-- ----------------------------------------------------------------
-- properties — InvestPro-managed properties (subset of MLS, plus PMA-only)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS properties (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Address
  address_line1                   TEXT NOT NULL,
  address_line2                   TEXT,
  city                            TEXT NOT NULL DEFAULT 'Las Vegas',
  state                           TEXT NOT NULL DEFAULT 'NV',
  zip                             TEXT NOT NULL,
  -- Listing details
  property_type                   TEXT,                       -- 'condo' | 'townhome' | 'sfh' | 'duplex' | 'apartment'
  bedrooms                        INT,
  bathrooms                       NUMERIC(3,1),
  sqft                            INT,
  year_built                      INT,
  parking                         TEXT,                       -- '1 covered' | '2 garage' | etc.
  -- Pricing
  monthly_rent                    NUMERIC(10,2) NOT NULL,
  security_deposit_amount         NUMERIC(10,2),              -- typically = monthly rent, can be higher per applicant
  pet_deposit_amount              NUMERIC(10,2),              -- this is a "fee" per Joan's note (non-refundable)
  pet_rent_monthly                NUMERIC(10,2),
  -- Pet policy
  pets_allowed                    TEXT,                       -- 'none' | 'cats' | 'dogs' | 'both' | 'case_by_case'
  -- HOA / community
  hoa_name                        TEXT,
  hoa_dues                        NUMERIC(10,2),
  has_pool                        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Sewer/trash policy (NV law: must be included in rent now, not separate)
  -- Stored here for legacy display; not for new term sheets
  sewer_trash_included_in_rent    BOOLEAN NOT NULL DEFAULT TRUE,
  -- MLS link
  mls_listing_id                  TEXT REFERENCES mls_listings(mls_id) ON DELETE SET NULL,
  -- Relationships
  owner_id                        UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  listing_agent_id                UUID REFERENCES agents(id) ON DELETE SET NULL,
  -- InvestPro internal grouping
  pm_group                        TEXT,                       -- e.g. 'KL' for Kenny Group properties
  -- Status / lifecycle
  status                          property_status NOT NULL DEFAULT 'vacant',
  days_on_market_started_at       TIMESTAMPTZ,
  default_lease_signing_window_days INT NOT NULL DEFAULT 3,   -- broker can override per-property
  listing_at                      DATE,
  -- Free-form description
  description                     TEXT,
  features                        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of strings: ["central a/c", "in-unit w/d", ...]
  -- Photos override (defaults to mls_listings.photos if linked)
  photos_override                 JSONB,
  -- Audit
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
CREATE INDEX IF NOT EXISTS idx_properties_owner ON properties(owner_id);
CREATE INDEX IF NOT EXISTS idx_properties_listing_agent ON properties(listing_agent_id);
CREATE INDEX IF NOT EXISTS idx_properties_pm_group ON properties(pm_group);
CREATE INDEX IF NOT EXISTS idx_properties_mls ON properties(mls_listing_id);

DROP TRIGGER IF EXISTS trg_properties_touch_updated ON properties;
CREATE TRIGGER trg_properties_touch_updated
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
