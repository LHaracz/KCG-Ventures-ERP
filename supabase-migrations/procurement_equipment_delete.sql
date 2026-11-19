-- Procurement: permanently delete an equipment item, and the suppliers that
-- were used only for it.
-- Run in the Supabase SQL editor BEFORE deploying the code that uses it, and
-- after procurement_suppliers.sql and procurement_equipment_prices.sql.
--
-- Safety rules this file follows:
--  - Additive only: one new table (procurement_delete_log) and one new
--    function (delete_equipment_item). No existing table, column, trigger,
--    function or policy is changed.
--  - The "never deleted" triggers on equipment_items, equipment_suppliers
--    and suppliers stay in place for everything else. delete_equipment_item
--    switches only those three off inside its own transaction and switches
--    them back on before it returns; if anything fails, the whole transaction
--    (including the trigger switch) rolls back.
--  - It deletes one equipment item, its supplier listings, and suppliers that
--    were confirmed in the dialog and have no other listing of any kind
--    (raw material or equipment, archived or not). Nothing else: raw
--    materials, raw material listings, Purchase Orders and every other table
--    are never touched.
--  - Safe to run more than once.

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regclass('public.equipment_items') is null or to_regclass('public.equipment_suppliers') is null
     or to_regclass('public.suppliers') is null or to_regclass('public.raw_material_suppliers') is null then
    raise exception 'Run procurement_suppliers.sql and procurement_equipment_prices.sql first.';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Run the employee access migrations first (is_admin() is missing).';
  end if;
end $$;

-- 1) The log --------------------------------------------------------------------
create table if not exists procurement_delete_log (
  id uuid primary key default gen_random_uuid(),
  deleted_at timestamptz not null default now(),
  deleted_by_name text,
  equipment_name text not null,
  deleted_supplier_names text[] not null default '{}',
  kept_supplier_names text[] not null default '{}',
  constraint pdl_deleted_by_name_len check (deleted_by_name is null or char_length(deleted_by_name) <= 200)
);
alter table procurement_delete_log enable row level security;
drop policy if exists procurement_delete_log_select_admin on procurement_delete_log;
create policy procurement_delete_log_select_admin on procurement_delete_log
  for select to authenticated using (is_admin());
revoke all on procurement_delete_log from public, anon, authenticated;
grant select on procurement_delete_log to authenticated;
grant all on procurement_delete_log to service_role;

-- 2) delete_equipment_item --------------------------------------------------------
-- p_expected_supplier_ids: the suppliers the dialog showed as "will also be
-- deleted". A supplier outside that list is always kept.
create or replace function delete_equipment_item(p_equipment_id uuid, p_expected_supplier_ids uuid[], p_actor_name text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_ids uuid[];
  v_sup record;
  v_reason text;
  v_deleted jsonb := '[]'::jsonb;
  v_kept jsonb := '[]'::jsonb;
  v_deleted_names text[] := '{}';
  v_kept_names text[] := '{}';
begin
  if not coalesce(is_admin(), false) then
    raise exception 'Only an Admin can delete equipment.' using errcode = '42501';
  end if;

  select e.name into v_name from equipment_items e where e.id = p_equipment_id for update;
  if not found then
    raise exception 'Equipment not found' using errcode = 'P0002';
  end if;

  -- Every supplier with a listing on this item (archived listings too), locked in id order.
  select coalesce(array_agg(distinct es.supplier_id order by es.supplier_id), '{}') into v_ids
  from equipment_suppliers es where es.equipment_id = p_equipment_id;
  perform 1 from suppliers s where s.id = any(v_ids) order by s.id for update;

  alter table equipment_suppliers disable trigger es_no_delete;
  alter table equipment_items disable trigger equipment_items_no_delete;
  delete from equipment_suppliers where equipment_id = p_equipment_id;
  delete from equipment_items where id = p_equipment_id;
  alter table equipment_suppliers enable trigger es_no_delete;
  alter table equipment_items enable trigger equipment_items_no_delete;

  alter table suppliers disable trigger suppliers_no_delete;
  for v_sup in select s.id, s.name from suppliers s where s.id = any(v_ids) order by s.id loop
    v_reason := null;
    if not (v_sup.id = any(coalesce(p_expected_supplier_ids, '{}'))) then
      v_reason := 'not in the confirmed list';
    elsif exists (select 1 from raw_material_suppliers r where r.supplier_id = v_sup.id)
       or exists (select 1 from equipment_suppliers es where es.supplier_id = v_sup.id) then
      v_reason := 'used for other ingredients or equipment';
    else
      begin
        delete from suppliers where id = v_sup.id;
      exception when foreign_key_violation then
        v_reason := 'referenced elsewhere';
      end;
    end if;
    if v_reason is null then
      v_deleted := v_deleted || jsonb_build_object('id', v_sup.id, 'name', v_sup.name);
      v_deleted_names := v_deleted_names || v_sup.name;
    else
      v_kept := v_kept || jsonb_build_object('id', v_sup.id, 'name', v_sup.name, 'reason', v_reason);
      v_kept_names := v_kept_names || v_sup.name;
    end if;
  end loop;
  alter table suppliers enable trigger suppliers_no_delete;

  insert into procurement_delete_log (deleted_by_name, equipment_name, deleted_supplier_names, kept_supplier_names)
  values (nullif(btrim(coalesce(p_actor_name, '')), ''), v_name, v_deleted_names, v_kept_names);

  return jsonb_build_object('equipment_name', v_name, 'deleted_suppliers', v_deleted, 'kept_suppliers', v_kept);
end $$;

revoke all on function delete_equipment_item(uuid, uuid[], text) from public, anon, service_role;
grant execute on function delete_equipment_item(uuid, uuid[], text) to authenticated;
