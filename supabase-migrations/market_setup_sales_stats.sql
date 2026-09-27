-- Market Setup + Sales Stats: tags Shopify POS orders as belonging to a
-- scheduled farmers market vs. informal/friend POS sales, and adds settings
-- rows backing the new /stats dashboard page. Run in the Supabase SQL
-- editor. Order matters: markets must exist before orders.market_id can
-- reference it.

-- One row per recurring market. Matching is "active" markets only (see
-- src/lib/marketMatching.ts) — day_of_week is 0=Sunday..6=Saturday to match
-- JS Date#getDay().
CREATE TABLE IF NOT EXISTS markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  season_start_date date NOT NULL,
  season_end_date date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE markets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS markets_shared_policy ON markets;
CREATE POLICY markets_shared_policy ON markets
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE markets TO authenticated;

-- orders: additive/nullable. channel/billing_name come from Shopify's
-- sourceName (API) / "Source" column (CSV export); market_id/pos_category
-- are computed at import time (and by the Markets page's "Recalculate
-- Market Tags" action) by src/lib/marketMatching.ts. Existing rows backfill
-- channel/billing_name by re-running an import over their date range
-- (processNormalizedOrders upserts on shopify_order_id).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS market_id uuid REFERENCES markets(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pos_category text
  CHECK (pos_category IN ('market', 'other'));

CREATE INDEX IF NOT EXISTS idx_orders_market_id ON orders(market_id);

-- Weekly Revenue Target, one row per business scope (BotanIQals and
-- MiniLeaf each set their own; "All Businesses" on the Stats page combines
-- both). Upserted client-side with onConflict:"scope" — no seed rows
-- needed, a missing scope row just means "target not set yet" (0).
CREATE TABLE IF NOT EXISTS stats_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL UNIQUE CHECK (scope IN ('botaniqals', 'minileaf')),
  weekly_revenue_target numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stats_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stats_settings_shared_policy ON stats_settings;
CREATE POLICY stats_settings_shared_policy ON stats_settings
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE stats_settings TO authenticated;

-- Singleton row (fixed-id-upsert, same pattern as demand_calibration_settings
-- / notification_config) holding the exact Shopify lineitem name(s) that
-- count as "the bundle" for the Bundle Attach Rate KPI. Settings-driven
-- rather than hardcoded so it survives a variant rename without a deploy.
CREATE TABLE IF NOT EXISTS bundle_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_lineitem_names text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bundle_settings (id)
VALUES ('f0000000-0000-0000-0000-000000000001'::uuid)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE bundle_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bundle_settings_shared_policy ON bundle_settings;
CREATE POLICY bundle_settings_shared_policy ON bundle_settings
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE bundle_settings TO authenticated;
