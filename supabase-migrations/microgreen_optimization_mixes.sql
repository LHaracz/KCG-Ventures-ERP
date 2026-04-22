-- Microgreen optimization mix definitions
-- Adds mix header + component tables for 2oz MiniLeaf blends.

CREATE TABLE IF NOT EXISTS microgreen_mixes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  unit_size_oz numeric NOT NULL DEFAULT 2,
  sale_price numeric NOT NULL DEFAULT 8,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS microgreen_mix_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mix_id uuid NOT NULL REFERENCES microgreen_mixes(id) ON DELETE CASCADE,
  microgreen_id uuid NOT NULL REFERENCES microgreens(id) ON DELETE CASCADE,
  ratio numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT microgreen_mix_components_ratio_positive CHECK (ratio > 0 AND ratio <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_microgreen_mixes_user_name
  ON microgreen_mixes(user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_microgreen_mix_components_mix_id
  ON microgreen_mix_components(mix_id);
CREATE INDEX IF NOT EXISTS idx_microgreen_mix_components_microgreen_id
  ON microgreen_mix_components(microgreen_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_microgreen_mix_components_mix_microgreen
  ON microgreen_mix_components(mix_id, microgreen_id);

ALTER TABLE microgreen_mixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE microgreen_mix_components ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS microgreen_mixes_user_policy ON microgreen_mixes;
CREATE POLICY microgreen_mixes_user_policy ON microgreen_mixes
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS microgreen_mix_components_user_policy ON microgreen_mix_components;
CREATE POLICY microgreen_mix_components_user_policy ON microgreen_mix_components
  FOR ALL USING (auth.uid() = user_id);
