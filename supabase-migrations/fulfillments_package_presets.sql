-- Fulfillments Part 1: package presets used to compute parcel weight before
-- label purchase (label purchase itself is Part 2).
-- Run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS package_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname text NOT NULL,
  length_in numeric NOT NULL,
  width_in numeric NOT NULL,
  height_in numeric NOT NULL,
  tare_weight_oz numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_package_presets_user_id ON package_presets(user_id);

ALTER TABLE package_presets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS package_presets_user_policy ON package_presets;
CREATE POLICY package_presets_user_policy ON package_presets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE package_presets TO authenticated;
