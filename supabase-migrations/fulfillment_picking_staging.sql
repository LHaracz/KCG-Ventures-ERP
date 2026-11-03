-- Picking, Staging Boxes, Packaging Rules, Shipping Assignments.
-- Run in the Supabase SQL editor (dev project first, production only after
-- the dev run passes and a backup has been taken). Safe to re-run.
--
-- Additive only:
--   * new tables: product_packaging_rules, staging_box_counter, staging_boxes,
--     staging_box_assignments, order_events, order_packaging,
--     fulfillment_orders_cache, fulfillment_orders_cache_state
--   * new nullable columns: package_presets.max_points,
--     order_status.label_purchase_started_at
--   * one new order_status value: 'picked' (the CHECK constraint is re-created
--     with the same four values plus 'picked'; no row changes)
--   * package_presets RLS: per-login -> shared by every logged-in user
--     (approved change; user_id is kept and still set on insert)
--
-- Every warehouse state change is a plpgsql function below, called by the
-- app's API routes through supabaseAdmin.rpc(...), one transaction each.
-- Business rule failures raise P0001 with a plain-language message and a
-- machine-readable code in HINT (e.g. 'box_in_use').

-- ===========================================================================
-- 1) package_presets: max points + shared access
-- ===========================================================================

ALTER TABLE package_presets ADD COLUMN IF NOT EXISTS max_points numeric(8,2);

ALTER TABLE package_presets DROP CONSTRAINT IF EXISTS package_presets_max_points_positive;
ALTER TABLE package_presets ADD CONSTRAINT package_presets_max_points_positive
  CHECK (max_points IS NULL OR max_points > 0);

-- Among presets with max points, each value is unique (it defines size order).
CREATE UNIQUE INDEX IF NOT EXISTS uq_package_presets_max_points
  ON package_presets(max_points) WHERE max_points IS NOT NULL;

DROP POLICY IF EXISTS package_presets_user_policy ON package_presets;
DROP POLICY IF EXISTS package_presets_shared_policy ON package_presets;
CREATE POLICY package_presets_shared_policy ON package_presets
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- ===========================================================================
-- 2) product_packaging_rules
-- ===========================================================================

CREATE TABLE IF NOT EXISTS product_packaging_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  points numeric(8,2) CHECK (points IS NULL OR points > 0),
  min_package_id uuid REFERENCES package_presets(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE product_packaging_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_packaging_rules_shared_policy ON product_packaging_rules;
CREATE POLICY product_packaging_rules_shared_policy ON product_packaging_rules
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
GRANT SELECT, INSERT, UPDATE ON TABLE product_packaging_rules TO authenticated;

-- A smallest-allowed package must be a preset that has max points, and the
-- updated_at stamp is kept current on every save.
CREATE OR REPLACE FUNCTION product_packaging_rules_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF new.min_package_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM package_presets p WHERE p.id = new.min_package_id AND p.max_points IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'The smallest allowed package must be a package with max points set.'
      USING errcode = 'P0001', hint = 'min_package_invalid';
  END IF;
  new.updated_at := now();
  RETURN new;
END $$;

DROP TRIGGER IF EXISTS trg_product_packaging_rules_guard ON product_packaging_rules;
CREATE TRIGGER trg_product_packaging_rules_guard
  BEFORE INSERT OR UPDATE ON product_packaging_rules
  FOR EACH ROW EXECUTE FUNCTION product_packaging_rules_guard();

-- ===========================================================================
-- 3) order_status: add 'picked' (+ label purchase claim column)
-- ===========================================================================

-- The original CHECK was declared inline, so its name is generated. Drop
-- whichever CHECK on order_status.status lists the pipeline values, then
-- re-add it under a known name with 'picked' included.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'order_status'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%preparing_shipment%'
      AND pg_get_constraintdef(c.oid) LIKE '%label_generated%'
  LOOP
    EXECUTE format('ALTER TABLE order_status DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE order_status ADD CONSTRAINT order_status_status_check
  CHECK (status IN ('preparing_shipment', 'picked', 'label_generated', 'label_printed', 'fulfilled'));

-- Set while an EasyPost purchase is in flight so two clicks can't buy two
-- labels for one order. Cleared when the purchase is recorded or abandoned.
ALTER TABLE order_status ADD COLUMN IF NOT EXISTS label_purchase_started_at timestamptz;

-- ===========================================================================
-- 4) Staging boxes, assignments, order events
-- ===========================================================================

