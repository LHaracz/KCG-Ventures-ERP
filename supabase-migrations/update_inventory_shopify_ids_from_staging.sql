-- MANUAL SCRIPT — edit the INSERT rows, then run in the Supabase SQL editor (or psql).
-- Do not run unchanged in automated migration pipelines; it is a template with placeholders.
--
-- One-time (or repeat) update: map ERP `inventory` rows to Shopify variant + inventory item + location.
--
-- HOW TO USE
-- 1) In Shopify Admin → Settings → Locations, open your primary location; the URL often ends with
--    /locations/<NUMERIC_ID> — that number is shopify_location_id (same for every row if one warehouse).
-- 2) For each finished product row in `inventory`, collect from Shopify GraphQL or Admin API:
--      - variant numeric id   (from gid://shopify/ProductVariant/XXXXXXXX)
--      - inventory item id    (from gid://shopify/InventoryItem/YYYYYYYY)
-- 3) Fill the INSERT INTO shopify_variant_staging below (add one row per inventory row you want to map).
-- 4) Choose ONE update strategy (A by inventory.id, or B by product_name) and run in Supabase SQL editor.
--
-- NOTE: idx_inventory_shopify_variant_id is UNIQUE — each shopify_variant_id may appear only once.
--       If an UPDATE fails with duplicate key, you have two inventory rows pointing at the same variant.

-- =============================================================================
-- 0) Optional: see current rows
-- =============================================================================
-- SELECT id, product_name, product_id, shopify_variant_id, shopify_inventory_item_id, shopify_location_id
-- FROM inventory
-- ORDER BY product_name;

BEGIN;

CREATE TEMP TABLE shopify_variant_staging (
  inventory_id uuid NOT NULL PRIMARY KEY,
  shopify_variant_id text NOT NULL,
  shopify_inventory_item_id text NOT NULL,
  shopify_location_id text NOT NULL
);

-- Paste one row per `inventory.id` (from the SELECT above). Example: Nano-HA Toothpaste
INSERT INTO shopify_variant_staging (inventory_id, shopify_variant_id, shopify_inventory_item_id, shopify_location_id)
VALUES
  (
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid,  -- REQUIRED: replace with real inventory.id from your DB
    '51282892456100',
    '53263355904164',
    'REPLACE_WITH_YOUR_SHOPIFY_LOCATION_ID'       -- REQUIRED: numeric location id as text, e.g. '123456789'
  )
  -- , ('<next-inventory-uuid>', '<variant_id>', '<inventory_item_id>', '<location_id>')
  ;

-- (A) RECOMMENDED: match by primary key — no ambiguity if product names repeat
UPDATE inventory AS i
SET
  shopify_variant_id = s.shopify_variant_id,
  shopify_inventory_item_id = s.shopify_inventory_item_id,
  shopify_location_id = s.shopify_location_id,
  updated_at = now()
FROM shopify_variant_staging AS s
WHERE i.id = s.inventory_id;

-- Rollback if row counts look wrong:
-- ROLLBACK;

COMMIT;

-- =============================================================================
-- (B) ALTERNATIVE: match by exact product_name (only if exactly one inventory row per name)
-- =============================================================================
-- BEGIN;
-- CREATE TEMP TABLE shopify_variant_staging_by_name (
--   product_name text NOT NULL PRIMARY KEY,
--   shopify_variant_id text NOT NULL,
--   shopify_inventory_item_id text NOT NULL,
--   shopify_location_id text NOT NULL
-- );
-- INSERT INTO shopify_variant_staging_by_name VALUES
--   ('Nano-HA Toothpaste', '51282892456100', '53263355904164', 'YOUR_LOCATION_ID');
--
-- UPDATE inventory AS i
-- SET
--   shopify_variant_id = s.shopify_variant_id,
--   shopify_inventory_item_id = s.shopify_inventory_item_id,
--   shopify_location_id = s.shopify_location_id,
--   updated_at = now()
-- FROM shopify_variant_staging_by_name AS s
-- WHERE i.product_name = s.product_name;
-- COMMIT;
