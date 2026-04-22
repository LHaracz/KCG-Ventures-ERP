-- Shared reference-data write policies across authenticated accounts.
-- Run this after any owner-scoped policy migrations when using a shared-data model.

-- Remove owner-scoped policies if present
drop policy if exists "owner_insert_microgreens" on public.microgreens;
drop policy if exists "owner_update_microgreens" on public.microgreens;
drop policy if exists "owner_delete_microgreens" on public.microgreens;

drop policy if exists "owner_insert_products" on public.products;
drop policy if exists "owner_update_products" on public.products;
drop policy if exists "owner_delete_products" on public.products;

drop policy if exists "owner_insert_bom_lines" on public.bom_lines;
drop policy if exists "owner_update_bom_lines" on public.bom_lines;
drop policy if exists "owner_delete_bom_lines" on public.bom_lines;

drop policy if exists "owner_insert_freeze_dryer_machine_settings" on public.freeze_dryer_machine_settings;
drop policy if exists "owner_update_freeze_dryer_machine_settings" on public.freeze_dryer_machine_settings;
drop policy if exists "owner_delete_freeze_dryer_machine_settings" on public.freeze_dryer_machine_settings;

drop policy if exists "owner_insert_freeze_dryer_profiles" on public.freeze_dryer_profiles;
drop policy if exists "owner_update_freeze_dryer_profiles" on public.freeze_dryer_profiles;
drop policy if exists "owner_delete_freeze_dryer_profiles" on public.freeze_dryer_profiles;

-- Shared write access for authenticated users
drop policy if exists "allow_authenticated_write" on public.microgreens;
create policy "allow_authenticated_write" on public.microgreens
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists "allow_authenticated_write" on public.products;
create policy "allow_authenticated_write" on public.products
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists "allow_authenticated_write" on public.bom_lines;
create policy "allow_authenticated_write" on public.bom_lines
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists "allow_authenticated_write" on public.freeze_dryer_machine_settings;
create policy "allow_authenticated_write" on public.freeze_dryer_machine_settings
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists "allow_authenticated_write" on public.freeze_dryer_profiles;
create policy "allow_authenticated_write" on public.freeze_dryer_profiles
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists "allow_authenticated_write" on public.inventory_items;
create policy "allow_authenticated_write" on public.inventory_items
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists "allow_authenticated_write" on public.inventory_adjustments;
create policy "allow_authenticated_write" on public.inventory_adjustments
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists "allow_authenticated_write" on public.product_variants;
create policy "allow_authenticated_write" on public.product_variants
  for all to authenticated
  using (true)
  with check (true);