-- Box numbers come from this counter, which only ever goes up, so a number
-- is never reused (not even after a test box is cleaned up).
CREATE TABLE IF NOT EXISTS staging_box_counter (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_number integer NOT NULL DEFAULT 0
);
INSERT INTO staging_box_counter (id, last_number) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS staging_boxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  box_number integer NOT NULL UNIQUE CHECK (box_number > 0),
  label text GENERATED ALWAYS AS ('STG-' || box_number::text) STORED UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  -- Only the automated tests create test boxes (so they can be cleaned up).
  is_test boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS staging_box_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,              -- Shopify numeric order id, as in order_status.shopify_order_id
  order_name text,                     -- snapshot, e.g. "#2554", for messages
  staging_box_id uuid NOT NULL REFERENCES staging_boxes(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('fulfilled', 'returned_to_picking', 'manual_release', 'auto_reconcile')),
  release_note text,
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);

-- One order per box and one box per order, enforced even under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS uq_staging_box_open_by_box
  ON staging_box_assignments(staging_box_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_staging_box_open_by_order
  ON staging_box_assignments(order_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staging_box_assignments_assigned_at
  ON staging_box_assignments(assigned_at DESC);

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'picked', 'returned_to_picking', 'box_released', 'packaging_override', 'packaging_override_cleared'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id, created_at);

-- Guards. Boxes and assignments are never hard deleted; an assignment can only
-- go from open to released (once); order_events is append-only. The single
-- exception is fulfillment_test_cleanup() below, which only removes rows for
-- invented TEST- orders and boxes flagged is_test.
CREATE OR REPLACE FUNCTION fulfillment_test_cleanup_active() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('kcg.fulfillment_test_cleanup', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION staging_boxes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    IF fulfillment_test_cleanup_active() AND old.is_test THEN RETURN old; END IF;
    RAISE EXCEPTION 'Staging boxes are never deleted. Retire the box instead.' USING errcode = 'P0001';
  END IF;
  IF new.box_number <> old.box_number OR new.is_test <> old.is_test THEN
    RAISE EXCEPTION 'A staging box number cannot be changed.' USING errcode = 'P0001';
  END IF;
  RETURN new;
END $$;
DROP TRIGGER IF EXISTS trg_staging_boxes_guard ON staging_boxes;
CREATE TRIGGER trg_staging_boxes_guard BEFORE UPDATE OR DELETE ON staging_boxes
  FOR EACH ROW EXECUTE FUNCTION staging_boxes_guard();

CREATE OR REPLACE FUNCTION staging_box_assignments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    IF fulfillment_test_cleanup_active() AND old.order_id LIKE 'TEST-%' THEN RETURN old; END IF;
    RAISE EXCEPTION 'Staging box assignments are never deleted. Release them instead.' USING errcode = 'P0001';
  END IF;
  IF old.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'A released staging box assignment cannot be changed.' USING errcode = 'P0001';
  END IF;
  IF new.order_id <> old.order_id OR new.staging_box_id <> old.staging_box_id
     OR new.assigned_at <> old.assigned_at OR new.order_name IS DISTINCT FROM old.order_name THEN
    RAISE EXCEPTION 'An open staging box assignment can only be released, not changed.' USING errcode = 'P0001';
  END IF;
  RETURN new;
END $$;
DROP TRIGGER IF EXISTS trg_staging_box_assignments_guard ON staging_box_assignments;
CREATE TRIGGER trg_staging_box_assignments_guard BEFORE UPDATE OR DELETE ON staging_box_assignments
  FOR EACH ROW EXECUTE FUNCTION staging_box_assignments_guard();

CREATE OR REPLACE FUNCTION order_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' AND fulfillment_test_cleanup_active() AND old.order_id LIKE 'TEST-%' THEN
    RETURN old;
  END IF;
  RAISE EXCEPTION 'order_events is append-only (% is not allowed).', tg_op USING errcode = 'P0001';
END $$;
DROP TRIGGER IF EXISTS trg_order_events_no_update ON order_events;
CREATE TRIGGER trg_order_events_no_update BEFORE UPDATE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_guard();
DROP TRIGGER IF EXISTS trg_order_events_no_delete ON order_events;
CREATE TRIGGER trg_order_events_no_delete BEFORE DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_guard();

-- ===========================================================================
-- 5) order_packaging (overrides only; suggestions are computed live)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS order_packaging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL UNIQUE,
  override_target text NOT NULL CHECK (override_target IN ('preset', 'needs_review')),
  override_preset_id uuid REFERENCES package_presets(id) ON DELETE SET NULL,
  override_preset_name text,
  override_at timestamptz NOT NULL DEFAULT now()
);

