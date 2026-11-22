-- Receiving Log: modes by COA policy, a supplier dropdown with Amazon pinned,
-- and the COA policy lookups the receiving form and the release check need.
--
-- Run once in the Supabase SQL editor BEFORE pushing the code. Safe to run
-- more than once. Additive except the NOT NULL relaxations on
-- receiving_details (a simple receipt has no lot number, packaging,
-- identity or COA answer). Existing rows are not changed: their entry_mode
-- stays null and they keep showing as full receipts.
--
-- 1) suppliers.is_pinned, and Amazon (inserted if missing) pinned.
-- 2) receiving_details: supplier_id, entry_mode, coa_policy_at_receipt;
--    supplier_lot_number, packaging_intact, identity_verified and
--    coa_received become optional.
-- 3) list_suppliers_for_receiving, coa_policy_for and
--    coa_policies_for_release: SECURITY DEFINER, feature-checked, return
--    only ids, names, the pinned flag and COA policies.
-- 4) submit_receiving_entry: accepts the simple payload, re-derives the
--    mode from the database and rejects a payload that doesn't match it.
-- Row level security and policies are unchanged.

begin;

do $$
begin
  if to_regclass('public.receiving_details') is null or to_regclass('public.suppliers') is null
     or to_regclass('public.raw_material_suppliers') is null then
    raise exception 'Run compliance_logs_receiving.sql and procurement_suppliers.sql first.';
  end if;
end $$;

-- 1) Pinned suppliers ------------------------------------------------------------------------------
alter table suppliers add column if not exists is_pinned boolean not null default false;

do $$
begin
  if exists (select 1 from suppliers where lower(btrim(name)) = 'amazon') then
    update suppliers set is_pinned = true where lower(btrim(name)) = 'amazon' and not is_pinned;
  else
    insert into suppliers (name, website_url, is_pinned) values ('Amazon', 'https://www.amazon.com', true);
  end if;
end $$;

-- 2) receiving_details ------------------------------------------------------------------------------
alter table receiving_details add column if not exists supplier_id uuid references suppliers(id) on delete restrict;
alter table receiving_details add column if not exists entry_mode text;
alter table receiving_details add column if not exists coa_policy_at_receipt text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'receiving_details_entry_mode_ok') then
    alter table receiving_details add constraint receiving_details_entry_mode_ok check (entry_mode is null or entry_mode in ('full', 'simple'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'receiving_details_coa_policy_ok') then
    alter table receiving_details add constraint receiving_details_coa_policy_ok
      check (coa_policy_at_receipt is null or coa_policy_at_receipt in ('included', 'request', 'not_available', 'unknown'));
  end if;
end $$;
create index if not exists idx_receiving_details_supplier_id on receiving_details(supplier_id);

alter table receiving_details alter column supplier_lot_number drop not null;
alter table receiving_details alter column packaging_intact drop not null;
alter table receiving_details alter column identity_verified drop not null;
alter table receiving_details alter column coa_received drop not null;

-- 3) Lookups -----------------------------------------------------------------------------------------
-- Suppliers for the receiving dropdown: id, name and the pinned flag only
-- (never contacts, notes or payment fields), plus whether the supplier has
-- an active listing for the given raw material.
create or replace function public.list_suppliers_for_receiving(p_raw_material_id uuid default null)
returns table (id uuid, name text, is_pinned boolean, listed_for boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not (is_active_employee() and has_any_feature(array['compliance.logs', 'inventory.raw_materials'])) then
    raise exception 'You do not have access to the Receiving Log.' using errcode = '42501';
  end if;
  return query
    select s.id, s.name, s.is_pinned,
      (p_raw_material_id is not null and exists (
        select 1 from raw_material_suppliers r
        where r.supplier_id = s.id and r.raw_material_id = p_raw_material_id and r.archived_at is null
      )) as listed_for
    from suppliers s
    where s.archived_at is null
    order by s.is_pinned desc, lower(s.name);
end;
$$;

-- The COA policy of the active listing for a raw material and supplier, or null.
create or replace function public.coa_policy_for(p_raw_material_id uuid, p_supplier_id uuid)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  if not (is_active_employee() and has_any_feature(array['compliance.logs', 'inventory.raw_materials'])) then
    raise exception 'You do not have access to the Receiving Log.' using errcode = '42501';
  end if;
  select r.coa_policy into v from raw_material_suppliers r
  where r.raw_material_id = p_raw_material_id and r.supplier_id = p_supplier_id and r.archived_at is null;
  return v;
end;
$$;

-- For the Complete Production check: one row per requested raw material
-- with the COA policy of its preferred active listing (null when it has
-- none). Nothing else is returned.
create or replace function public.coa_policies_for_release(p_raw_material_ids uuid[])
returns table (raw_material_id uuid, coa_policy text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not (is_active_employee() and has_any_feature(array['production.planner', 'compliance.logs', 'inventory.raw_materials'])) then
    raise exception 'You do not have access to the release check.' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_raw_material_ids), 0) > 200 then
    raise exception 'Ask for at most 200 raw materials at a time.' using errcode = '22023';
  end if;
  return query
    select ids.id, (
      select r.coa_policy from raw_material_suppliers r
      where r.raw_material_id = ids.id and r.is_preferred and r.archived_at is null
      limit 1
    )
    from (select distinct unnest(coalesce(p_raw_material_ids, '{}'::uuid[])) as id) ids;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['list_suppliers_for_receiving(uuid)', 'coa_policy_for(uuid, uuid)', 'coa_policies_for_release(uuid[])'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- 4) Submit (one transaction with the inventory increase) --------------------------------------------
