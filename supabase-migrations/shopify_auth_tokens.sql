-- Cache short-lived Shopify API tokens for server-side sync jobs.
CREATE TABLE IF NOT EXISTS shopify_auth_tokens (
  id text PRIMARY KEY,
  access_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopify_auth_tokens_expires_at
  ON shopify_auth_tokens (expires_at);
