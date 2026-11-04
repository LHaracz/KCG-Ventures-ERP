-- Batch-level finished goods, batch-aware picking, out-of-stock flags.
-- Run in the Supabase SQL editor BEFORE deploying the code that uses it.
-- Requires fulfillment_picking_staging.sql (already applied). Safe to re-run.
--
-- What it does (additive only; no columns dropped or renamed, and no
-- existing on_hand_qty is zeroed, recomputed or overwritten here):
--   * New tables: finished_goods_batches, order_batch_picks,
--     cycle_completion_snapshots.
--   * New nullable columns: finished_products_inventory.batch_tracked
--     (default false, so nothing changes until the opening-batch script in
--     supabase-opening-batches/ flips products to tracked),
--     inventory_transactions.batch_id / batch_remaining_after / order_ref,
--     order_status.flag_source / flag_detail.
--   * New inventory_transactions types: batch_receipt, batch_pick,
--     batch_pick_reversal, batch_cycle_count, batch_manual_add,
--     batch_opening_seed. New order_events types: auto_flagged_out_of_stock,
--     auto_unflagged.
--   * Rules enforced in the database: remaining_qty >= 0; for a batch-tracked
--     product, finished_products_inventory.on_hand_qty always equals the sum
--     of its active batches (kept by a trigger; direct edits are rejected);
--     batches are never deleted; picks are append-only except reversal.
--   * Functions (one transaction each, server/service role only):
--     complete_botaniqals_production, create_batches_from_production,
--     add_manual_batch, count_batches, sync_out_of_stock_flags, and new
--     versions of mark_order_picked, return_order_to_picking and
--     release_staging_box that also move batch stock.
-- Business-rule failures raise P0001 with a plain-language message and a
-- machine-readable code in HINT, like the picking functions.

-- ===========================================================================
-- 1) Columns on existing tables
-- ===========================================================================

ALTER TABLE finished_products_inventory ADD COLUMN IF NOT EXISTS batch_tracked boolean NOT NULL DEFAULT false;

ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS batch_remaining_after integer;
-- Shopify order id (text) for batch picks; reference_id is a uuid column.
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS order_ref text;
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_batch ON inventory_transactions(batch_id, created_at DESC);

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'inventory_transactions'::regclass AND con.contype = 'c' AND att.attname = 'type'
  LOOP
    EXECUTE format('ALTER TABLE inventory_transactions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_type_check
  CHECK (type IN ('sale_decrease', 'production_increase', 'cycle_count_adjustment', 'production_reversal',
                  'batch_receipt', 'batch_pick', 'batch_pick_reversal', 'batch_cycle_count',
                  'batch_manual_add', 'batch_opening_seed'));

ALTER TABLE order_status ADD COLUMN IF NOT EXISTS flag_source text;
ALTER TABLE order_status DROP CONSTRAINT IF EXISTS order_status_flag_source_check;
ALTER TABLE order_status ADD CONSTRAINT order_status_flag_source_check
  CHECK (flag_source IS NULL OR flag_source IN ('manual', 'auto_out_of_stock'));
ALTER TABLE order_status ADD COLUMN IF NOT EXISTS flag_detail jsonb;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'order_events'::regclass AND con.contype = 'c' AND att.attname = 'event_type'
  LOOP
    EXECUTE format('ALTER TABLE order_events DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE order_events ADD CONSTRAINT order_events_event_type_check CHECK (event_type IN (
  'picked', 'returned_to_picking', 'box_released', 'packaging_override', 'packaging_override_cleared',
  'auto_flagged_out_of_stock', 'auto_unflagged'));

-- ===========================================================================
-- 2) New tables
-- ===========================================================================

