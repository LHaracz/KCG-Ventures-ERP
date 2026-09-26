-- Sales Data + Variant Component Mapping (Phase 1a).
-- Imports Shopify orders into `orders`/`order_line_items`, and maps each
-- exact Shopify line item name to the finished goods it represents via
-- `variant_component_map`, since Shopify order data has no SKUs populated.
-- No inventory decrement in this phase — that's Phase 1b.
-- Run in the Supabase SQL editor.

-- One row per imported Shopify order.
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL UNIQUE,
  order_name text NOT NULL,
  created_at timestamptz NOT NULL,
  financial_status text,
  fulfillment_status text,
  customer_email text,
  customer_name text,
  total numeric,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_shared_policy ON orders;
CREATE POLICY orders_shared_policy ON orders
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE orders TO authenticated;

-- Line items for an imported order. Re-imports delete+reinsert a given
-- order's rows rather than trying to diff them.
CREATE TABLE IF NOT EXISTS order_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  lineitem_name text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  price numeric,
  raw_sku text
);

CREATE INDEX IF NOT EXISTS idx_order_line_items_order_id ON order_line_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_line_items_lineitem_name ON order_line_items(lineitem_name);

ALTER TABLE order_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_line_items_shared_policy ON order_line_items;
CREATE POLICY order_line_items_shared_policy ON order_line_items
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE order_line_items TO authenticated;

-- Canonical list of sellable/trackable finished products for sales tracking.
-- Deliberately separate from `products` (Products & BOM) in this phase — see
-- the build plan for why. Hand-managed via /settings/finished-goods.
CREATE TABLE IF NOT EXISTS finished_goods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  business text NOT NULL CHECK (business IN ('minileaf', 'botaniqals')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finished_goods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finished_goods_shared_policy ON finished_goods;
CREATE POLICY finished_goods_shared_policy ON finished_goods
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE finished_goods TO authenticated;

-- Shopify line-item-name -> finished-goods decomposition. A line item can
-- represent more than one finished good (e.g. a bundle), each with its own
-- qty_per_unit. Matched by exact lineitem_name string, never auto-parsed.
CREATE TABLE IF NOT EXISTS variant_component_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineitem_name text NOT NULL UNIQUE,
  business text NOT NULL CHECK (business IN ('minileaf', 'botaniqals')),
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE variant_component_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS variant_component_map_shared_policy ON variant_component_map;
CREATE POLICY variant_component_map_shared_policy ON variant_component_map
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE variant_component_map TO authenticated;

-- "Needs mapping" queue: line item names seen on imported orders with no
-- variant_component_map match yet.
CREATE TABLE IF NOT EXISTS unmapped_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineitem_name text NOT NULL UNIQUE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  order_count integer NOT NULL DEFAULT 1
);

ALTER TABLE unmapped_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unmapped_line_items_shared_policy ON unmapped_line_items;
CREATE POLICY unmapped_line_items_shared_policy ON unmapped_line_items
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE unmapped_line_items TO authenticated;

-- Single shared row tracking the last successful import, so "since last
-- import" doesn't depend on scanning `orders` for a max value. Same
-- fixed-id-upsert pattern as fulfillments_settings/notification_config.
CREATE TABLE IF NOT EXISTS sales_import_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  last_imported_at timestamptz
);

INSERT INTO sales_import_state (id)
VALUES ('d0000000-0000-0000-0000-000000000001'::uuid)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE sales_import_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_import_state_shared_policy ON sales_import_state;
CREATE POLICY sales_import_state_shared_policy ON sales_import_state
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE sales_import_state TO authenticated;
