-- BotanIQals inventory sync tables (Supabase source of truth).
-- Shopify mirrors available inventory from this data model.

CREATE TABLE IF NOT EXISTS inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  shopify_variant_id text NOT NULL,
  shopify_inventory_item_id text NOT NULL,
  shopify_location_id text NOT NULL,
  units_per_variant integer NOT NULL DEFAULT 1,
  qty_on_hand integer NOT NULL DEFAULT 0,
  reserved_qty integer NOT NULL DEFAULT 0,
  available_qty integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_qty_non_negative CHECK (qty_on_hand >= 0 AND reserved_qty >= 0),
  CONSTRAINT inventory_units_per_variant_positive CHECK (units_per_variant >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_shopify_variant_id
  ON inventory (shopify_variant_id);

CREATE INDEX IF NOT EXISTS idx_inventory_product_name
  ON inventory (product_name);

CREATE INDEX IF NOT EXISTS idx_inventory_product_id
  ON inventory (product_id);

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS units_per_variant integer NOT NULL DEFAULT 1;

ALTER TABLE inventory
  DROP CONSTRAINT IF EXISTS inventory_units_per_variant_positive;

ALTER TABLE inventory
  ADD CONSTRAINT inventory_units_per_variant_positive CHECK (units_per_variant >= 1);

CREATE TABLE IF NOT EXISTS inventory_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  change integer NOT NULL,
  reason text NOT NULL CHECK (reason IN ('production', 'order')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_logs_product_id
  ON inventory_logs (product_id);

CREATE INDEX IF NOT EXISTS idx_inventory_logs_created_at
  ON inventory_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS inventory_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_webhook_events_created_at
  ON inventory_webhook_events (created_at DESC);

CREATE TABLE IF NOT EXISTS inventory_production_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_cycle_id uuid NOT NULL,
  inventory_product_id uuid NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (production_cycle_id, inventory_product_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_production_events_cycle_id
  ON inventory_production_events (production_cycle_id);