-- A preset can't be deleted while a product rule or an open order's override
-- uses it. The message names where it is used.
CREATE OR REPLACE FUNCTION package_presets_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_products text;
  v_orders text;
BEGIN
  SELECT string_agg(pr.name, ', ' ORDER BY pr.name) INTO v_products
  FROM product_packaging_rules r JOIN products pr ON pr.id = r.product_id
  WHERE r.min_package_id = old.id;

  SELECT string_agg(coalesce(a.order_name, op.order_id), ', ' ORDER BY op.order_id) INTO v_orders
  FROM order_packaging op
  LEFT JOIN order_status os ON os.shopify_order_id = op.order_id
  LEFT JOIN LATERAL (
    SELECT sba.order_name FROM staging_box_assignments sba
    WHERE sba.order_id = op.order_id ORDER BY sba.assigned_at DESC LIMIT 1
  ) a ON true
  WHERE op.override_target = 'preset' AND op.override_preset_id = old.id
    AND coalesce(os.status, 'preparing_shipment') <> 'fulfilled';

  IF v_products IS NOT NULL OR v_orders IS NOT NULL THEN
    RAISE EXCEPTION '% is still in use%. Change those first.',
      old.nickname,
      concat_ws('', CASE WHEN v_products IS NOT NULL THEN ' as the smallest allowed package for: ' || v_products END,
                    CASE WHEN v_orders IS NOT NULL THEN
                      CASE WHEN v_products IS NOT NULL THEN '; and' ELSE '' END || ' as the package override on open orders: ' || v_orders END)
      USING errcode = 'P0001', hint = 'preset_in_use';
  END IF;
  RETURN old;
END $$;
DROP TRIGGER IF EXISTS trg_package_presets_delete_guard ON package_presets;
CREATE TRIGGER trg_package_presets_delete_guard BEFORE DELETE ON package_presets
  FOR EACH ROW EXECUTE FUNCTION package_presets_delete_guard();

-- ===========================================================================
-- 6) Fulfillment orders cache (ERP-side copy of the Shopify order list)
-- ===========================================================================

-- One row per order the Fulfillments list shows. Replaced as a set at most
-- once a minute by the list loader; everyone else reads it.
CREATE TABLE IF NOT EXISTS fulfillment_orders_cache (
  shopify_order_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('live', 'recently_fulfilled', 'test')),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fulfillment_orders_cache_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_refreshed_at timestamptz,       -- last successful Shopify refresh
  last_attempt_at timestamptz,         -- last time a refresh was started (success or not)
  refresh_lock_until timestamptz,      -- a refresher is working until this time
  last_error text,
  last_error_at timestamptz,
  last_error_throttled boolean NOT NULL DEFAULT false
);
INSERT INTO fulfillment_orders_cache_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 7) Row level security for the new tables. Reads: any logged-in user.
--    Writes: only through the functions below (server, service role).
-- ===========================================================================

ALTER TABLE staging_box_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_box_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_packaging ENABLE ROW LEVEL SECURITY;
ALTER TABLE fulfillment_orders_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE fulfillment_orders_cache_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staging_boxes_read ON staging_boxes;
CREATE POLICY staging_boxes_read ON staging_boxes FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS staging_box_assignments_read ON staging_box_assignments;
CREATE POLICY staging_box_assignments_read ON staging_box_assignments FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS order_events_read ON order_events;
CREATE POLICY order_events_read ON order_events FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS order_packaging_read ON order_packaging;
CREATE POLICY order_packaging_read ON order_packaging FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS fulfillment_orders_cache_read ON fulfillment_orders_cache;
CREATE POLICY fulfillment_orders_cache_read ON fulfillment_orders_cache FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS fulfillment_orders_cache_state_read ON fulfillment_orders_cache_state;
CREATE POLICY fulfillment_orders_cache_state_read ON fulfillment_orders_cache_state FOR SELECT USING (auth.role() = 'authenticated');