CREATE TABLE IF NOT EXISTS finished_goods_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code text NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES products(id),
  production_cycle_id uuid REFERENCES production_cycles(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL,
  initial_qty integer NOT NULL CHECK (initial_qty >= 0),
  remaining_qty integer NOT NULL CHECK (remaining_qty >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'depleted')),
  needs_count boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('production', 'opening_seed', 'manual')),
  note text,
  created_by_name text,
  depleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'depleted') = (depleted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_fg_batches_product_status ON finished_goods_batches(product_id, status);
-- One production batch per product per cycle.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fg_batches_cycle_product
  ON finished_goods_batches(production_cycle_id, product_id) WHERE production_cycle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_batch_picks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,              -- Shopify numeric order id, as in order_status
  order_name text,
  product_id uuid NOT NULL REFERENCES products(id),
  batch_id uuid NOT NULL REFERENCES finished_goods_batches(id),
  qty integer NOT NULL CHECK (qty > 0),
  is_override boolean NOT NULL DEFAULT false,
  override_reason text,
  picked_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  reversed_reason text,
  CHECK (NOT is_override OR nullif(trim(override_reason), '') IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_order_batch_picks_order ON order_batch_picks(order_id);
CREATE INDEX IF NOT EXISTS idx_order_batch_picks_batch ON order_batch_picks(batch_id);

CREATE TABLE IF NOT EXISTS cycle_completion_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_cycle_id uuid NOT NULL UNIQUE REFERENCES production_cycles(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,          -- [{product_id, ingredient, unit, qty_used, cost_per_unit, line_cost}]
  sale_price_per_unit numeric,                       -- single-product cycles; per product in per_product
  total_cost numeric NOT NULL DEFAULT 0,
  actual_quantities jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {product_id: qty}
  per_product jsonb NOT NULL DEFAULT '[]'::jsonb     -- [{product_id, name, qty, sale_price_per_unit, cost}]
);

-- ===========================================================================
-- 3) Guards and the product-total invariant
-- ===========================================================================

CREATE OR REPLACE FUNCTION fg_setting_on(p_name text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting(p_name, true), '') = 'on' $$;

-- Recomputes a tracked product's on_hand_qty from its active batches.
CREATE OR REPLACE FUNCTION fg_sync_product(p_product_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_total integer;
BEGIN
  SELECT coalesce(sum(remaining_qty), 0)::integer INTO v_total
  FROM finished_goods_batches WHERE product_id = p_product_id AND status = 'active';
  PERFORM set_config('kcg.fg_sync', 'on', true);
  UPDATE finished_products_inventory SET on_hand_qty = v_total, updated_at = now()
    WHERE product_id = p_product_id AND batch_tracked AND on_hand_qty <> v_total;
  PERFORM set_config('kcg.fg_sync', 'off', true);
  RETURN v_total;
END $$;

CREATE OR REPLACE FUNCTION finished_goods_batches_after() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fg_sync_product(new.product_id);
  IF tg_op = 'UPDATE' AND old.product_id <> new.product_id THEN
    PERFORM fg_sync_product(old.product_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_fg_batches_after ON finished_goods_batches;
CREATE TRIGGER trg_fg_batches_after AFTER INSERT OR UPDATE ON finished_goods_batches
  FOR EACH ROW EXECUTE FUNCTION finished_goods_batches_after();

CREATE OR REPLACE FUNCTION finished_goods_batches_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    IF fg_setting_on('kcg.fg_test_cleanup') AND EXISTS (
      SELECT 1 FROM products p WHERE p.id = old.product_id AND p.name LIKE '[TEST]%') THEN
      RETURN old;
    END IF;
    RAISE EXCEPTION 'Finished goods batches are never deleted.' USING errcode = 'P0001';
  END IF;
  IF new.batch_code <> old.batch_code OR new.product_id <> old.product_id OR new.source <> old.source THEN
    RAISE EXCEPTION 'A batch''s code, product and source cannot be changed.' USING errcode = 'P0001';
  END IF;
  RETURN new;
END $$;
DROP TRIGGER IF EXISTS trg_fg_batches_guard ON finished_goods_batches;
CREATE TRIGGER trg_fg_batches_guard BEFORE UPDATE OR DELETE ON finished_goods_batches
  FOR EACH ROW EXECUTE FUNCTION finished_goods_batches_guard();

-- For tracked products the count comes only from batches.
CREATE OR REPLACE FUNCTION finished_products_inventory_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF old.batch_tracked AND new.on_hand_qty IS DISTINCT FROM old.on_hand_qty AND NOT fg_setting_on('kcg.fg_sync') THEN
    RAISE EXCEPTION 'This product''s finished goods are tracked by batch. Change stock with Count boxes or Add batch.'
      USING errcode = 'P0001', hint = 'batch_tracked';
  END IF;
  IF old.batch_tracked AND NOT new.batch_tracked THEN
    RAISE EXCEPTION 'Batch tracking cannot be turned off for a product.' USING errcode = 'P0001';
  END IF;
  RETURN new;
END $$;
DROP TRIGGER IF EXISTS trg_fpi_guard ON finished_products_inventory;
CREATE TRIGGER trg_fpi_guard BEFORE UPDATE ON finished_products_inventory
  FOR EACH ROW EXECUTE FUNCTION finished_products_inventory_guard();

CREATE OR REPLACE FUNCTION order_batch_picks_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    IF fg_setting_on('kcg.fg_test_cleanup') AND old.order_id LIKE 'TEST-%' THEN RETURN old; END IF;
    RAISE EXCEPTION 'Batch picks are never deleted.' USING errcode = 'P0001';
  END IF;
  IF old.reversed_at IS NOT NULL
     OR (to_jsonb(new) - 'reversed_at' - 'reversed_reason') IS DISTINCT FROM (to_jsonb(old) - 'reversed_at' - 'reversed_reason') THEN
    RAISE EXCEPTION 'A batch pick can only be reversed, once.' USING errcode = 'P0001';
  END IF;
  RETURN new;
END $$;
DROP TRIGGER IF EXISTS trg_order_batch_picks_guard ON order_batch_picks;
CREATE TRIGGER trg_order_batch_picks_guard BEFORE UPDATE OR DELETE ON order_batch_picks
  FOR EACH ROW EXECUTE FUNCTION order_batch_picks_guard();

-- Flag rules on order_status:
--  * a new flag without a source is a manual flag;
--  * editing an automatic flag's reason turns it into a manual flag;
--  * an automatic out-of-stock flag can only be cleared by
--    sync_out_of_stock_flags (which knows whether the order is still short);
--  * unflagging clears the source and detail.
CREATE OR REPLACE FUNCTION order_status_flag_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF new.is_flagged AND new.flag_source IS NULL THEN
    new.flag_source := 'manual';
  END IF;
  IF tg_op = 'UPDATE' AND old.is_flagged AND old.flag_source = 'auto_out_of_stock' AND NOT fg_setting_on('kcg.fg_auto_flag') THEN
    IF NOT new.is_flagged THEN
      RAISE EXCEPTION 'Still out of stock. Count a batch or add stock first.' USING errcode = 'P0001', hint = 'still_short';
    END IF;
    IF new.flagged_reason IS DISTINCT FROM old.flagged_reason THEN
      new.flag_source := 'manual';
    END IF;
  END IF;
  IF NOT new.is_flagged THEN
    new.flag_source := NULL;
    new.flag_detail := NULL;
  END IF;
  RETURN new;
END $$;
DROP TRIGGER IF EXISTS trg_order_status_flag_rules ON order_status;
CREATE TRIGGER trg_order_status_flag_rules BEFORE INSERT OR UPDATE ON order_status
  FOR EACH ROW EXECUTE FUNCTION order_status_flag_rules();

-- Existing flags predate flag_source: they are manual flags.
UPDATE order_status SET flag_source = 'manual' WHERE is_flagged AND flag_source IS NULL;

-- ===========================================================================
-- 4) Row level security: logged-in users read; writes only via functions
-- ===========================================================================

ALTER TABLE finished_goods_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_batch_picks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycle_completion_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finished_goods_batches_read ON finished_goods_batches;
CREATE POLICY finished_goods_batches_read ON finished_goods_batches FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS order_batch_picks_read ON order_batch_picks;
CREATE POLICY order_batch_picks_read ON order_batch_picks FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS cycle_completion_snapshots_read ON cycle_completion_snapshots;
CREATE POLICY cycle_completion_snapshots_read ON cycle_completion_snapshots FOR SELECT USING (auth.role() = 'authenticated');
GRANT SELECT ON TABLE finished_goods_batches, order_batch_picks, cycle_completion_snapshots TO authenticated;
REVOKE ALL ON TABLE finished_goods_batches, order_batch_picks, cycle_completion_snapshots FROM anon;

-- ===========================================================================
-- 5) Helpers
-- ===========================================================================

-- Next batch code from the same sequence production batches use, skipping
-- any code already in use anywhere. Codes are never reissued.
CREATE OR REPLACE FUNCTION fg_next_batch_code() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_code text;
BEGIN
  LOOP
    v_code := lpad(nextval('botaniqals_batch_seq')::text, 6, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM finished_goods_batches WHERE batch_code = v_code)
          AND NOT EXISTS (SELECT 1 FROM botaniqals_production_batches WHERE batch_id = v_code);
  END LOOP;
  RETURN v_code;
END $$;

-- Ensures a BotanIQals product has an inventory row and is batch tracked.
-- A product that exists but is not yet tracked (between this migration and
-- the opening-batch script) is refused, so its current count is never
-- silently replaced.
CREATE OR REPLACE FUNCTION fg_require_tracked(p_product_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_row finished_products_inventory; v_product products;
BEGIN
  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF v_product.id IS NULL THEN PERFORM fo_fail('product_not_found', 'Product not found.'); END IF;
  IF v_product.is_microgreen THEN
    PERFORM fo_fail('not_botaniqals', format('%s is a MiniLeaf product; finished goods batches are BotanIQals only.', v_product.name));
  END IF;
  SELECT * INTO v_row FROM finished_products_inventory WHERE product_id = p_product_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    INSERT INTO finished_products_inventory (product_id, on_hand_qty, batch_tracked) VALUES (p_product_id, 0, true)
    ON CONFLICT (product_id) DO NOTHING;
    SELECT * INTO v_row FROM finished_products_inventory WHERE product_id = p_product_id FOR UPDATE;
  END IF;
  IF NOT v_row.batch_tracked THEN
    PERFORM fo_fail('not_batch_tracked', format(
      '%s is not batch tracked yet. Run the opening-batch setup (supabase-opening-batches) first.', v_product.name));
  END IF;
END $$;

-- One inventory_transactions row per batch change; resulting_qty is the
-- product total after the change.
CREATE OR REPLACE FUNCTION fg_write_tx(
  p_batch_id uuid, p_type text, p_delta integer, p_ref_type text, p_ref_id uuid, p_order_ref text, p_note text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_batch finished_goods_batches; v_total integer;
BEGIN
  SELECT * INTO v_batch FROM finished_goods_batches WHERE id = p_batch_id;
  SELECT on_hand_qty INTO v_total FROM finished_products_inventory WHERE product_id = v_batch.product_id;
  INSERT INTO inventory_transactions (product_id, type, quantity_delta, resulting_qty, reference_type, reference_id,
                                      note, batch_id, batch_remaining_after, order_ref)
  VALUES (v_batch.product_id, p_type, p_delta, coalesce(v_total, 0), p_ref_type, p_ref_id,
          p_note, v_batch.id, v_batch.remaining_qty, p_order_ref);
END $$;

-- Locks batches in id order (the one lock order used everywhere).
CREATE OR REPLACE FUNCTION fg_lock_batches(p_ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM finished_goods_batches WHERE id = ANY(p_ids) ORDER BY id FOR UPDATE;
END $$;

-- Puts an order's unreversed picks back into the same batches.
CREATE OR REPLACE FUNCTION fg_reverse_order_picks(p_order_id text, p_reason text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE r record; v_count integer := 0;
BEGIN
  PERFORM fg_lock_batches(ARRAY(SELECT batch_id FROM order_batch_picks WHERE order_id = p_order_id AND reversed_at IS NULL));
  FOR r IN SELECT * FROM order_batch_picks WHERE order_id = p_order_id AND reversed_at IS NULL ORDER BY batch_id, id LOOP
    UPDATE finished_goods_batches
      SET remaining_qty = remaining_qty + r.qty, status = 'active', depleted_at = NULL
      WHERE id = r.batch_id;
    UPDATE order_batch_picks SET reversed_at = now(), reversed_reason = p_reason WHERE id = r.id;
    PERFORM fg_write_tx(r.batch_id, 'batch_pick_reversal', r.qty, 'order', NULL, p_order_id,
                        format('Returned to picking: %s', coalesce(r.order_name, p_order_id)));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- Read-only preview of the next p_count batch codes (for the confirmation
-- step). The real codes are assigned when the batches are created.
CREATE OR REPLACE FUNCTION peek_next_batch_codes(p_count integer) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE v_last bigint; v_called boolean; v_n bigint; v_out text[] := '{}'; v_code text;
BEGIN
  SELECT last_value, is_called INTO v_last, v_called FROM botaniqals_batch_seq;
  v_n := CASE WHEN v_called THEN v_last + 1 ELSE v_last END;
  WHILE coalesce(array_length(v_out, 1), 0) < greatest(coalesce(p_count, 0), 0) LOOP
    v_code := lpad(v_n::text, 6, '0');
    IF NOT EXISTS (SELECT 1 FROM finished_goods_batches WHERE batch_code = v_code)
       AND NOT EXISTS (SELECT 1 FROM botaniqals_production_batches WHERE batch_id = v_code) THEN
      v_out := v_out || v_code;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_out;
END $$;

-- ===========================================================================
-- 6) Production completion
-- ===========================================================================

-- One active batch per product with actual > 0. Batch codes come from the
-- existing botaniqals_production_batches rows (same sequence, same code
-- that goes on the box label). Idempotent per (cycle, product).
CREATE OR REPLACE FUNCTION create_batches_from_production(p_cycle_id uuid, p_actuals jsonb, p_completed_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_cycle production_cycles;
  r record;
  v_qty integer;
  v_code text;
  v_batch_id uuid;
  v_out jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_cycle FROM production_cycles WHERE id = p_cycle_id;
  IF v_cycle.id IS NULL THEN PERFORM fo_fail('cycle_not_found', 'Production cycle not found.'); END IF;
  IF lower(coalesce(v_cycle.business_type, v_cycle.brand, 'botaniqals')) <> 'botaniqals' THEN
    PERFORM fo_fail('not_botaniqals', 'Finished goods batches are created for BotanIQals cycles only.');
  END IF;

  FOR r IN SELECT key AS product_id, value FROM jsonb_each(coalesce(p_actuals, '{}'::jsonb)) ORDER BY key LOOP
    IF jsonb_typeof(r.value) <> 'number' OR (r.value)::text ~ '[.eE]' OR (r.value)::text::numeric < 0 THEN
      PERFORM fo_fail('invalid_quantity', 'Actual quantities must be whole numbers, 0 or more.');
    END IF;
    v_qty := (r.value)::text::integer;
    CONTINUE WHEN v_qty = 0;
    PERFORM fg_require_tracked(r.product_id::uuid);

    INSERT INTO botaniqals_production_batches (user_id, production_cycle_id, product_id, quantity_produced,
                                               production_start_at, production_end_at, completed_at)
    VALUES (v_cycle.user_id, p_cycle_id, r.product_id::uuid, v_qty, v_cycle.start_date, p_completed_at, p_completed_at)
    ON CONFLICT (production_cycle_id, product_id) DO UPDATE
      SET quantity_produced = excluded.quantity_produced, production_end_at = excluded.production_end_at,
          completed_at = excluded.completed_at
    RETURNING batch_id INTO v_code;

    SELECT id INTO v_batch_id FROM finished_goods_batches WHERE production_cycle_id = p_cycle_id AND product_id = r.product_id::uuid;
    IF v_batch_id IS NULL THEN
      IF EXISTS (SELECT 1 FROM finished_goods_batches WHERE batch_code = v_code) THEN
        PERFORM fo_fail('code_in_use', format('Batch code %s is already in use.', v_code));
      END IF;
      INSERT INTO finished_goods_batches (batch_code, product_id, production_cycle_id, submitted_at, initial_qty,
                                          remaining_qty, source)
      VALUES (v_code, r.product_id::uuid, p_cycle_id, p_completed_at, v_qty, v_qty, 'production')
      RETURNING id INTO v_batch_id;
      PERFORM fg_write_tx(v_batch_id, 'batch_receipt', v_qty, 'production_cycle', p_cycle_id, NULL,
                          format('Production completed: batch %s', v_code));
    END IF;
    v_out := v_out || jsonb_build_object('product_id', r.product_id, 'batch_id', v_batch_id, 'batch_code', v_code, 'qty', v_qty);
  END LOOP;
  RETURN v_out;
END $$;

-- Completes a BotanIQals cycle: batches, snapshot and status in one
-- transaction. The Google Sheet write happens in the API route before this.
CREATE OR REPLACE FUNCTION complete_botaniqals_production(
  p_cycle_id uuid, p_actuals jsonb, p_snapshot jsonb, p_completed_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_cycle production_cycles; v_batches jsonb;
BEGIN
  SELECT * INTO v_cycle FROM production_cycles WHERE id = p_cycle_id FOR UPDATE;
  IF v_cycle.id IS NULL THEN PERFORM fo_fail('cycle_not_found', 'Production cycle not found.'); END IF;
  IF v_cycle.status = 'completed' AND EXISTS (SELECT 1 FROM cycle_completion_snapshots WHERE production_cycle_id = p_cycle_id) THEN
    RETURN jsonb_build_object('already_completed', true, 'batches', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'batch_id', id, 'batch_code', batch_code,
                                                    'qty', initial_qty) ORDER BY batch_code), '[]'::jsonb)
      FROM finished_goods_batches WHERE production_cycle_id = p_cycle_id));
  END IF;

  v_batches := create_batches_from_production(p_cycle_id, p_actuals, p_completed_at);

  INSERT INTO cycle_completion_snapshots (production_cycle_id, captured_at, lines, sale_price_per_unit, total_cost,
                                          actual_quantities, per_product)
  VALUES (p_cycle_id, p_completed_at, coalesce(p_snapshot->'lines', '[]'::jsonb),
          nullif(p_snapshot->>'sale_price_per_unit', '')::numeric, coalesce(nullif(p_snapshot->>'total_cost', '')::numeric, 0),
          coalesce(p_actuals, '{}'::jsonb), coalesce(p_snapshot->'per_product', '[]'::jsonb))
  ON CONFLICT (production_cycle_id) DO NOTHING;

  UPDATE production_cycles
    SET status = 'completed', completed_at = p_completed_at,
        finished_goods_applied_at = coalesce(finished_goods_applied_at, p_completed_at)
    WHERE id = p_cycle_id;

  RETURN jsonb_build_object('already_completed', false, 'batches', v_batches);
END $$;

-- ===========================================================================
-- 7) Manual batches and batch counts
-- ===========================================================================

CREATE OR REPLACE FUNCTION add_manual_batch(
  p_product_id uuid, p_qty integer, p_produced_date date, p_note text, p_name text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_code text; v_id uuid;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN PERFORM fo_fail('invalid_quantity', 'Enter a quantity greater than 0.'); END IF;
  IF p_produced_date IS NULL THEN PERFORM fo_fail('date_required', 'Enter the production date.'); END IF;
  IF nullif(trim(p_name), '') IS NULL THEN PERFORM fo_fail('name_required', 'Enter your name.'); END IF;
  PERFORM fg_require_tracked(p_product_id);
  v_code := fg_next_batch_code();
  INSERT INTO finished_goods_batches (batch_code, product_id, submitted_at, initial_qty, remaining_qty, source, note, created_by_name)
  VALUES (v_code, p_product_id, (p_produced_date + time '12:00') AT TIME ZONE 'America/New_York', p_qty, p_qty, 'manual',
          nullif(trim(p_note), ''), trim(p_name))
  RETURNING id INTO v_id;
  PERFORM fg_write_tx(v_id, 'batch_manual_add', p_qty, 'manual', NULL, NULL,
                      concat_ws(' · ', format('Added by %s', trim(p_name)), nullif(trim(p_note), '')));
  RETURN jsonb_build_object('batch_id', v_id, 'batch_code', v_code);
END $$;

-- p_counts: [{batch_id, expected_remaining, counted_qty, reason}]
-- All or nothing: if any batch changed since the count was opened, nothing
-- is written and the call fails with code count_stale.
CREATE OR REPLACE FUNCTION count_batches(p_counts jsonb, p_name text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c jsonb;
  v_batch finished_goods_batches;
  v_counted integer;
  v_changed integer := 0;
  v_stale jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_counts) <> 'array' OR jsonb_array_length(p_counts) = 0 THEN
    PERFORM fo_fail('nothing_to_count', 'Enter at least one count.');
  END IF;
  PERFORM fg_lock_batches(ARRAY(SELECT (x->>'batch_id')::uuid FROM jsonb_array_elements(p_counts) x));

  FOR c IN SELECT * FROM jsonb_array_elements(p_counts) LOOP
    SELECT * INTO v_batch FROM finished_goods_batches WHERE id = (c->>'batch_id')::uuid;
    IF v_batch.id IS NULL THEN PERFORM fo_fail('batch_not_found', 'Batch not found.'); END IF;
    IF v_batch.remaining_qty <> (c->>'expected_remaining')::integer THEN
      v_stale := v_stale || jsonb_build_object('batch_id', v_batch.id, 'batch_code', v_batch.batch_code,
                                               'current_remaining', v_batch.remaining_qty);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_stale) > 0 THEN
    RAISE EXCEPTION '%', format('Batch %s changed since you opened the count. Re-enter it.',
      (SELECT string_agg(x->>'batch_code', ', ') FROM jsonb_array_elements(v_stale) x))
      USING errcode = 'P0001', hint = 'count_stale', detail = v_stale::text;
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(p_counts) LOOP
    SELECT * INTO v_batch FROM finished_goods_batches WHERE id = (c->>'batch_id')::uuid;
    IF jsonb_typeof(c->'counted_qty') <> 'number' OR (c->>'counted_qty') ~ '[.eE-]' THEN
      PERFORM fo_fail('invalid_quantity', format('Counted quantity for batch %s must be a whole number, 0 or more.', v_batch.batch_code));
    END IF;
    v_counted := (c->>'counted_qty')::integer;
    IF v_counted <> v_batch.remaining_qty AND nullif(trim(c->>'reason'), '') IS NULL THEN
      PERFORM fo_fail('reason_required', format('A reason is required for batch %s.', v_batch.batch_code));
    END IF;
    UPDATE finished_goods_batches
      SET remaining_qty = v_counted,
          status = CASE WHEN v_counted = 0 THEN 'depleted' ELSE 'active' END,
          depleted_at = CASE WHEN v_counted = 0 THEN coalesce(depleted_at, now()) ELSE NULL END,
          needs_count = false
      WHERE id = v_batch.id;
    IF v_counted <> v_batch.remaining_qty THEN
      PERFORM fg_write_tx(v_batch.id, 'batch_cycle_count', v_counted - v_batch.remaining_qty, 'manual', NULL, NULL,
                          concat_ws(' · ', format('Counted %s (was %s)', v_counted, v_batch.remaining_qty),
                                    nullif(trim(c->>'reason'), ''), nullif(trim(p_name), '')));
      v_changed := v_changed + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('changed', v_changed, 'counted', jsonb_array_length(p_counts));
END $$;

-- ===========================================================================
-- 8) Picking with batches
-- ===========================================================================

