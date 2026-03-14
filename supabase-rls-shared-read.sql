-- ============================================================
-- RLS: Shared read for authenticated users
-- Run this in Supabase → SQL Editor
-- Shared: Yield, Microgreens, Calibration, Inventory, Products & BOM
-- Private (unchanged): Production Cycles, Schedule
-- ============================================================

-- Microgreens
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.microgreens;
CREATE POLICY "allow_authenticated_read" ON public.microgreens
  FOR SELECT TO authenticated USING (true);

-- Yield entries
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.yield_entries;
CREATE POLICY "allow_authenticated_read" ON public.yield_entries
  FOR SELECT TO authenticated USING (true);

-- Inventory items
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.inventory_items;
CREATE POLICY "allow_authenticated_read" ON public.inventory_items
  FOR SELECT TO authenticated USING (true);

-- Inventory adjustments
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.inventory_adjustments;
CREATE POLICY "allow_authenticated_read" ON public.inventory_adjustments
  FOR SELECT TO authenticated USING (true);

-- Products
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.products;
CREATE POLICY "allow_authenticated_read" ON public.products
  FOR SELECT TO authenticated USING (true);

-- BOM lines
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.bom_lines;
CREATE POLICY "allow_authenticated_read" ON public.bom_lines
  FOR SELECT TO authenticated USING (true);

-- Product variants
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.product_variants;
CREATE POLICY "allow_authenticated_read" ON public.product_variants
  FOR SELECT TO authenticated USING (true);

-- Freeze dryer machine settings (calibration)
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.freeze_dryer_machine_settings;
CREATE POLICY "allow_authenticated_read" ON public.freeze_dryer_machine_settings
  FOR SELECT TO authenticated USING (true);

-- Freeze dryer profiles
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.freeze_dryer_profiles;
CREATE POLICY "allow_authenticated_read" ON public.freeze_dryer_profiles
  FOR SELECT TO authenticated USING (true);

-- Calibration (if table is named calibration)
DROP POLICY IF EXISTS "allow_authenticated_read" ON public.calibration;
CREATE POLICY "allow_authenticated_read" ON public.calibration
  FOR SELECT TO authenticated USING (true);