GRANT SELECT ON TABLE staging_boxes, staging_box_assignments, order_events, order_packaging,
  fulfillment_orders_cache, fulfillment_orders_cache_state TO authenticated;
REVOKE ALL ON TABLE staging_boxes, staging_box_assignments, order_events, order_packaging,
  fulfillment_orders_cache, fulfillment_orders_cache_state, staging_box_counter FROM anon;

-- ===========================================================================
-- 8) Functions
-- ===========================================================================

-- Raises a business-rule error: message for people, code in HINT for the app.
CREATE OR REPLACE FUNCTION fo_fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING errcode = 'P0001', hint = p_code;
END $$;

-- Display name for an order in messages ("#2554"), falling back to the id.
CREATE OR REPLACE FUNCTION fo_order_label(p_order_id text, p_order_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN nullif(trim(p_order_name), '') IS NULL THEN '#' || p_order_id
    WHEN position('#' in p_order_name) > 0 THEN trim(p_order_name)
    ELSE '#' || trim(p_order_name)
  END
$$;

-- Ensures the order has an order_status row (none means preparing_shipment)
-- and locks it for the rest of the transaction.
CREATE OR REPLACE FUNCTION fo_lock_order(p_order_id text) RETURNS order_status
LANGUAGE plpgsql AS $$
DECLARE v_row order_status;
BEGIN
  IF p_order_id IS NULL OR trim(p_order_id) = '' THEN
    PERFORM fo_fail('missing_order', 'Missing order id.');
  END IF;
  INSERT INTO order_status (shopify_order_id, status) VALUES (p_order_id, 'preparing_shipment')
  ON CONFLICT (shopify_order_id) DO NOTHING;
  SELECT * INTO v_row FROM order_status WHERE shopify_order_id = p_order_id FOR UPDATE;
  RETURN v_row;
END $$;

-- True when the order has a purchased label that is neither voided nor
-- fulfilled, or its status says a label exists.
CREATE OR REPLACE FUNCTION fo_has_active_label(p_order_id text, p_status text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_status IN ('label_generated', 'label_printed')
      OR EXISTS (SELECT 1 FROM fulfillment_log l
                 WHERE l.shopify_order_id = p_order_id AND l.voided_at IS NULL AND l.fulfilled_at IS NULL)
$$;

-- Clears an order's packaging override (if any) and records it.
CREATE OR REPLACE FUNCTION fo_clear_override_internal(p_order_id text, p_why text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_old order_packaging;
BEGIN
  DELETE FROM order_packaging WHERE order_id = p_order_id RETURNING * INTO v_old;
  IF v_old.id IS NULL THEN RETURN false; END IF;
  INSERT INTO order_events (order_id, event_type, detail) VALUES (
    p_order_id, 'packaging_override_cleared',
    jsonb_build_object('previous', CASE WHEN v_old.override_target = 'needs_review' THEN 'Needs Review'
                                        ELSE coalesce(v_old.override_preset_name, 'Unknown package') END,
                       'reason', p_why));
  RETURN true;
END $$;

-- 8a) Create boxes ----------------------------------------------------------
CREATE OR REPLACE FUNCTION create_staging_boxes(p_count integer) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_last integer;
  v_labels text[] := '{}';
  v_max integer;
BEGIN
  IF p_count IS NULL OR p_count < 1 OR p_count > 50 THEN
    PERFORM fo_fail('invalid_count', 'Enter a number of boxes from 1 to 50.');
  END IF;
  SELECT last_number INTO v_last FROM staging_box_counter WHERE id = 1 FOR UPDATE;
  -- Never go below the highest box that exists.
  SELECT coalesce(max(box_number), 0) INTO v_max FROM staging_boxes;
  v_last := greatest(coalesce(v_last, 0), v_max);
  FOR i IN 1..p_count LOOP
    v_last := v_last + 1;
    INSERT INTO staging_boxes (box_number) VALUES (v_last);
    v_labels := v_labels || ('STG-' || v_last);
  END LOOP;
  UPDATE staging_box_counter SET last_number = v_last WHERE id = 1;
  RETURN jsonb_build_object('created', to_jsonb(v_labels));
END $$;

-- 8b) Retire an available box ----------------------------------------------
CREATE OR REPLACE FUNCTION retire_staging_box(p_box_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_box staging_boxes; v_open staging_box_assignments;
BEGIN
  SELECT * INTO v_box FROM staging_boxes WHERE id = p_box_id FOR UPDATE;
  IF v_box.id IS NULL THEN PERFORM fo_fail('box_not_found', 'Staging box not found.'); END IF;
  IF v_box.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('label', v_box.label, 'already_retired', true);
  END IF;
  SELECT * INTO v_open FROM staging_box_assignments WHERE staging_box_id = p_box_id AND released_at IS NULL;
  IF v_open.id IS NOT NULL THEN
    PERFORM fo_fail('box_in_use', format('%s is holding order %s. Release it before retiring.',
      v_box.label, fo_order_label(v_open.order_id, v_open.order_name)));
  END IF;
  UPDATE staging_boxes SET archived_at = now() WHERE id = p_box_id;
  RETURN jsonb_build_object('label', v_box.label, 'already_retired', false);
END $$;

-- 8c) Mark an order picked into a box --------------------------------------
-- Lock order: the order row first, then the box row (same order everywhere).
CREATE OR REPLACE FUNCTION mark_order_picked(p_order_id text, p_box_id uuid, p_order_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_status order_status;
  v_box staging_boxes;
  v_open staging_box_assignments;
  v_open_box text;
  v_label text := fo_order_label(p_order_id, p_order_name);
  v_assignment_id uuid;
BEGIN
  v_status := fo_lock_order(p_order_id);

  SELECT * INTO v_open FROM staging_box_assignments
    WHERE order_id = p_order_id AND released_at IS NULL;
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

  BEGIN
    INSERT INTO staging_box_assignments (order_id, order_name, staging_box_id)
    VALUES (p_order_id, nullif(trim(p_order_name), ''), p_box_id)
    RETURNING id INTO v_assignment_id;
  EXCEPTION WHEN unique_violation THEN
    -- Backstop for a race the row locks didn't catch. Nothing is overwritten.
    PERFORM fo_fail('box_in_use', format('%s was just taken by another picker.', v_box.label));
  END;

  UPDATE order_status SET status = 'picked', updated_at = now() WHERE shopify_order_id = p_order_id;
  INSERT INTO order_events (order_id, event_type, detail)
  VALUES (p_order_id, 'picked', jsonb_build_object('box', v_box.label, 'box_id', v_box.id, 'order_name', v_label));

  RETURN jsonb_build_object('assignment_id', v_assignment_id, 'box_label', v_box.label);
END $$;

-- 8d) Return a picked order to picking --------------------------------------
CREATE OR REPLACE FUNCTION return_order_to_picking(p_order_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_status order_status;
  v_open staging_box_assignments;
  v_box_label text;
  v_label text;
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

  UPDATE order_status SET status = 'preparing_shipment', updated_at = now() WHERE shopify_order_id = p_order_id;
  PERFORM fo_clear_override_internal(p_order_id, 'returned_to_picking');
  INSERT INTO order_events (order_id, event_type, detail)
  VALUES (p_order_id, 'returned_to_picking', jsonb_build_object('box', v_box_label));

  RETURN jsonb_build_object('released_box', v_box_label);
END $$;

-- 8e) Release a lost / damaged / stuck box ---------------------------------
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

  -- Find the order first (no lock), then lock order row before box row, to
  -- keep the same lock order as mark_order_picked. Re-check after locking.
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

-- 8f) Release on fulfilled (idempotent) ------------------------------------
CREATE OR REPLACE FUNCTION release_assignment_on_fulfilled(p_order_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_open staging_box_assignments; v_box_label text;
BEGIN
  SELECT * INTO v_open FROM staging_box_assignments
    WHERE order_id = p_order_id AND released_at IS NULL FOR UPDATE;
  IF v_open.id IS NULL THEN RETURN jsonb_build_object('released', false); END IF;
  SELECT label INTO v_box_label FROM staging_boxes WHERE id = v_open.staging_box_id;
  UPDATE staging_box_assignments SET released_at = now(), release_reason = 'fulfilled' WHERE id = v_open.id;
  INSERT INTO order_events (order_id, event_type, detail)
  VALUES (p_order_id, 'box_released', jsonb_build_object('box', v_box_label, 'reason', 'fulfilled'));
  RETURN jsonb_build_object('released', true, 'box_label', v_box_label);
END $$;

-- 8g) Reconcile: free boxes whose order is fulfilled in the ERP -------------
CREATE OR REPLACE FUNCTION reconcile_staging_assignments() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE r record; v_count integer := 0;
BEGIN
  FOR r IN
    SELECT a.id, a.order_id, b.label
    FROM staging_box_assignments a
    JOIN order_status os ON os.shopify_order_id = a.order_id
    JOIN staging_boxes b ON b.id = a.staging_box_id
    WHERE a.released_at IS NULL AND os.status = 'fulfilled'
    FOR UPDATE OF a SKIP LOCKED
  LOOP
    UPDATE staging_box_assignments SET released_at = now(), release_reason = 'auto_reconcile'
      WHERE id = r.id AND released_at IS NULL;
    IF FOUND THEN
      INSERT INTO order_events (order_id, event_type, detail)
      VALUES (r.order_id, 'box_released', jsonb_build_object('box', r.label, 'reason', 'auto_reconcile'));
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END $$;

