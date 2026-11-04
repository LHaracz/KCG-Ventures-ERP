-- Void Label at any stage, replacement labels after fulfillment, and label
-- printing recorded on the label. Run in the Supabase SQL editor BEFORE
-- deploying the matching code. Safe to run more than once.
--
-- Additive only: new nullable columns on fulfillment_log and new or replaced
-- functions. No existing row is changed.
--
-- Requires: fulfillments_status_pipeline.sql, fulfillment_picking_staging.sql.

-- 1) Label columns ------------------------------------------------------------
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS refund_status text;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS refund_message text;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS refund_requested_at timestamptz;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS easypost_refund_id text;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS easypost_tracker_status text;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS void_note text;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS printed_at timestamptz;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS tracking_url text;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS is_replacement boolean;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS notify_customer boolean;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS shopify_fulfillment_id text;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS shopify_tracking_synced_at timestamptz;
ALTER TABLE fulfillment_log ADD COLUMN IF NOT EXISTS shopify_sync_error text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fulfillment_log_refund_status_check') THEN
    ALTER TABLE fulfillment_log ADD CONSTRAINT fulfillment_log_refund_status_check
      CHECK (refund_status IS NULL OR refund_status IN
             ('not_requested', 'submitted', 'refunded', 'rejected', 'not_applicable', 'error'));
  END IF;
END $$;

