-- BotanIQals batch traceability
-- Creates a master batch table (1 row per finished product per production cycle)

-- 1) Sequence for 6-digit batch IDs
CREATE SEQUENCE IF NOT EXISTS public.botaniqals_batch_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1;

-- 2) Master table
CREATE TABLE IF NOT EXISTS public.botaniqals_production_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  production_cycle_id uuid NOT NULL REFERENCES public.production_cycles(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,

  batch_number bigint NOT NULL DEFAULT nextval('public.botaniqals_batch_seq'),
  batch_id text GENERATED ALWAYS AS (lpad(batch_number::text, 6, '0')) STORED,

  quantity_produced numeric NOT NULL DEFAULT 0,
  production_start_at timestamptz,
  production_end_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT botaniqals_batches_unique_per_cycle UNIQUE (production_cycle_id, product_id, product_variant_id),
  CONSTRAINT botaniqals_batches_batch_number_unique UNIQUE (batch_number),
  CONSTRAINT botaniqals_batches_batch_id_unique UNIQUE (batch_id)
);

CREATE INDEX IF NOT EXISTS idx_botaniqals_batches_user_id ON public.botaniqals_production_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_botaniqals_batches_cycle_id ON public.botaniqals_production_batches(production_cycle_id);
CREATE INDEX IF NOT EXISTS idx_botaniqals_batches_product_id ON public.botaniqals_production_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_botaniqals_batches_completed_at ON public.botaniqals_production_batches(completed_at);

-- 3) Keep updated_at current
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_botaniqals_batches_set_updated_at ON public.botaniqals_production_batches;
CREATE TRIGGER trg_botaniqals_batches_set_updated_at
BEFORE UPDATE ON public.botaniqals_production_batches
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- 4) RLS: batches are private to user (same as cycles/targets)
ALTER TABLE public.botaniqals_production_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS botaniqals_batches_user_policy ON public.botaniqals_production_batches;
CREATE POLICY botaniqals_batches_user_policy ON public.botaniqals_production_batches
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 5) Grants (required for inserts that use nextval on the sequence)
GRANT USAGE, SELECT ON SEQUENCE public.botaniqals_batch_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.botaniqals_production_batches TO authenticated;

