-- One-time backfill for inventory.product_id using exact product name matches.
-- Safe behavior:
-- 1) only fills rows where product_id is NULL
-- 2) only fills where product name maps to exactly one product row
-- 3) leaves ambiguous names untouched for manual review

WITH unique_product_names AS (
  SELECT
    p.name,
    MIN(p.id) AS product_id,
    COUNT(*) AS name_count
  FROM products p
  GROUP BY p.name
),
rows_to_backfill AS (
  SELECT i.id, upn.product_id
  FROM inventory i
  JOIN unique_product_names upn
    ON upn.name = i.product_name
  WHERE i.product_id IS NULL
    AND upn.name_count = 1
)
UPDATE inventory i
SET product_id = rtb.product_id
FROM rows_to_backfill rtb
WHERE i.id = rtb.id;

-- Review rows still missing mapping after backfill:
SELECT i.id, i.product_name, i.shopify_variant_id
FROM inventory i
WHERE i.product_id IS NULL
ORDER BY i.product_name, i.shopify_variant_id;
