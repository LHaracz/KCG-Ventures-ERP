-- Opening batches, step 2 of 3: PREVIEW. Read-only (SELECT only).
-- Shows what 02-apply.sql would do. Review it before running the apply.
--
-- Rules (same as 02-apply.sql):
--  * BotanIQals Cup: one batch of 90 with a code just below the lowest
--    existing code, dated a day before the earliest batch.
--  * Other products with a completed production: one batch from their latest
--    completed batch; quantity = the smaller of today's count and that
--    batch's produced quantity (0 if negative).
--  * Other products with no completed production: one batch with today's
--    count if it is above 0 (next code in the sequence), otherwise
--    "No batch, starts at 0".
--  * Every seeded batch is marked "Needs count".

WITH codes AS (
  SELECT batch_id AS code FROM botaniqals_production_batches WHERE batch_id ~ '^\d+$'
  UNION SELECT batch_code FROM finished_goods_batches WHERE batch_code ~ '^\d+$'
),
lowest AS (SELECT min(code::bigint) AS n FROM codes),
cup_code AS (
  SELECT (SELECT max(g) FROM generate_series(1, greatest((SELECT n FROM lowest) - 1, 0)) g
          WHERE lpad(g::text, 6, '0') NOT IN (SELECT code FROM codes)) AS n
),
earliest AS (
  SELECT min(t) AS t FROM (
    SELECT coalesce(b.completed_at, b.created_at) AS t FROM botaniqals_production_batches b
    UNION ALL SELECT submitted_at FROM finished_goods_batches
  ) x
),
products_in AS (
  SELECT p.id, p.name, coalesce(f.on_hand_qty, 0) AS current_count, coalesce(f.batch_tracked, false) AS already_tracked,
         (p.name = 'BotanIQals Cup') AS is_cup
  FROM products p LEFT JOIN finished_products_inventory f ON f.product_id = p.id
  WHERE p.is_microgreen = false AND p.deleted_at IS NULL
),
latest AS (
  SELECT DISTINCT ON (b.product_id) b.product_id, b.batch_id, b.quantity_produced,
         coalesce(b.completed_at, c.completed_at, b.created_at) AS submitted_at
  FROM botaniqals_production_batches b JOIN production_cycles c ON c.id = b.production_cycle_id
  WHERE c.status = 'completed'
  ORDER BY b.product_id, coalesce(b.completed_at, c.completed_at, b.created_at) DESC, b.batch_number DESC
)
SELECT pi.name AS product,
       pi.current_count,
       CASE WHEN pi.already_tracked THEN 'Already batch tracked: skipped'
            WHEN pi.is_cup THEN 'BotanIQals Cup: opening batch ' || coalesce(lpad((SELECT n FROM cup_code)::text, 6, '0'), 'ERROR: no free code below the lowest')
            WHEN l.batch_id IS NOT NULL THEN 'Latest completed batch ' || l.batch_id
            WHEN pi.current_count > 0 THEN 'No completed production: new batch with today''s count (next code)'
            ELSE 'No batch, starts at 0' END AS plan,
       l.batch_id AS latest_completed_batch,
       l.quantity_produced AS latest_batch_produced,
       CASE WHEN pi.already_tracked THEN NULL
            WHEN pi.is_cup THEN 90
            WHEN l.batch_id IS NOT NULL THEN greatest(0, least(pi.current_count, l.quantity_produced::integer))
            WHEN pi.current_count > 0 THEN pi.current_count
            ELSE 0 END AS starting_quantity,
       CASE WHEN pi.already_tracked THEN pi.current_count
            WHEN pi.is_cup THEN 90
            WHEN l.batch_id IS NOT NULL THEN greatest(0, least(pi.current_count, l.quantity_produced::integer))
            WHEN pi.current_count > 0 THEN pi.current_count
            ELSE 0 END AS resulting_count,
       CASE WHEN pi.already_tracked THEN NULL
            WHEN pi.is_cup THEN ((((SELECT t FROM earliest) AT TIME ZONE 'America/New_York')::date - 1) + time '12:00') AT TIME ZONE 'America/New_York'
            WHEN l.batch_id IS NOT NULL THEN l.submitted_at
            WHEN pi.current_count > 0 THEN now()
            ELSE NULL END AS batch_submitted_at
FROM products_in pi LEFT JOIN latest l ON l.product_id = pi.id AND NOT pi.is_cup
ORDER BY pi.name;

-- How many products are named exactly "BotanIQals Cup" (must be 1):
SELECT count(*) AS botaniqals_cup_products FROM products
WHERE name = 'BotanIQals Cup' AND is_microgreen = false AND deleted_at IS NULL;
