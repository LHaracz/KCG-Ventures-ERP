-- Formulation page: product development, formula iterations, test batches.
-- BotanIQals only (is_microgreen = false) — MiniLeaf is entirely out of
-- scope for this feature. Products & BOM (products/bom_lines) remains the
-- single source of truth every other feature reads from; this subsystem
-- is additive, and Finish Iteration writes into bom_lines rather than
-- replacing it with a parallel source of truth.
--
-- Same RLS convention used throughout this app's recent migrations (see
-- sales_data_variant_mapping.sql, botaniqals_optimization.sql): no
-- per-row ownership column, a single `..._shared_policy` requiring just
-- an authenticated session.
--
-- Run in the Supabase SQL editor.

-- 1) formulation_products: one row per BotanIQals product idea, whether or
--    not it has made it into Products & BOM yet. product_id is null for a
--    product still in development; it's set once the first formulation is
--    finished and the real `products` row is created.
-- draft_* columns hold the would-be `products` fields (same shape as the
-- Products & BOM form) while a product only exists here, not yet in
-- `products`. They're staging only — Finish Iteration copies them onto the
-- real products row it creates (or, for a product that already has one,
-- they're simply unused from then on) and nothing else in the app reads
-- them.
CREATE TABLE IF NOT EXISTS formulation_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'in_development'
    CHECK (status IN ('in_development', 'active')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  draft_unit text,
  draft_sale_price_per_unit numeric,
  draft_shelf_life_days integer,
  draft_target_batch_size numeric,
  draft_target_batch_unit text,
  draft_notes text
);

CREATE INDEX IF NOT EXISTS idx_formulation_products_product_id ON formulation_products(product_id);

ALTER TABLE formulation_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS formulation_products_shared_policy ON formulation_products;
CREATE POLICY formulation_products_shared_policy ON formulation_products
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE formulation_products TO authenticated;

-- 2) formulations: one row per version of a formulation_product's formula.
--    version_number is assigned by the app (next = max+1 for that product);
--    the unique constraint below is the race-safety backstop, not the
--    primary mechanism. At most one 'draft' per product at a time — the
--    partial unique index enforces that, matching "Start New Iteration"
--    being blocked while a draft is already open.
CREATE TABLE IF NOT EXISTS formulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formulation_product_id uuid NOT NULL REFERENCES formulation_products(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'final')),
  source text NOT NULL DEFAULT 'new'
    CHECK (source IN ('new', 'baseline_import', 'restored_from_version')),
  goal_notes text,
  change_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  created_by uuid,
  finalized_by uuid,
  CONSTRAINT formulations_product_version_unique UNIQUE (formulation_product_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_formulations_formulation_product_id ON formulations(formulation_product_id);

-- At most one draft per formulation_product.
CREATE UNIQUE INDEX IF NOT EXISTS idx_formulations_one_draft_per_product
  ON formulations(formulation_product_id)
  WHERE status = 'draft';

ALTER TABLE formulations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS formulations_shared_policy ON formulations;
CREATE POLICY formulations_shared_policy ON formulations
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE formulations TO authenticated;

-- 3) formulation_lines: the formula itself — both raw-ingredient lines and
--    packaging lines, since packaging is part of the formula here, not
--    something added afterward in Products & BOM. Mirrors bom_lines'
--    line_type/qty_per_unit shape (minus the microgreen-only line types,
--    which don't apply to BotanIQals) so Finish Iteration can map a line
--    straight across. raw_material_id always points at inventory_items —
--    that table already holds both raw materials and packaging stock.
CREATE TABLE IF NOT EXISTS formulation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formulation_id uuid NOT NULL REFERENCES formulations(id) ON DELETE CASCADE,
  line_type text NOT NULL DEFAULT 'inventory_item'
    CHECK (line_type IN ('inventory_item', 'packaging')),
  raw_material_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  qty_per_unit numeric NOT NULL,
  reason text,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_formulation_lines_formulation_id ON formulation_lines(formulation_id);
CREATE INDEX IF NOT EXISTS idx_formulation_lines_raw_material_id ON formulation_lines(raw_material_id);

ALTER TABLE formulation_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS formulation_lines_shared_policy ON formulation_lines;
CREATE POLICY formulation_lines_shared_policy ON formulation_lines
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE formulation_lines TO authenticated;

-- 4) test_batches: a log entry per physical test batch made against a
--    specific formulation version.
CREATE TABLE IF NOT EXISTS test_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formulation_id uuid NOT NULL REFERENCES formulations(id) ON DELETE CASCADE,
  batch_date date NOT NULL DEFAULT CURRENT_DATE,
  batch_size text,
  observations text,
  outcome text CHECK (outcome IN ('pass', 'needs_changes', 'fail')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_test_batches_formulation_id ON test_batches(formulation_id);

ALTER TABLE test_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS test_batches_shared_policy ON test_batches;
CREATE POLICY test_batches_shared_policy ON test_batches
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE test_batches TO authenticated;

-- 5) deleted_mapping_components: a reversibility backup taken immediately
--    before a deleted product's components are stripped out of
--    variant_component_map.components (jsonb, no DB-level FK — see that
--    table's own migration). product_id has no FK on purpose: the product
--    row may itself be soft-deleted (or, in principle, gone) by the time
--    anyone needs to look this row up.
CREATE TABLE IF NOT EXISTS deleted_mapping_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  mapping_id uuid NOT NULL REFERENCES variant_component_map(id) ON DELETE CASCADE,
  qty_per_unit numeric NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deleted_mapping_components_product_id ON deleted_mapping_components(product_id);
CREATE INDEX IF NOT EXISTS idx_deleted_mapping_components_mapping_id ON deleted_mapping_components(mapping_id);

ALTER TABLE deleted_mapping_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deleted_mapping_components_shared_policy ON deleted_mapping_components;
CREATE POLICY deleted_mapping_components_shared_policy ON deleted_mapping_components
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deleted_mapping_components TO authenticated;

-- 6) products.deleted_at: soft-delete marker. Nullable, additive — no
--    existing column, constraint, or index on `products` is touched.
--    NULL = active/visible everywhere (the default for every existing
--    row); non-null = archived, hidden from the lists/dropdowns/
--    calculations that were updated to filter on it.
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_products_deleted_at ON products(deleted_at);