-- The mode is derived here, never trusted from the client:
--   a correction keeps the original entry's mode (null = full);
--   otherwise forced_full or a listing policy of 'included'/'request' = full;
--   'not_available', 'unknown' or no listing = simple.
-- The payload's entry_mode and fields must match the derived mode.
create or replace function public.submit_receiving_entry(payload jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_log_type_id uuid := (payload->>'log_type_id')::uuid;
  v_raw_material_id uuid := (payload->>'raw_material_id')::uuid;
  v_created_new_material boolean := false;
  v_new_material jsonb := payload->'new_raw_material';
  v_entry_id uuid;
  v_corrects_entry_id uuid := (payload->>'corrects_entry_id')::uuid;
  v_lot_id text;
  v_quantity_added numeric := (payload->>'quantity_added')::numeric;
  v_original_quantity_added numeric := (payload->>'original_quantity_added')::numeric;
  v_delta numeric;
  v_adjustment_type text;
  v_note text;
  v_file jsonb;
  v_seq int;
  v_supplier_id uuid := nullif(payload->>'supplier_id', '')::uuid;
  v_supplier_name text;
  v_policy text;
  v_mode text;
  v_claimed_mode text := coalesce(payload->>'entry_mode', 'full');
  v_original receiving_details%rowtype;
begin
  if v_quantity_added is null or v_quantity_added <= 0 then
    raise exception 'Quantity received must be greater than 0.';
  end if;

  if v_corrects_entry_id is not null then
    select * into v_original from receiving_details where log_entry_id = v_corrects_entry_id;
    if not found then
      raise exception 'The entry being corrected was not found.';
    end if;
    -- A correction is the same physical shipment: material and supplier come from the original.
    v_raw_material_id := v_original.raw_material_id;
    v_new_material := null;
    v_supplier_id := v_original.supplier_id;
    v_supplier_name := v_original.supplier;
    v_mode := coalesce(v_original.entry_mode, 'full');
    v_policy := v_original.coa_policy_at_receipt;
  else
    if v_supplier_id is null then
      raise exception 'Choose a supplier.';
    end if;
    select s.name into v_supplier_name from suppliers s where s.id = v_supplier_id and s.archived_at is null;
    if v_supplier_name is null then
      raise exception 'Choose a supplier from the list.';
    end if;
    if v_raw_material_id is not null then
      select r.coa_policy into v_policy from raw_material_suppliers r
      where r.raw_material_id = v_raw_material_id and r.supplier_id = v_supplier_id and r.archived_at is null;
    end if;
    if coalesce((payload->>'forced_full')::boolean, false) or v_policy in ('included', 'request') then
      v_mode := 'full';
    else
      v_mode := 'simple';
    end if;
  end if;

  if v_claimed_mode <> v_mode then
    raise exception 'The form is out of date for this supplier and raw material (expected the % form). Reload and try again.', v_mode;
  end if;

  if v_mode = 'full' then
    if v_corrects_entry_id is null and nullif(btrim(payload->>'supplier_lot_number'), '') is null then
      raise exception 'Supplier lot number is required.';
    end if;
    if payload->>'packaging_intact' is null or payload->>'identity_verified' is null or payload->>'coa_received' is null then
      raise exception 'Packaging intact, identity verified, and COA received must each be answered.';
    end if;
  else
    if nullif(btrim(payload->>'supplier_lot_number'), '') is not null
       or payload->>'packaging_intact' is not null or payload->>'identity_verified' is not null
       or payload->>'coa_received' is not null or payload->>'quantity_received_grams' is not null
       or (jsonb_typeof(payload->'files') = 'array' and jsonb_array_length(payload->'files') > 0) then
      raise exception 'A simple receipt has no lot number, grams, packaging, identity, COA or documents.';
    end if;
  end if;

  if v_raw_material_id is null and v_new_material is not null then
    insert into inventory_items (name, unit, cost_per_unit, par_level, quantity_on_hand, last_count_date, user_id)
    values (
      v_new_material->>'name',
      v_new_material->>'unit',
      coalesce((v_new_material->>'cost_per_unit')::numeric, 0),
      case when v_new_material->>'par_level' is null or v_new_material->>'par_level' = ''
        then null else (v_new_material->>'par_level')::numeric end,
      0,
      null,
      (payload->>'created_by_account')::uuid
    )
    returning id into v_raw_material_id;
    v_created_new_material := true;
  end if;

  if v_raw_material_id is null then
    raise exception 'A raw material is required.';
  end if;

  insert into log_entries (
    log_type_id, performed_at, performed_by_employee_id, performed_by_name,
    values, template_snapshot, is_out_of_spec, out_of_spec_details, corrective_action,
    corrects_entry_id, correction_reason, created_by_account
  ) values (
    v_log_type_id,
    (payload->>'performed_at')::timestamptz,
    (payload->>'performed_by_employee_id')::uuid,
    payload->>'performed_by_name',
    coalesce(payload->'values', '{}'::jsonb) || jsonb_build_object('supplier', v_supplier_name),
    coalesce(payload->'template_snapshot', '{}'::jsonb),
    false,
    null,
    null,
    v_corrects_entry_id,
    payload->>'correction_reason',
    (payload->>'created_by_account')::uuid
  )
  returning id into v_entry_id;

  if v_corrects_entry_id is not null then
    v_lot_id := v_original.internal_lot_id;
  end if;

  if v_lot_id is null then
    perform pg_advisory_xact_lock(hashtext('receiving_lot_id_' || to_char(now(), 'YYYYMMDD')));
    select coalesce(max(substring(internal_lot_id from '-(\d+)$')::int), 0) + 1 into v_seq
    from receiving_details
    where internal_lot_id like 'RM-' || to_char(now(), 'YYYYMMDD') || '-%';
    v_lot_id := 'RM-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');
  end if;

  insert into receiving_details (
    log_entry_id, raw_material_id, supplier, supplier_lot_number, internal_lot_id,
    quantity_received_grams, quantity_added_in_material_unit, material_unit_at_receipt,
    expiration_date, po_or_invoice_number, packaging_intact, identity_verified,
    coa_received, notes, created_new_raw_material, supplier_id, entry_mode, coa_policy_at_receipt
  ) values (
    v_entry_id, v_raw_material_id, v_supplier_name,
    case when v_corrects_entry_id is not null then v_original.supplier_lot_number
      else nullif(btrim(payload->>'supplier_lot_number'), '') end,
    v_lot_id,
    case when payload->>'quantity_received_grams' is null then null else (payload->>'quantity_received_grams')::numeric end,
    v_quantity_added,
    payload->>'material_unit_at_receipt',
    case when payload->>'expiration_date' is null or payload->>'expiration_date' = '' then null else (payload->>'expiration_date')::date end,
    payload->>'po_or_invoice_number',
    (payload->>'packaging_intact')::boolean,
    (payload->>'identity_verified')::boolean,
    (payload->>'coa_received')::boolean,
    payload->>'notes',
    v_created_new_material,
    v_supplier_id,
    -- Old receipts (null mode) keep null on their corrections too.
    case when v_corrects_entry_id is not null then v_original.entry_mode else v_mode end,
    v_policy
  );

  if jsonb_typeof(payload->'files') = 'array' then
    for v_file in select * from jsonb_array_elements(payload->'files')
    loop
      insert into log_entry_files (
        log_entry_id, file_path, original_filename, file_size_bytes, document_type, label,
        added_by_name, added_after_submit
      ) values (
        v_entry_id,
        v_file->>'path',
        v_file->>'original_filename',
        (v_file->>'file_size_bytes')::bigint,
        v_file->>'document_type',
        v_file->>'label',
        payload->>'performed_by_name',
        false
      );
    end loop;
  end if;

  if v_corrects_entry_id is not null then
    v_delta := v_quantity_added - coalesce(v_original_quantity_added, v_original.quantity_added_in_material_unit, 0);
    v_adjustment_type := 'receiving_log_correction';
    v_note := 'Receiving correction, entry ' || v_entry_id::text || ' (lot ' || v_lot_id || ')';
  else
    v_delta := v_quantity_added;
    v_adjustment_type := 'receiving_log';
    v_note := 'Received ' || v_quantity_added::text || ' ' || (payload->>'material_unit_at_receipt') ||
      ' (lot ' || v_lot_id || ', supplier ' || coalesce(v_supplier_name, '') || ')';
  end if;

  insert into inventory_adjustments (inventory_item, adjustment_type, quantity_delta, note, created_at, user_id, log_entry_id)
  values (v_raw_material_id, v_adjustment_type, v_delta, v_note, now(), (payload->>'created_by_account')::uuid, v_entry_id);

  update inventory_items
  set quantity_on_hand = quantity_on_hand + v_delta
  where id = v_raw_material_id;

  return jsonb_build_object(
    'entryId', v_entry_id,
    'rawMaterialId', v_raw_material_id,
    'internalLotId', v_lot_id,
    'createdNewRawMaterial', v_created_new_material,
    'entryMode', v_mode
  );
end;
$$;

grant execute on function public.submit_receiving_entry(jsonb) to authenticated, service_role;

commit;
