-- Run this in Supabase Dashboard: SQL Editor > New query > paste and Run
-- 1. Product variants: add sale_price and unit_cost
-- 2. Schedule events: ensure production_cycle_id and user_id exist for schedule page

-- ========== PRODUCT_VARIANTS ==========
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS sale_price numeric;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS unit_cost numeric;

-- ========== SCHEDULE_EVENTS (ensure table and columns exist) ==========
-- If schedule_events doesn't exist, create it
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

-- Add columns if table already existed with different schema
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS production_cycle_id uuid REFERENCES production_cycles(id) ON DELETE CASCADE;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS business_type text;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS product_variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS microgreen_id uuid REFERENCES microgreens(id) ON DELETE SET NULL;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS freeze_dryer_profile_id uuid;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS start_at timestamptz;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS end_at timestamptz;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS quantity numeric;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS quantity_unit text;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS trays numeric;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS run_number integer;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS machine_number integer;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Backfill production_cycle_id from production_cycle if old column name was used
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schedule_events' AND column_name = 'production_cycle'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schedule_events' AND column_name = 'production_cycle_id'
  ) THEN
    UPDATE schedule_events SET production_cycle_id = production_cycle WHERE production_cycle_id IS NULL AND production_cycle IS NOT NULL;
  END IF;
END $$;

-- Indexes and RLS
CREATE INDEX IF NOT EXISTS idx_schedule_events_user_id ON schedule_events(user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_events_production_cycle_id ON schedule_events(production_cycle_id);
CREATE INDEX IF NOT EXISTS idx_schedule_events_start_at ON schedule_events(start_at);

ALTER TABLE schedule_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schedule_events_user_policy ON schedule_events;
CREATE POLICY schedule_events_user_policy ON schedule_events
  FOR ALL USING (auth.uid() = user_id);
