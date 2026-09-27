-- Finished Products Inventory (BotanIQals only) + Cycle Count.
-- On-hand quantity tracking for BotanIQals finished products, kept in sync
-- by the Sales Data import (decrement) and BotanIQals production cycle
-- completion (increment), plus a manual cycle count for correcting drift.
-- MiniLeaf/microgreens are explicitly out of scope — BotanIQals products are
-- identified by products.is_microgreen = false (there's no separate
-- business column on products).
-- Run in the Supabase SQL editor.

-- One row per BotanIQals product's current on-hand quantity.
CREATE TABLE IF NOT EXISTS finished_products_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  on_hand_qty integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finished_products_inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finished_products_inventory_shared_policy ON finished_products_inventory;
CREATE POLICY finished_products_inventory_shared_policy ON finished_products_inventory
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE finished_products_inventory TO authenticated;

-- Append-only audit log of every on-hand change. Never delete/update rows
-- from app code — this is the historical record, matching the
-- inventory_adjustments convention already used for raw materials.
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('sale_decrease', 'production_increase', 'cycle_count_adjustment')),
  quantity_delta integer NOT NULL,
  resulting_qty integer NOT NULL,
  reference_type text CHECK (reference_type IN ('order', 'production_cycle', 'manual')),
  reference_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product_id ON inventory_transactions(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_reference ON inventory_transactions(reference_type, reference_id);

ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_transactions_shared_policy ON inventory_transactions;
CREATE POLICY inventory_transactions_shared_policy ON inventory_transactions
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inventory_transactions TO authenticated;

-- Sales Data import: guards against double-decrementing an order that gets
-- re-imported (CSV re-upload or API re-fetch). Only set true once every one
-- of an order's line items has been mapped and processed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_applied boolean NOT NULL DEFAULT false;

-- Production cycle completion: same "claim once" pattern as
-- raw_materials_deducted_at (see production_raw_materials_deducted.sql) —
-- guards against double-incrementing on a retried completion.
ALTER TABLE production_cycles ADD COLUMN IF NOT EXISTS finished_goods_applied_at timestamptz;

-- One-time backfill: a row for every BotanIQals product that already
-- exists, so the inventory page is complete from the start rather than only
-- showing products that happen to get touched by a sale or production run
-- after this migration.
INSERT INTO finished_products_inventory (product_id)
SELECT id FROM products WHERE is_microgreen = false
ON CONFLICT (product_id) DO NOTHING;
