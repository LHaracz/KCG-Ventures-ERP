-- Shipping Address Verification & Flagging.
-- Run in the Supabase SQL editor.
--
-- Fulfillments is entirely live (every page load reads straight from
-- Shopify's Admin GraphQL API) with only small local tables for ERP-side
-- state, same as order_status/fulfillment_log
-- (supabase-migrations/fulfillments_status_pipeline.sql). This table
-- follows that exact convention: keyed by shopify_order_id, one current-
-- state row per order (not append-only — unlike fulfillment_log, there's
-- no need for history here, only "the latest check" and "the currently
-- accepted address").

CREATE TABLE IF NOT EXISTS order_address_verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'unchecked'
    CHECK (status IN ('unchecked', 'verified', 'needs_review', 'failed')),
  -- { originalAddress, suggestedAddress, messages: [{code, message, field}] }
  -- from the most recent EasyPost address-verification call.
  address_verification_details jsonb,
  -- App's canonical address shape (name/address1/address2/city/province/
  -- zip/country/phone). Null until an employee accepts a suggested
  -- correction or saves a manual edit; once set, this is the authoritative
  -- address used when buying a shipping label for this order.
  accepted_address jsonb,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_address_verification_shopify_order_id
  ON order_address_verification(shopify_order_id);

ALTER TABLE order_address_verification ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_address_verification_shared_policy ON order_address_verification;
CREATE POLICY order_address_verification_shared_policy ON order_address_verification
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE order_address_verification TO authenticated;
