-- Manual Order Flagging (replaces the automatic EasyPost address-
-- verification flow from order_address_verification.sql — that table is
-- left in place but no longer used by the app; see the app's own removal
-- of order_address_verification references).
-- Run in the Supabase SQL editor.
--
-- Flagging is an overlay on top of the existing order_status progression
-- (preparing_shipment / label_generated / label_printed / fulfilled), not
-- a replacement of it — an order keeps its underlying status while
-- flagged, and simply resumes showing that status once unflagged. It lives
-- on order_status because that's already the one-row-per-shopify_order_id
-- table for order-level ERP state, already read/written directly from the
-- client (see handlePrintLabel in src/app/fulfillments/[orderId]/page.tsx)
-- under the existing shared RLS policy — no new table, no new policy.

ALTER TABLE order_status ADD COLUMN IF NOT EXISTS is_flagged boolean NOT NULL DEFAULT false;
ALTER TABLE order_status ADD COLUMN IF NOT EXISTS flagged_reason text;
ALTER TABLE order_status ADD COLUMN IF NOT EXISTS flagged_at timestamptz;
ALTER TABLE order_status ADD COLUMN IF NOT EXISTS flagged_by text;

-- Belt-and-suspenders alongside the app's own required-reason validation.
ALTER TABLE order_status DROP CONSTRAINT IF EXISTS order_status_flag_reason_required;
ALTER TABLE order_status ADD CONSTRAINT order_status_flag_reason_required
  CHECK (NOT is_flagged OR flagged_reason IS NOT NULL);
