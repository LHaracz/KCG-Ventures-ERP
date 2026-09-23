-- Fulfillments Part 2 (+ 2b revisions): local status pipeline, EasyPost label
-- log, carrier mapping, and shared ship-from settings.
-- Run in the Supabase SQL editor.
--
-- Note: this file was revised for Part 2b (voided_at/rate_amount/
-- rate_currency columns, new seed rows) before ever being applied. If you
-- already ran an earlier version of this file in Supabase, ask for a small
-- standalone ALTER TABLE instead of re-running this whole file.

-- One row per order once its status first advances past the default
-- display-only "preparing_shipment" state. Shared (not per-user) — this
-- describes a fact about a Shopify order, not something owned by one login.
CREATE TABLE IF NOT EXISTS order_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'preparing_shipment'
    CHECK (status IN ('preparing_shipment', 'label_generated', 'label_printed', 'fulfilled')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_status_shopify_order_id ON order_status(shopify_order_id);

ALTER TABLE order_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_status_shared_policy ON order_status;
CREATE POLICY order_status_shared_policy ON order_status
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE order_status TO authenticated;

-- Append-only history of purchased EasyPost labels per order. The most
-- recent row per shopify_order_id is treated as "the current label."
CREATE TABLE IF NOT EXISTS fulfillment_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL,
  tracking_number text,
  carrier text,
  service text,
  label_url text,
  easypost_shipment_id text,
  rate_amount numeric,
  rate_currency text,
  fulfilled_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_log_shopify_order_id ON fulfillment_log(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_log_fulfilled_at ON fulfillment_log(fulfilled_at);

ALTER TABLE fulfillment_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fulfillment_log_shared_policy ON fulfillment_log;
CREATE POLICY fulfillment_log_shared_policy ON fulfillment_log
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE fulfillment_log TO authenticated;

-- Shopify shipping-line title -> EasyPost carrier/service. Small, hand-edited
-- directly in the SQL editor; no in-app management UI in Part 2.
CREATE TABLE IF NOT EXISTS shipping_method_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_title text NOT NULL UNIQUE,
  easypost_carrier text NOT NULL,
  easypost_service text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE shipping_method_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shipping_method_map_shared_policy ON shipping_method_map;
CREATE POLICY shipping_method_map_shared_policy ON shipping_method_map
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE shipping_method_map TO authenticated;

INSERT INTO shipping_method_map (shopify_title, easypost_carrier, easypost_service) VALUES
  ('ground advantage', 'USPS', 'GroundAdvantage'),
  ('priority mail', 'USPS', 'Priority')
ON CONFLICT (shopify_title) DO NOTHING;

-- Single shared ship-from address row, modeled on notification_config's
-- fixed-id upsert pattern (see src/app/settings/notifications/page.tsx).
CREATE TABLE IF NOT EXISTS fulfillments_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_from_name text NOT NULL DEFAULT '',
  ship_from_address1 text NOT NULL DEFAULT '',
  ship_from_address2 text NOT NULL DEFAULT '',
  ship_from_city text NOT NULL DEFAULT '',
  ship_from_state text NOT NULL DEFAULT '',
  ship_from_zip text NOT NULL DEFAULT '',
  ship_from_country text NOT NULL DEFAULT 'US',
  ship_from_phone text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fulfillments_settings (id)
VALUES ('c0000000-0000-0000-0000-000000000001'::uuid)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE fulfillments_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fulfillments_settings_shared_policy ON fulfillments_settings;
CREATE POLICY fulfillments_settings_shared_policy ON fulfillments_settings
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE fulfillments_settings TO authenticated;