-- p_allocations: [{product_id, batch_id, qty}] (the batches the picker pulled from)
-- p_required:    {product_id: qty} for every component of the order (the
--                function only enforces batch-tracked products)
-- p_override_reason: set when the picker used "Picked from a different batch"
-- Lock order: order row, box row, then batches in id order.
DROP FUNCTION IF EXISTS mark_order_picked(text, uuid, text);
CREATE OR REPLACE FUNCTION mark_order_picked(
  p_order_id text, p_box_id uuid, p_order_name text DEFAULT NULL,
  p_allocations jsonb DEFAULT NULL, p_required jsonb DEFAULT NULL, p_override_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_status order_status;
  v_box staging_boxes;
  v_open staging_box_assignments;
  v_open_box text;
  v_label text := fo_order_label(p_order_id, p_order_name);
  v_assignment_id uuid;
  v_alloc jsonb := coalesce(p_allocations, '[]'::jsonb);
  r record;
  a jsonb;
  v_batch finished_goods_batches;
  v_product_name text;
  v_is_override boolean := nullif(trim(p_override_reason), '') IS NOT NULL;
BEGIN
  v_status := fo_lock_order(p_order_id);

  SELECT * INTO v_open FROM staging_box_assignments WHERE order_id = p_order_id AND released_at IS NULL;
  IF v_open.id IS NOT NULL THEN
    SELECT label INTO v_open_box FROM staging_boxes WHERE id = v_open.staging_box_id;
    PERFORM fo_fail('order_already_picked', format('Order %s is already picked into %s.', v_label, v_open_box));
  END IF;
  IF v_status.status <> 'preparing_shipment' THEN
    PERFORM fo_fail('order_not_waiting', format('Order %s is not waiting to be picked.', v_label));
  END IF;
  IF v_status.is_flagged THEN
    PERFORM fo_fail('order_flagged', format('Order %s is flagged. Unflag it before picking.', v_label));
  END IF;

  SELECT * INTO v_box FROM staging_boxes WHERE id = p_box_id FOR UPDATE;
  IF v_box.id IS NULL THEN PERFORM fo_fail('box_not_found', 'Staging box not found.'); END IF;
  IF v_box.archived_at IS NOT NULL THEN
    PERFORM fo_fail('box_retired', format('%s is retired.', v_box.label));
  END IF;
  SELECT * INTO v_open FROM staging_box_assignments WHERE staging_box_id = p_box_id AND released_at IS NULL;
  IF v_open.id IS NOT NULL THEN
    PERFORM fo_fail('box_in_use', format('%s is already holding order %s.', v_box.label,
      fo_order_label(v_open.order_id, v_open.order_name)));
  END IF;

  -- Batch stock: every batch-tracked component must be allocated exactly.
  IF jsonb_typeof(v_alloc) <> 'array' THEN PERFORM fo_fail('invalid_allocation', 'Invalid batch allocation.'); END IF;
  FOR r IN
    SELECT key::uuid AS product_id, (value)::text::integer AS qty
    FROM jsonb_each(coalesce(p_required, '{}'::jsonb))
  LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM finished_products_inventory WHERE product_id = r.product_id AND batch_tracked);
    IF coalesce((SELECT sum((x->>'qty')::integer) FROM jsonb_array_elements(v_alloc) x
                 WHERE (x->>'product_id')::uuid = r.product_id), 0) <> r.qty THEN
      SELECT name INTO v_product_name FROM products WHERE id = r.product_id;
      PERFORM fo_fail('allocation_mismatch', format('Batch quantities for %s must add up to %s.', coalesce(v_product_name, 'a product'), r.qty));
    END IF;
  END LOOP;
  FOR a IN SELECT * FROM jsonb_array_elements(v_alloc) LOOP
    IF NOT (coalesce(p_required, '{}'::jsonb) ? (a->>'product_id')) THEN
      PERFORM fo_fail('allocation_mismatch', 'A batch was given for a product that is not in this order.');
    END IF;
    IF coalesce((a->>'qty')::integer, 0) <= 0 THEN
      PERFORM fo_fail('allocation_mismatch', 'Batch quantities must be greater than 0.');
    END IF;
  END LOOP;

  PERFORM fg_lock_batches(ARRAY(SELECT (x->>'batch_id')::uuid FROM jsonb_array_elements(v_alloc) x));
  FOR a IN SELECT * FROM jsonb_array_elements(v_alloc) ORDER BY (value->>'batch_id') LOOP
    SELECT * INTO v_batch FROM finished_goods_batches WHERE id = (a->>'batch_id')::uuid;
    IF v_batch.id IS NULL OR v_batch.product_id <> (a->>'product_id')::uuid THEN
      PERFORM fo_fail('batch_mismatch', 'A chosen batch does not hold that product.');
    END IF;
    IF v_batch.remaining_qty < (a->>'qty')::integer THEN
      PERFORM fo_fail('batch_short', format('Batch %s shows %s units. Count the box first.', v_batch.batch_code, v_batch.remaining_qty));
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO staging_box_assignments (order_id, order_name, staging_box_id)
    VALUES (p_order_id, nullif(trim(p_order_name), ''), p_box_id)
    RETURNING id INTO v_assignment_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM fo_fail('box_in_use', format('%s was just taken by another picker.', v_box.label));
  END;

  FOR a IN SELECT * FROM jsonb_array_elements(v_alloc) ORDER BY (value->>'batch_id') LOOP
    UPDATE finished_goods_batches
      SET remaining_qty = remaining_qty - (a->>'qty')::integer,
          status = CASE WHEN remaining_qty - (a->>'qty')::integer = 0 THEN 'depleted' ELSE 'active' END,
          depleted_at = CASE WHEN remaining_qty - (a->>'qty')::integer = 0 THEN now() ELSE NULL END
      WHERE id = (a->>'batch_id')::uuid;
    INSERT INTO order_batch_picks (order_id, order_name, product_id, batch_id, qty, is_override, override_reason)
    VALUES (p_order_id, v_label, (a->>'product_id')::uuid, (a->>'batch_id')::uuid, (a->>'qty')::integer,
            v_is_override, CASE WHEN v_is_override THEN trim(p_override_reason) END);
    PERFORM fg_write_tx((a->>'batch_id')::uuid, 'batch_pick', -((a->>'qty')::integer), 'order', NULL, p_order_id,
                        format('Picked for %s into %s', v_label, v_box.label));
  END LOOP;

  UPDATE order_status SET status = 'picked', updated_at = now() WHERE shopify_order_id = p_order_id;
  INSERT INTO order_events (order_id, event_type, detail)
  VALUES (p_order_id, 'picked', jsonb_build_object('box', v_box.label, 'box_id', v_box.id, 'order_name', v_label,
                                                   'batches', v_alloc, 'override', v_is_override));

  RETURN jsonb_build_object('assignment_id', v_assignment_id, 'box_label', v_box.label);
