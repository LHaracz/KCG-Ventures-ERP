-- Allow inventory_item to be null for raw_microgreen and dried_microgreen BOM lines
-- (those lines reference microgreens, not inventory items)
ALTER TABLE bom_lines ALTER COLUMN inventory_item DROP NOT NULL;
