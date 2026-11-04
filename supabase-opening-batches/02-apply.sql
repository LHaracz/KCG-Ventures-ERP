-- Opening batches, step 3 of 3: APPLY. Run only after 00-backup.sql and
-- after reviewing 01-preview.sql. Requires supabase-migrations/finished_goods_batches.sql.
--
-- One statement (a single DO block), so it is one transaction: any error
-- changes nothing. Running it a second time creates nothing, because only
-- products that are not yet batch tracked are processed.
--
-- For every active BotanIQals product (is_microgreen = false, not archived):
--  a. batch_tracked becomes true; its count becomes the sum of its batches.
--  b. Products other than the BotanIQals Cup with a completed production:
--     one active batch from the latest completed batch (source opening_seed,
--     submitted_at from that completion, needs_count true), with
--     remaining = least(current count, that batch's produced qty), 0 if
--     negative. Older batches are not created. Seeded batches stay active even
--     at 0 so they can be counted.
--  c. Products with no completed production: one batch with the current count
--     if it is above 0 (next code in the sequence; agreed for Mineral Mouth
--     Rinse), otherwise tracked with no batch and 0 in boxes.
--  d. BotanIQals Cup: one active batch of 90 (needs_count true, no cycle),
--     code = highest unused code below the lowest existing code (error and
--     no change if there is none), submitted_at = the earliest existing batch's
--     New York date minus one day, at noon New York.
--  A 'batch_opening_seed' transaction records each replaced count.
--  Finally the batch_tracked default becomes true, so products created later
--  are tracked from the start.
DO $$
DECLARE
  r record;
  v_cup_id uuid;
  v_cup_count integer;
  v_lowest bigint;
  v_cup_code text;
  v_earliest timestamptz;
  v_cup_submitted timestamptz;
  v_latest record;
  v_qty integer;
  v_batch_id uuid;
  v_code text;
  v_new_total integer;
  v_done integer := 0;
BEGIN
  -- The Cup must be exactly one active BotanIQals product.
  SELECT count(*) INTO v_cup_count FROM products
    WHERE name = 'BotanIQals Cup' AND is_microgreen = false AND deleted_at IS NULL;
  IF v_cup_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active product named "BotanIQals Cup", found %. Nothing was changed.', v_cup_count;
  END IF;
  SELECT id INTO v_cup_id FROM products WHERE name = 'BotanIQals Cup' AND is_microgreen = false AND deleted_at IS NULL;

  -- Make sure every active BotanIQals product has an inventory row.
  INSERT INTO finished_products_inventory (product_id, on_hand_qty)
  SELECT p.id, 0 FROM products p
  WHERE p.is_microgreen = false AND p.deleted_at IS NULL
  ON CONFLICT (product_id) DO NOTHING;

  -- Cup code and date, computed before any new batch exists.
  SELECT min(code::bigint) INTO v_lowest FROM (
    SELECT batch_id AS code FROM botaniqals_production_batches WHERE batch_id ~ '^\d+$'
    UNION SELECT batch_code FROM finished_goods_batches WHERE batch_code ~ '^\d+$'
  ) c;
  IF v_lowest IS NOT NULL THEN
    SELECT lpad(max(g)::text, 6, '0') INTO v_cup_code
    FROM generate_series(1, greatest(v_lowest - 1, 0)) g
    WHERE NOT EXISTS (SELECT 1 FROM botaniqals_production_batches WHERE batch_id = lpad(g::text, 6, '0'))
      AND NOT EXISTS (SELECT 1 FROM finished_goods_batches WHERE batch_code = lpad(g::text, 6, '0'));
  END IF;
  SELECT min(t) INTO v_earliest FROM (
    SELECT coalesce(completed_at, created_at) AS t FROM botaniqals_production_batches
    UNION ALL SELECT submitted_at FROM finished_goods_batches
  ) x;
  v_cup_submitted := (((coalesce(v_earliest, now()) AT TIME ZONE 'America/New_York')::date - 1) + time '12:00') AT TIME ZONE 'America/New_York';

  FOR r IN
    SELECT f.product_id, f.on_hand_qty AS old_count, p.name
    FROM finished_products_inventory f JOIN products p ON p.id = f.product_id
    WHERE p.is_microgreen = false AND p.deleted_at IS NULL AND NOT f.batch_tracked
    ORDER BY p.name
    FOR UPDATE OF f
  LOOP
    v_batch_id := NULL;
    v_code := NULL;

    IF r.product_id = v_cup_id THEN
      IF v_cup_code IS NULL THEN
        RAISE EXCEPTION 'No unused batch code exists below the lowest existing code (%). Nothing was changed.', lpad(v_lowest::text, 6, '0');
      END IF;
      v_code := v_cup_code;
      INSERT INTO finished_goods_batches (batch_code, product_id, production_cycle_id, submitted_at, initial_qty, remaining_qty,
                                          needs_count, source, note)
      VALUES (v_code, r.product_id, NULL, v_cup_submitted, 90, 90, true, 'opening_seed', 'Opening batch (BotanIQals Cup)')
      RETURNING id INTO v_batch_id;
    ELSE
      SELECT b.batch_id, b.quantity_produced, b.production_cycle_id,
             coalesce(b.completed_at, c.completed_at, b.created_at) AS submitted_at
        INTO v_latest
      FROM botaniqals_production_batches b JOIN production_cycles c ON c.id = b.production_cycle_id
      WHERE b.product_id = r.product_id AND c.status = 'completed'
      ORDER BY coalesce(b.completed_at, c.completed_at, b.created_at) DESC, b.batch_number DESC
      LIMIT 1;

      IF v_latest.batch_id IS NOT NULL THEN
        v_qty := greatest(0, least(r.old_count, v_latest.quantity_produced::integer));
        v_code := v_latest.batch_id;
        INSERT INTO finished_goods_batches (batch_code, product_id, production_cycle_id, submitted_at, initial_qty, remaining_qty,
                                            needs_count, source, note)
        VALUES (v_code, r.product_id, v_latest.production_cycle_id, v_latest.submitted_at,
                v_latest.quantity_produced::integer, v_qty, true, 'opening_seed', 'Opening batch from latest completed production')
        RETURNING id INTO v_batch_id;
      ELSIF r.old_count > 0 THEN
        v_code := fg_next_batch_code();
        INSERT INTO finished_goods_batches (batch_code, product_id, submitted_at, initial_qty, remaining_qty, needs_count, source, note)
        VALUES (v_code, r.product_id, now(), r.old_count, r.old_count, true, 'opening_seed', 'Opening batch (no completed production)')
        RETURNING id INTO v_batch_id;
      END IF;
    END IF;

    UPDATE finished_products_inventory SET batch_tracked = true WHERE product_id = r.product_id;
    v_new_total := fg_sync_product(r.product_id);

    IF v_new_total <> r.old_count OR v_batch_id IS NOT NULL THEN
      INSERT INTO inventory_transactions (product_id, type, quantity_delta, resulting_qty, reference_type, reference_id, note,
                                          batch_id, batch_remaining_after)
      VALUES (r.product_id, 'batch_opening_seed', v_new_total - r.old_count, v_new_total, 'manual', NULL,
              format('Opening batches: count %s replaced by %s%s', r.old_count, v_new_total,
                     CASE WHEN v_code IS NOT NULL THEN format(' (batch %s)', v_code) ELSE ' (no batch)' END),
              v_batch_id, CASE WHEN v_batch_id IS NOT NULL THEN (SELECT remaining_qty FROM finished_goods_batches WHERE id = v_batch_id) END);
    END IF;
    v_done := v_done + 1;
  END LOOP;

  EXECUTE 'ALTER TABLE finished_products_inventory ALTER COLUMN batch_tracked SET DEFAULT true';
  RAISE NOTICE 'Opening batches: % product(s) switched to batch tracking.', v_done;
END $$;

-- Result
SELECT p.name, f.on_hand_qty, f.batch_tracked,
       (SELECT string_agg(b.batch_code || ' (' || b.remaining_qty || ')', ', ' ORDER BY b.submitted_at)
        FROM finished_goods_batches b WHERE b.product_id = p.id AND b.status = 'active') AS active_batches
FROM finished_products_inventory f JOIN products p ON p.id = f.product_id
WHERE p.is_microgreen = false AND p.deleted_at IS NULL
ORDER BY p.name;
