-- Allow inventory_logs when ERP qty is overwritten from Shopify (orders/create pull).
ALTER TABLE inventory_logs DROP CONSTRAINT IF EXISTS inventory_logs_reason_check;

ALTER TABLE inventory_logs
  ADD CONSTRAINT inventory_logs_reason_check
  CHECK (reason IN ('production', 'order', 'shopify_override'));