-- 2) Void ---------------------------------------------------------------------
-- Step 1 (before EasyPost): claim the active label for voiding. Refuses a
-- second void while one is in flight, and reports when a refund was already
-- requested for this label (then the caller must not request it again).
CREATE OR REPLACE FUNCTION begin_label_void(p_order_id text, p_log_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_log fulfillment_log; v_already boolean;
BEGIN
  PERFORM fo_lock_order(p_order_id);
  SELECT * INTO v_log FROM fulfillment_log WHERE id = p_log_id AND shopify_order_id = p_order_id FOR UPDATE;
  IF v_log.id IS NULL THEN PERFORM fo_fail('label_not_found', 'Label not found for this order.'); END IF;
  IF v_log.voided_at IS NOT NULL THEN PERFORM fo_fail('already_voided', 'This label is already voided.'); END IF;
  IF v_log.refund_requested_at IS NOT NULL AND v_log.refund_status IS NULL
     AND v_log.refund_requested_at > now() - interval '2 minutes' THEN
    PERFORM fo_fail('void_in_progress', 'This label is already being voided.');
  END IF;
  v_already := v_log.refund_requested_at IS NOT NULL;
  IF NOT v_already THEN
    UPDATE fulfillment_log SET refund_requested_at = now() WHERE id = p_log_id;
  END IF;
  RETURN jsonb_build_object('shipment_id', v_log.easypost_shipment_id, 'refund_already_requested', v_already,
                            'refund_status', v_log.refund_status, 'refund_message', v_log.refund_message);
END $$;

-- Step 2 (after EasyPost, whatever it answered): void the label here and set
-- the order's status. A fulfilled order stays fulfilled; nothing touches
-- boxes, batches or inventory.
-- p_refund: {status, message, refund_id, tracker_status}
CREATE OR REPLACE FUNCTION complete_label_void(p_order_id text, p_log_id uuid, p_refund jsonb, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_status order_status; v_new text;
BEGIN
  v_status := fo_lock_order(p_order_id);
  UPDATE fulfillment_log SET
    voided_at = coalesce(voided_at, now()),
    refund_status = coalesce(nullif(p_refund->>'status', ''), refund_status, 'error'),
    refund_message = coalesce(nullif(p_refund->>'message', ''), refund_message),
    easypost_refund_id = coalesce(nullif(p_refund->>'refund_id', ''), easypost_refund_id),
    easypost_tracker_status = coalesce(nullif(p_refund->>'tracker_status', ''), easypost_tracker_status),
    void_note = coalesce(nullif(trim(p_note), ''), void_note)
  WHERE id = p_log_id AND shopify_order_id = p_order_id;
  IF NOT FOUND THEN PERFORM fo_fail('label_not_found', 'Label not found for this order.'); END IF;

  IF v_status.status = 'fulfilled' THEN
    v_new := 'fulfilled';
  ELSE
    v_new := CASE WHEN EXISTS (SELECT 1 FROM staging_box_assignments
                               WHERE order_id = p_order_id AND released_at IS NULL)
                  THEN 'picked' ELSE 'preparing_shipment' END;
    UPDATE order_status SET status = v_new, label_purchase_started_at = NULL, updated_at = now()
      WHERE shopify_order_id = p_order_id;
  END IF;
  RETURN jsonb_build_object('status', v_new, 'fulfilled', v_status.status = 'fulfilled');
END $$;

-- Retry a rejected or failed refund (never one that is submitted or refunded).
CREATE OR REPLACE FUNCTION begin_refund_retry(p_order_id text, p_log_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_log fulfillment_log;
BEGIN
  SELECT * INTO v_log FROM fulfillment_log WHERE id = p_log_id AND shopify_order_id = p_order_id FOR UPDATE;
  IF v_log.id IS NULL THEN PERFORM fo_fail('label_not_found', 'Label not found for this order.'); END IF;
  IF v_log.voided_at IS NULL THEN PERFORM fo_fail('not_voided', 'Void the label before retrying the refund.'); END IF;
  IF coalesce(v_log.refund_status, '') NOT IN ('rejected', 'error') THEN
    PERFORM fo_fail('refund_not_retryable', CASE
      WHEN v_log.refund_status IN ('submitted', 'refunded') THEN 'The refund was already ' || v_log.refund_status || '. It cannot be requested again.'
      ELSE 'This refund cannot be retried.' END);
  END IF;
  IF v_log.refund_requested_at IS NOT NULL AND v_log.refund_requested_at > now() - interval '5 seconds' THEN
    PERFORM fo_fail('refund_in_progress', 'A refund request for this label was just sent. Wait a moment.');
  END IF;
  UPDATE fulfillment_log SET refund_requested_at = now() WHERE id = p_log_id;
  RETURN jsonb_build_object('shipment_id', v_log.easypost_shipment_id);
END $$;

-- 3) Buying labels: a replacement for a fulfilled order ----------------------
-- Rejects orders still waiting to be picked, a second purchase while a label
-- is active or a purchase is in flight. A fulfilled order may buy a label
-- only when it already had one and every label it had is voided.
CREATE OR REPLACE FUNCTION begin_label_purchase(p_order_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_status order_status; v_replacement boolean := false;
BEGIN
  v_status := fo_lock_order(p_order_id);
  IF v_status.status = 'preparing_shipment' THEN
    PERFORM fo_fail('not_picked', 'Pick this order first: assign a staging box on the Pick List.');
  END IF;
  IF v_status.status = 'fulfilled' THEN
    IF EXISTS (SELECT 1 FROM fulfillment_log WHERE shopify_order_id = p_order_id AND voided_at IS NULL) THEN
      PERFORM fo_fail('label_exists', 'This order already has an active label. Void it before buying another.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fulfillment_log WHERE shopify_order_id = p_order_id) THEN
      PERFORM fo_fail('already_fulfilled', 'This order is already fulfilled.');
    END IF;
    v_replacement := true;
  ELSIF fo_has_active_label(p_order_id, v_status.status) THEN
    PERFORM fo_fail('label_exists', 'This order already has an active label. Void it before buying another.');
  END IF;
  IF v_status.label_purchase_started_at IS NOT NULL
     AND v_status.label_purchase_started_at > now() - interval '2 minutes' THEN
    PERFORM fo_fail('purchase_in_progress', 'A label purchase for this order is already in progress.');
  END IF;
  UPDATE order_status SET label_purchase_started_at = now() WHERE shopify_order_id = p_order_id;
  RETURN jsonb_build_object('ok', true, 'replacement', v_replacement);
END $$;

-- Records a bought label. Not fulfilled: status label_generated (as before).
-- Fulfilled (a replacement): the status stays fulfilled; the label row is
-- stamped fulfilled_at like the order's other labels, so it never counts as
-- an unfulfilled active label.
CREATE OR REPLACE FUNCTION complete_label_purchase(p_order_id text, p_log jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_status order_status; v_log_id uuid; v_replacement boolean;
BEGIN
  v_status := fo_lock_order(p_order_id);
  v_replacement := v_status.status = 'fulfilled';
  INSERT INTO fulfillment_log (shopify_order_id, tracking_number, carrier, service, label_url,
                               easypost_shipment_id, rate_amount, rate_currency, tracking_url,
                               is_replacement, notify_customer, fulfilled_at, shopify_fulfillment_id)
  VALUES (p_order_id, p_log->>'tracking_number', p_log->>'carrier', p_log->>'service', p_log->>'label_url',
          p_log->>'easypost_shipment_id', nullif(p_log->>'rate_amount', '')::numeric, p_log->>'rate_currency',
          nullif(p_log->>'tracking_url', ''),
          CASE WHEN v_replacement THEN true END,
          CASE WHEN v_replacement THEN coalesce((p_log->>'notify_customer')::boolean, true) END,
          CASE WHEN v_replacement THEN now() END,
          CASE WHEN v_replacement THEN (SELECT l.shopify_fulfillment_id FROM fulfillment_log l
                                        WHERE l.shopify_order_id = p_order_id AND l.shopify_fulfillment_id IS NOT NULL
                                        ORDER BY l.created_at DESC LIMIT 1) END)
  RETURNING id INTO v_log_id;
  IF v_replacement THEN
    UPDATE order_status SET label_purchase_started_at = NULL WHERE shopify_order_id = p_order_id;
  ELSE
    UPDATE order_status SET status = 'label_generated', label_purchase_started_at = NULL, updated_at = now()
      WHERE shopify_order_id = p_order_id;
  END IF;
  RETURN jsonb_build_object('log_id', v_log_id, 'replacement', v_replacement);
END $$;

-- 4) Print --------------------------------------------------------------------
-- Stamps printed_at on the active label. label_generated becomes
-- label_printed; any other status (including fulfilled) is left alone.
CREATE OR REPLACE FUNCTION mark_label_printed(p_order_id text, p_log_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_status order_status; v_new text;
BEGIN
  v_status := fo_lock_order(p_order_id);
  UPDATE fulfillment_log SET printed_at = coalesce(printed_at, now())
    WHERE id = p_log_id AND shopify_order_id = p_order_id AND voided_at IS NULL;
  IF NOT FOUND THEN PERFORM fo_fail('label_not_found', 'No active label to print.'); END IF;
  v_new := v_status.status;
  IF v_status.status = 'label_generated' THEN
    v_new := 'label_printed';
    UPDATE order_status SET status = v_new, updated_at = now() WHERE shopify_order_id = p_order_id;
  END IF;
  RETURN jsonb_build_object('status', v_new);
END $$;

-- Only the server (service role) may call these.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'begin_label_void(text, uuid)',
    'complete_label_void(text, uuid, jsonb, text)',
    'begin_refund_retry(text, uuid)',
    'begin_label_purchase(text)',
    'complete_label_purchase(text, jsonb)',
    'mark_label_printed(text, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