-- 8h) Packaging overrides ---------------------------------------------------
-- p_previous_label is the package the order showed before (computed by the
-- app's packaging engine, since suggestions are not stored).
CREATE OR REPLACE FUNCTION set_packaging_override(
  p_order_id text, p_target text, p_preset_id uuid DEFAULT NULL, p_previous_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_status order_status;
  v_preset package_presets;
  v_new_label text;
BEGIN
  v_status := fo_lock_order(p_order_id);
  IF v_status.status NOT IN ('picked', 'label_generated', 'label_printed') THEN
    PERFORM fo_fail('override_not_allowed', 'The package can only be changed after the order is picked and before it is fulfilled.');
  END IF;
  IF p_target = 'preset' THEN
    SELECT * INTO v_preset FROM package_presets WHERE id = p_preset_id;
    IF v_preset.id IS NULL THEN PERFORM fo_fail('preset_not_found', 'Package not found.'); END IF;
    IF v_preset.max_points IS NULL THEN
      PERFORM fo_fail('preset_no_max_points', format('%s has no max points set.', v_preset.nickname));
    END IF;
    v_new_label := v_preset.nickname;
  ELSIF p_target = 'needs_review' THEN
    v_new_label := 'Needs Review';
  ELSE
    PERFORM fo_fail('invalid_target', 'Choose a package or Needs Review.');
  END IF;

  INSERT INTO order_packaging (order_id, override_target, override_preset_id, override_preset_name, override_at)
  VALUES (p_order_id, p_target, CASE WHEN p_target = 'preset' THEN v_preset.id END,
          CASE WHEN p_target = 'preset' THEN v_preset.nickname END, now())
  ON CONFLICT (order_id) DO UPDATE SET
    override_target = excluded.override_target,
    override_preset_id = excluded.override_preset_id,
    override_preset_name = excluded.override_preset_name,
    override_at = excluded.override_at;

  INSERT INTO order_events (order_id, event_type, detail)
  VALUES (p_order_id, 'packaging_override',
          jsonb_build_object('previous', p_previous_label, 'new', v_new_label,
                             'preset_id', CASE WHEN p_target = 'preset' THEN v_preset.id END));
  RETURN jsonb_build_object('package', v_new_label);
END $$;

CREATE OR REPLACE FUNCTION clear_packaging_override(p_order_id text, p_restored_label text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_cleared boolean;
BEGIN
  PERFORM fo_lock_order(p_order_id);
  v_cleared := fo_clear_override_internal(p_order_id, coalesce('restored suggestion: ' || p_restored_label, 'cleared'));
  RETURN jsonb_build_object('cleared', v_cleared);
END $$;

-- 8i) Label purchase gating -------------------------------------------------
-- Called before buying with EasyPost. Rejects orders still waiting to be
-- picked, fulfilled orders, orders that already have an active label, and a
-- second purchase while one is in flight (claim expires after 2 minutes).
CREATE OR REPLACE FUNCTION begin_label_purchase(p_order_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_status order_status;
BEGIN
  v_status := fo_lock_order(p_order_id);
  IF v_status.status = 'preparing_shipment' THEN
    PERFORM fo_fail('not_picked', 'Pick this order first: assign a staging box on the Pick List.');
  END IF;
  IF v_status.status = 'fulfilled' THEN
    PERFORM fo_fail('already_fulfilled', 'This order is already fulfilled.');
  END IF;
  IF fo_has_active_label(p_order_id, v_status.status) THEN
    PERFORM fo_fail('label_exists', 'This order already has an active label. Void it before buying another.');
  END IF;
  IF v_status.label_purchase_started_at IS NOT NULL
     AND v_status.label_purchase_started_at > now() - interval '2 minutes' THEN
    PERFORM fo_fail('purchase_in_progress', 'A label purchase for this order is already in progress.');
  END IF;
  UPDATE order_status SET label_purchase_started_at = now() WHERE shopify_order_id = p_order_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Records a bought label and moves the status in one transaction.
CREATE OR REPLACE FUNCTION complete_label_purchase(p_order_id text, p_log jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_log_id uuid;
BEGIN
  PERFORM fo_lock_order(p_order_id);
  INSERT INTO fulfillment_log (shopify_order_id, tracking_number, carrier, service, label_url,
                               easypost_shipment_id, rate_amount, rate_currency)
  VALUES (p_order_id, p_log->>'tracking_number', p_log->>'carrier', p_log->>'service', p_log->>'label_url',
          p_log->>'easypost_shipment_id', nullif(p_log->>'rate_amount', '')::numeric, p_log->>'rate_currency')
  RETURNING id INTO v_log_id;
  UPDATE order_status SET status = 'label_generated', label_purchase_started_at = NULL, updated_at = now()
    WHERE shopify_order_id = p_order_id;
  RETURN jsonb_build_object('log_id', v_log_id);
END $$;

CREATE OR REPLACE FUNCTION cancel_label_purchase(p_order_id text) RETURNS void
LANGUAGE sql AS $$
  UPDATE order_status SET label_purchase_started_at = NULL WHERE shopify_order_id = p_order_id;
$$;

-- 8j) Void: stamp the log row and set the status from the box -------------
CREATE OR REPLACE FUNCTION finish_label_void(p_order_id text, p_log_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_new text;
BEGIN
  PERFORM fo_lock_order(p_order_id);
  UPDATE fulfillment_log SET voided_at = now() WHERE id = p_log_id AND voided_at IS NULL;
  v_new := CASE WHEN EXISTS (SELECT 1 FROM staging_box_assignments
                             WHERE order_id = p_order_id AND released_at IS NULL)
                THEN 'picked' ELSE 'preparing_shipment' END;
  UPDATE order_status SET status = v_new, label_purchase_started_at = NULL, updated_at = now()
    WHERE shopify_order_id = p_order_id;
  RETURN jsonb_build_object('status', v_new);
END $$;

-- 8k) Orders cache refresh coordination --------------------------------------
-- Returns true when the caller may refresh from Shopify now: the last attempt
-- was at least p_min_interval_seconds ago and no other refresher holds the
-- lock. Claims the lock for p_lock_seconds.
CREATE OR REPLACE FUNCTION fulfillment_cache_try_claim(p_min_interval_seconds integer, p_lock_seconds integer)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_state fulfillment_orders_cache_state;
BEGIN
  SELECT * INTO v_state FROM fulfillment_orders_cache_state WHERE id = 1 FOR UPDATE;
  IF v_state.id IS NULL THEN
    INSERT INTO fulfillment_orders_cache_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_state FROM fulfillment_orders_cache_state WHERE id = 1 FOR UPDATE;
  END IF;
  IF v_state.refresh_lock_until IS NOT NULL AND v_state.refresh_lock_until > clock_timestamp() THEN
    RETURN false;
  END IF;
  IF v_state.last_attempt_at IS NOT NULL
     AND v_state.last_attempt_at > clock_timestamp() - make_interval(secs => p_min_interval_seconds) THEN
    RETURN false;
  END IF;
  UPDATE fulfillment_orders_cache_state
    SET last_attempt_at = clock_timestamp(),
        refresh_lock_until = clock_timestamp() + make_interval(secs => p_lock_seconds)
    WHERE id = 1;
  RETURN true;
END $$;

-- Replaces the Shopify-sourced rows (test rows are left alone) and records
-- success, in one transaction.
CREATE OR REPLACE FUNCTION fulfillment_cache_replace(p_rows jsonb) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM fulfillment_orders_cache WHERE source <> 'test';
  INSERT INTO fulfillment_orders_cache (shopify_order_id, payload, source, refreshed_at)
  SELECT r->>'shopify_order_id', r->'payload', r->>'source', clock_timestamp()
  FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  ON CONFLICT (shopify_order_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE fulfillment_orders_cache_state
    SET last_refreshed_at = clock_timestamp(), refresh_lock_until = NULL,
        last_error = NULL, last_error_at = NULL, last_error_throttled = false
    WHERE id = 1;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION fulfillment_cache_record_error(p_message text, p_throttled boolean) RETURNS void
LANGUAGE sql AS $$
  UPDATE fulfillment_orders_cache_state
    SET refresh_lock_until = NULL, last_error = left(p_message, 1000),
        last_error_at = clock_timestamp(), last_error_throttled = coalesce(p_throttled, false)
    WHERE id = 1;
$$;

-- 8l) Test-only cleanup (service role). Only touches invented TEST- orders and
--     boxes created with is_test = true.
CREATE OR REPLACE FUNCTION fulfillment_test_cleanup(p_order_ids text[], p_box_ids uuid[]) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_count integer := 0; v_n integer;
BEGIN
  PERFORM set_config('kcg.fulfillment_test_cleanup', 'on', true);
  DELETE FROM order_events WHERE order_id = ANY(p_order_ids) AND order_id LIKE 'TEST-%';
  DELETE FROM staging_box_assignments WHERE order_id = ANY(p_order_ids) AND order_id LIKE 'TEST-%';
  DELETE FROM order_packaging WHERE order_id = ANY(p_order_ids) AND order_id LIKE 'TEST-%';
  DELETE FROM fulfillment_log WHERE shopify_order_id = ANY(p_order_ids) AND shopify_order_id LIKE 'TEST-%';
  DELETE FROM order_status WHERE shopify_order_id = ANY(p_order_ids) AND shopify_order_id LIKE 'TEST-%';
  DELETE FROM fulfillment_orders_cache WHERE shopify_order_id = ANY(p_order_ids) AND shopify_order_id LIKE 'TEST-%';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
  DELETE FROM staging_boxes WHERE id = ANY(p_box_ids) AND is_test
    AND NOT EXISTS (SELECT 1 FROM staging_box_assignments a WHERE a.staging_box_id = staging_boxes.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
  PERFORM set_config('kcg.fulfillment_test_cleanup', 'off', true);
  RETURN v_count;
END $$;

-- Only the server (service role) may call these.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'create_staging_boxes(integer)',
    'retire_staging_box(uuid)',
    'mark_order_picked(text, uuid, text)',
    'return_order_to_picking(text)',
    'release_staging_box(uuid, text)',
    'release_assignment_on_fulfilled(text)',
    'reconcile_staging_assignments()',
    'set_packaging_override(text, text, uuid, text)',
    'clear_packaging_override(text, text)',
    'begin_label_purchase(text)',
    'complete_label_purchase(text, jsonb)',
    'cancel_label_purchase(text)',
    'finish_label_void(text, uuid)',
    'fulfillment_cache_try_claim(integer, integer)',
    'fulfillment_cache_replace(jsonb)',
    'fulfillment_cache_record_error(text, boolean)',
    'fulfillment_test_cleanup(text[], uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- Reload the PostgREST schema cache so the new tables and functions are visible.
NOTIFY pgrst, 'reload schema';
