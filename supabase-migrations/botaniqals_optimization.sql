-- BotanIQals Optimization page: demand calibration settings + run history.
-- BotanIQals products are identified by products.is_microgreen = false (no
-- separate business column on products, same convention used everywhere
-- else this session). MiniLeaf is entirely out of scope for this feature.
-- Run in the Supabase SQL editor.

-- Singleton row of global optimization defaults, same fixed-id-upsert
-- pattern as notification_config / fulfillments_settings.
CREATE TABLE IF NOT EXISTS demand_calibration_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trailing_window_days integer NOT NULL DEFAULT 30,
  safety_stock_qty numeric NOT NULL DEFAULT 0,
  min_buffer_qty numeric NOT NULL DEFAULT 0,
  lead_time_days numeric NOT NULL DEFAULT 0,
  default_objective text NOT NULL DEFAULT 'maximize_revenue'
    CHECK (default_objective IN (
      'maximize_revenue',
      'maximize_profit',
      'minimize_unmet_demand',
      'maximize_equitable_fill_rate'
    )),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO demand_calibration_settings (id)
VALUES ('e0000000-0000-0000-0000-000000000001'::uuid)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE demand_calibration_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demand_calibration_settings_shared_policy ON demand_calibration_settings;
CREATE POLICY demand_calibration_settings_shared_policy ON demand_calibration_settings
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON TABLE demand_calibration_settings TO authenticated;

-- Per-product overrides of the global defaults above. Any field left null
-- means "use the global default" for that product. A product with no row
-- here simply uses the global defaults for everything.
CREATE TABLE IF NOT EXISTS demand_calibration_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  trailing_window_days integer,
  safety_stock_qty numeric,
  min_buffer_qty numeric,
  lead_time_days numeric
);

ALTER TABLE demand_calibration_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demand_calibration_overrides_shared_policy ON demand_calibration_overrides;
CREATE POLICY demand_calibration_overrides_shared_policy ON demand_calibration_overrides
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE demand_calibration_overrides TO authenticated;

-- One row per optimization run, so past results can be reviewed without
-- re-running the calculation.
CREATE TABLE IF NOT EXISTS optimization_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  objective text NOT NULL CHECK (objective IN (
    'maximize_revenue',
    'maximize_profit',
    'minimize_unmet_demand',
    'maximize_equitable_fill_rate'
  )),
  settings_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_optimization_runs_run_at ON optimization_runs(run_at DESC);

ALTER TABLE optimization_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS optimization_runs_shared_policy ON optimization_runs;
CREATE POLICY optimization_runs_shared_policy ON optimization_runs
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT ON TABLE optimization_runs TO authenticated;
