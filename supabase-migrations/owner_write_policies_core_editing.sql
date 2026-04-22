-- Owner-scoped write policies for core editable tables.
-- Use with shared-read policies; this restores safe edit capability.

-- Microgreens
DROP POLICY IF EXISTS "owner_insert_microgreens" ON public.microgreens;
CREATE POLICY "owner_insert_microgreens" ON public.microgreens
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_update_microgreens" ON public.microgreens;
CREATE POLICY "owner_update_microgreens" ON public.microgreens
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_delete_microgreens" ON public.microgreens;
CREATE POLICY "owner_delete_microgreens" ON public.microgreens
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Products
DROP POLICY IF EXISTS "owner_insert_products" ON public.products;
CREATE POLICY "owner_insert_products" ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_update_products" ON public.products;
CREATE POLICY "owner_update_products" ON public.products
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_delete_products" ON public.products;
CREATE POLICY "owner_delete_products" ON public.products
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- BOM lines
DROP POLICY IF EXISTS "owner_insert_bom_lines" ON public.bom_lines;
CREATE POLICY "owner_insert_bom_lines" ON public.bom_lines
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_update_bom_lines" ON public.bom_lines;
CREATE POLICY "owner_update_bom_lines" ON public.bom_lines
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_delete_bom_lines" ON public.bom_lines;
CREATE POLICY "owner_delete_bom_lines" ON public.bom_lines
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Freeze dryer machine settings
DROP POLICY IF EXISTS "owner_insert_freeze_dryer_machine_settings" ON public.freeze_dryer_machine_settings;
CREATE POLICY "owner_insert_freeze_dryer_machine_settings" ON public.freeze_dryer_machine_settings
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_update_freeze_dryer_machine_settings" ON public.freeze_dryer_machine_settings;
CREATE POLICY "owner_update_freeze_dryer_machine_settings" ON public.freeze_dryer_machine_settings
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_delete_freeze_dryer_machine_settings" ON public.freeze_dryer_machine_settings;
CREATE POLICY "owner_delete_freeze_dryer_machine_settings" ON public.freeze_dryer_machine_settings
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Freeze dryer profiles
DROP POLICY IF EXISTS "owner_insert_freeze_dryer_profiles" ON public.freeze_dryer_profiles;
CREATE POLICY "owner_insert_freeze_dryer_profiles" ON public.freeze_dryer_profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_update_freeze_dryer_profiles" ON public.freeze_dryer_profiles;
CREATE POLICY "owner_update_freeze_dryer_profiles" ON public.freeze_dryer_profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_delete_freeze_dryer_profiles" ON public.freeze_dryer_profiles;
CREATE POLICY "owner_delete_freeze_dryer_profiles" ON public.freeze_dryer_profiles
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
