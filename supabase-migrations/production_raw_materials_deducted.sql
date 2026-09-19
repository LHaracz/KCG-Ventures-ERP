-- "Mark as Produced" support: let raw materials be deducted from inventory before
-- a BotanIQals cycle is fully completed/packed.
-- Run in the Supabase SQL editor.

-- 1) production_cycles: single source of truth for "has this cycle's raw
--    materials already been pulled from inventory". NULL = not yet deducted.
ALTER TABLE production_cycles
  ADD COLUMN IF NOT EXISTS raw_materials_deducted_at timestamptz;

-- 2) inventory_adjustments: link each adjustment back to the cycle that caused
--    it, so a deduction can be reliably found and reversed (undo). Existing rows
--    keep NULL here and still carry their human-readable note text.
ALTER TABLE inventory_adjustments
  ADD COLUMN IF NOT EXISTS production_cycle_id uuid
  REFERENCES production_cycles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_production_cycle_id
  ON inventory_adjustments(production_cycle_id);
