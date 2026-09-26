-- Records each line item's position within its order (Shopify's own line
-- item order), so the Sales Data page can stack an order's line items in a
-- stable, meaningful order. Populated going forward by src/lib/salesImport.ts;
-- existing rows default to 0 until their order is re-imported (import
-- deletes+reinserts each order's line items, so a re-import backfills this).

ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_order_line_items_order_position ON order_line_items(order_id, position);
