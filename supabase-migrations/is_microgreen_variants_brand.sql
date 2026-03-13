-- Is Microgreen + Variants + Brand support
-- Run after bom_lines_nullable_inventory_item.sql if not yet applied

-- 1. Products: add is_microgreen (microgreen products use BOM variants for size/price)
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_microgreen boolean DEFAULT false;

-- 2. Make sale_price_per_unit nullable (is_microgreen products don't have product-level price)
ALTER TABLE products ALTER COLUMN sale_price_per_unit DROP NOT NULL;

-- 3. BOM lines: add sale_price for variant pricing (when product is is_microgreen and line is raw_microgreen)
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS sale_price numeric;

-- 4. Production cycles: add brand (minileaf = fresh variants, botaniqals = dried products)
ALTER TABLE production_cycles ADD COLUMN IF NOT EXISTS brand text DEFAULT 'botaniqals';
-- Valid: 'minileaf' | 'botaniqals'

-- 5. Production targets: add bom_line for variant targets (MiniLeaf mode)
ALTER TABLE production_targets ADD COLUMN IF NOT EXISTS bom_line uuid REFERENCES bom_lines(id) ON DELETE CASCADE;