END $$;

CREATE OR REPLACE FUNCTION return_order_to_picking(p_order_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_status order_status;
  v_open staging_box_assignments;
  v_box_label text;
  v_label text;
  v_reversed integer;
BEGIN
  v_status := fo_lock_order(p_order_id);
  SELECT * INTO v_open FROM staging_box_assignments WHERE order_id = p_order_id AND released_at IS NULL;
  v_label := fo_order_label(p_order_id, v_open.order_name);

  IF fo_has_active_label(p_order_id, v_status.status) THEN
    PERFORM fo_fail('label_exists', 'Void the label first.');
  END IF;
  IF v_status.status <> 'picked' THEN
    PERFORM fo_fail('order_not_picked', format('Order %s is not picked.', v_label));
  END IF;

  IF v_open.id IS NOT NULL THEN
    SELECT label INTO v_box_label FROM staging_boxes WHERE id = v_open.staging_box_id FOR UPDATE;
    UPDATE staging_box_assignments
      SET released_at = now(), release_reason = 'returned_to_picking'
      WHERE id = v_open.id;
  END IF;

  v_reversed := fg_reverse_order_picks(p_order_id, 'returned_to_picking');
  UPDATE order_status SET status = 'preparing_shipment', updated_at = now() WHERE shopify_order_id = p_order_id;
  PERFORM fo_clear_override_internal(p_order_id, 'returned_to_picking');
  INSERT INTO order_events (order_id, event_type, detail)
  VALUES (p_order_id, 'returned_to_picking', jsonb_build_object('box', v_box_label, 'batch_picks_reversed', v_reversed));

  RETURN jsonb_build_object('released_box', v_box_label, 'batch_picks_reversed', v_reversed);
END $$;

CREATE OR REPLACE FUNCTION release_staging_box(p_box_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_box staging_boxes;
  v_open staging_box_assignments;
  v_status order_status;
  v_returned boolean := false;
BEGIN
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    PERFORM fo_fail('reason_required', 'A reason is required to release a staging box.');
  END IF;

  SELECT * INTO v_open FROM staging_box_assignments WHERE staging_box_id = p_box_id AND released_at IS NULL;
  IF v_open.id IS NOT NULL THEN
    v_status := fo_lock_order(v_open.order_id);
  END IF;
  SELECT * INTO v_box FROM staging_boxes WHERE id = p_box_id FOR UPDATE;
  IF v_box.id IS NULL THEN PERFORM fo_fail('box_not_found', 'Staging box not found.'); END IF;
  SELECT * INTO v_open FROM staging_box_assignments WHERE staging_box_id = p_box_id AND released_at IS NULL;
  IF v_open.id IS NULL THEN
    PERFORM fo_fail('box_not_in_use', format('%s is not holding an order.', v_box.label));
  END IF;
  IF v_status.shopify_order_id IS DISTINCT FROM v_open.order_id THEN
    v_status := fo_lock_order(v_open.order_id);
  END IF;

  IF fo_has_active_label(v_open.order_id, v_status.status) THEN
    PERFORM fo_fail('label_exists', 'Void the label first.');
  END IF;

  UPDATE staging_box_assignments
    SET released_at = now(), release_reason = 'manual_release', release_note = trim(p_reason)
    WHERE id = v_open.id;
  INSERT INTO order_events (order_id, event_type, detail)
  VALUES (v_open.order_id, 'box_released',
          jsonb_build_object('box', v_box.label, 'reason', 'manual_release', 'note', trim(p_reason)));

  IF v_status.status = 'picked' THEN
    PERFORM fg_reverse_order_picks(v_open.order_id, 'box_released: ' || trim(p_reason));
    UPDATE order_status SET status = 'preparing_shipment', updated_at = now()
      WHERE shopify_order_id = v_open.order_id;
    PERFORM fo_clear_override_internal(v_open.order_id, 'box_released');
    INSERT INTO order_events (order_id, event_type, detail)
    VALUES (v_open.order_id, 'returned_to_picking', jsonb_build_object('box', v_box.label, 'via', 'release_staging_box'));
    v_returned := true;
  END IF;

  RETURN jsonb_build_object('box_label', v_box.label,
    'order_label', fo_order_label(v_open.order_id, v_open.order_name), 'returned_to_picking', v_returned);
END $$;

-- ===========================================================================
-- 9) Automatic out-of-stock flags
-- ===========================================================================

-- p_short:   [{order_id, detail: [{product_id, product, needed, available, short_by}]}]
-- p_covered: order ids whose tracked components are fully covered
-- Only orders waiting to be picked are flagged. Manual flags are never
-- touched. Writes only when something changes (idempotent).
CREATE OR REPLACE FUNCTION sync_out_of_stock_flags(p_short jsonb, p_covered text[]) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  s jsonb;
  v_id text;
  v_row order_status;
  v_flagged integer := 0;
  v_updated integer := 0;
  v_cleared integer := 0;
BEGIN
  PERFORM set_config('kcg.fg_auto_flag', 'on', true);

  FOR s IN SELECT * FROM jsonb_array_elements(coalesce(p_short, '[]'::jsonb)) ORDER BY value->>'order_id' LOOP
    v_id := s->>'order_id';
    SELECT * INTO v_row FROM order_status WHERE shopify_order_id = v_id FOR UPDATE;
    IF v_row.id IS NULL THEN
      INSERT INTO order_status (shopify_order_id, status) VALUES (v_id, 'preparing_shipment')
      ON CONFLICT (shopify_order_id) DO NOTHING;
      SELECT * INTO v_row FROM order_status WHERE shopify_order_id = v_id FOR UPDATE;
    END IF;
    CONTINUE WHEN v_row.status <> 'preparing_shipment';
    IF NOT v_row.is_flagged THEN
      UPDATE order_status
        SET is_flagged = true, flagged_reason = 'Item(s) out of stock', flagged_at = now(), flagged_by = 'System',
            flag_source = 'auto_out_of_stock', flag_detail = s->'detail', updated_at = now()
        WHERE id = v_row.id;
      INSERT INTO order_events (order_id, event_type, detail) VALUES (v_id, 'auto_flagged_out_of_stock', s->'detail');
      v_flagged := v_flagged + 1;
    ELSIF v_row.flag_source = 'auto_out_of_stock' AND v_row.flag_detail IS DISTINCT FROM s->'detail' THEN
      UPDATE order_status SET flag_detail = s->'detail', updated_at = now() WHERE id = v_row.id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  FOREACH v_id IN ARRAY coalesce(p_covered, ARRAY[]::text[]) LOOP
    SELECT * INTO v_row FROM order_status WHERE shopify_order_id = v_id FOR UPDATE;
    CONTINUE WHEN v_row.id IS NULL OR NOT v_row.is_flagged OR v_row.flag_source IS DISTINCT FROM 'auto_out_of_stock';
    UPDATE order_status
      SET is_flagged = false, flagged_reason = NULL, flagged_at = NULL, flagged_by = NULL, updated_at = now()
      WHERE id = v_row.id;
    INSERT INTO order_events (order_id, event_type, detail)
    VALUES (v_id, 'auto_unflagged', jsonb_build_object('previous', v_row.flag_detail));
    v_cleared := v_cleared + 1;
  END LOOP;

  PERFORM set_config('kcg.fg_auto_flag', 'off', true);
  RETURN jsonb_build_object('flagged', v_flagged, 'updated', v_updated, 'cleared', v_cleared);
END $$;

-- ===========================================================================
-- 10) Test-only cleanup (service role): removes data for "[TEST]" products
--     and "TEST-" orders only.
-- ===========================================================================
CREATE OR REPLACE FUNCTION fg_test_cleanup(p_product_ids uuid[], p_order_ids text[]) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_n integer := 0; v_k integer;
BEGIN
  PERFORM set_config('kcg.fg_test_cleanup', 'on', true);
  DELETE FROM order_batch_picks WHERE order_id = ANY(p_order_ids) AND order_id LIKE 'TEST-%';
  DELETE FROM inventory_transactions t USING products p
    WHERE t.product_id = p.id AND p.id = ANY(p_product_ids) AND p.name LIKE '[TEST]%';
  DELETE FROM order_batch_picks b USING products p
    WHERE b.product_id = p.id AND p.id = ANY(p_product_ids) AND p.name LIKE '[TEST]%' AND b.order_id LIKE 'TEST-%';
  DELETE FROM finished_goods_batches b USING products p
    WHERE b.product_id = p.id AND p.id = ANY(p_product_ids) AND p.name LIKE '[TEST]%';
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  DELETE FROM finished_products_inventory f USING products p
    WHERE f.product_id = p.id AND p.id = ANY(p_product_ids) AND p.name LIKE '[TEST]%';
  PERFORM set_config('kcg.fg_test_cleanup', 'off', true);
  RETURN v_n;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'fg_sync_product(uuid)', 'fg_next_batch_code()', 'fg_require_tracked(uuid)',
    'fg_write_tx(uuid, text, integer, text, uuid, text, text)', 'fg_lock_batches(uuid[])',
    'fg_reverse_order_picks(text, text)',
    'create_batches_from_production(uuid, jsonb, timestamptz)',
    'complete_botaniqals_production(uuid, jsonb, jsonb, timestamptz)',
    'add_manual_batch(uuid, integer, date, text, text)',
    'count_batches(jsonb, text)',
    'mark_order_picked(text, uuid, text, jsonb, jsonb, text)',
    'return_order_to_picking(text)',
    'release_staging_box(uuid, text)',
    'sync_out_of_stock_flags(jsonb, text[])',
    'fg_test_cleanup(uuid[], text[])',
    'peek_next_batch_codes(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
