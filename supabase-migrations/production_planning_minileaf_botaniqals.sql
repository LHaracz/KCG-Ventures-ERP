-- Production Planning: MiniLeaf + BotanIQals
-- Run after is_microgreen_variants_brand.sql
-- Adds business_type, harvest_date, product_variants, demand/schedule support

-- 1. production_cycles: business_type + harvest_date
ALTER TABLE production_cycles ADD COLUMN IF NOT EXISTS business_type text;
UPDATE production_cycles SET business_type = CASE
  WHEN brand = 'minileaf' THEN 'MiniLeaf'
  WHEN brand = 'botaniqals' THEN 'BotanIQals'
  ELSE 'BotanIQals'
END WHERE business_type IS NULL;
ALTER TABLE production_cycles ALTER COLUMN business_type SET DEFAULT 'BotanIQals';
ALTER TABLE production_cycles ALTER COLUMN business_type SET NOT NULL;
ALTER TABLE production_cycles ADD COLUMN IF NOT EXISTS harvest_date date;

-- 2. products: ensure is_microgreen not null (may already exist)
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_microgreen boolean DEFAULT false;
UPDATE products SET is_microgreen = COALESCE(is_microgreen, false) WHERE is_microgreen IS NULL;
ALTER TABLE products ALTER COLUMN is_microgreen SET NOT NULL;

-- 3. bom_lines: line_type, microgreen_id, freeze_dryer_profile_id if missing
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS line_type text;
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS microgreen_id uuid REFERENCES microgreens(id) ON DELETE SET NULL;
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS freeze_dryer_profile_id uuid;

-- 4. product_variants (new table)
CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  size_oz numeric NOT NULL,
  sku text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_variants_user_id ON product_variants(user_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_variants_user_policy ON product_variants;
CREATE POLICY product_variants_user_policy ON product_variants
  FOR ALL USING (auth.uid() = user_id);

-- 5. production_targets: product_variant_id, quantity_to_produce, extra_full_trays
ALTER TABLE production_targets ADD COLUMN IF NOT EXISTS product_variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE production_targets ADD COLUMN IF NOT EXISTS quantity_to_produce numeric;
ALTER TABLE production_targets ADD COLUMN IF NOT EXISTS extra_full_trays numeric;

-- 6. production_plan_lines: business_type, product_variant_id, drain_date
ALTER TABLE production_plan_lines ADD COLUMN IF NOT EXISTS business_type text;
ALTER TABLE production_plan_lines ADD COLUMN IF NOT EXISTS product_variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE production_plan_lines ADD COLUMN IF NOT EXISTS drain_date date;

-- 7. schedule_events (create or alter)
CREATE TABLE IF NOT EXISTS schedule_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  production_cycle_id uuid NOT NULL REFERENCES production_cycles(id) ON DELETE CASCADE,
  business_type text,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  microgreen_id uuid REFERENCES microgreens(id) ON DELETE SET NULL,
  freeze_dryer_profile_id uuid,
  event_type text NOT NULL,
  title text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz,
  quantity numeric,
  quantity_unit text,
  trays numeric,
  run_number integer,
  machine_number integer,
  status text NOT NULL DEFAULT 'planned',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedule_events_user_id ON schedule_events(user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_events_production_cycle_id ON schedule_events(production_cycle_id);
CREATE INDEX IF NOT EXISTS idx_schedule_events_start_at ON schedule_events(start_at);

ALTER TABLE schedule_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schedule_events_user_policy ON schedule_events;
CREATE POLICY schedule_events_user_policy ON schedule_events
  FOR ALL USING (auth.uid() = user_id);

-- Add missing columns to schedule_events if table already existed
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS business_type text;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS product_variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS freeze_dryer_profile_id uuid;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS run_number integer;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS notes text;

-- Optional: check constraints for event_type and status (omit if too strict for existing data)
-- ALTER TABLE schedule_events ADD CONSTRAINT chk_event_type CHECK (event_type IN ('soak','drain','sow','move_to_light','harvest','freeze_dry_start','freeze_dry_end','warning'));
-- ALTER TABLE schedule_events ADD CONSTRAINT chk_status CHECK (status IN ('planned','warning','infeasible'));
