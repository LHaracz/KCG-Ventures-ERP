-- Compliance Logs: receiving log + document attachments (Phase 2).
-- Run compliance_logs_core.sql first. Run in the Supabase SQL editor.
--
-- Safety rules this file exists to satisfy:
--  - No changes to existing tables except adding NULLABLE columns
--    (inventory_adjustments.log_entry_id below).
--  - Raw material inventory increases go through the exact same table
--    (inventory_adjustments) and column (inventory_items.quantity_on_hand)
--    the Raw Materials page itself uses for adjustments — see
--    submit_receiving_entry() below, which is the only place that ever
--    increases inventory from a receiving log entry.

-- 1) log-entry-docs: private Storage bucket for every log entry's file
--    attachments (receiving's COA/SDS/invoice/spec-sheet uploads today;
--    generic enough for any future log type's attachments too, since
--    log_entry_files itself is not receiving-specific). PDF, PNG or JPG,
--    25 MB cap, same pattern as the `sops` bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('log-entry-docs', 'log-entry-docs', false, 26214400, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set
  public = false,
  file_size_limit = 26214400,
  allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg'];

drop policy if exists log_entry_docs_bucket_shared_policy on storage.objects;
create policy log_entry_docs_bucket_shared_policy on storage.objects
  for all using (bucket_id = 'log-entry-docs' and auth.role() = 'authenticated')
  with check (bucket_id = 'log-entry-docs' and auth.role() = 'authenticated');

-- 2) receiving_details: one row per receiving log_entries row.
create table if not exists receiving_details (
  log_entry_id uuid primary key references log_entries(id) on delete cascade,
  raw_material_id uuid not null references inventory_items(id) on delete restrict,
  supplier text not null,
  supplier_lot_number text not null,
  internal_lot_id text not null,
  quantity_received_grams numeric,
  quantity_added_in_material_unit numeric not null,
  material_unit_at_receipt text not null,
  expiration_date date,
  po_or_invoice_number text,
  packaging_intact boolean not null,
  identity_verified boolean not null,
  coa_received boolean not null,
  notes text,
  created_new_raw_material boolean not null default false
  -- No unique constraint on internal_lot_id: a correction entry
  -- deliberately reuses its original's lot id (same physical shipment —
  -- see submit_receiving_entry below), so the same value legitimately
  -- appears on more than one row. Freshly generated ids are already kept
  -- unique by the advisory-lock + max()+1 logic at generation time.
);

create index if not exists idx_receiving_details_raw_material_id on receiving_details(raw_material_id);
create index if not exists idx_receiving_details_supplier on receiving_details(supplier);
create index if not exists idx_receiving_details_internal_lot_id on receiving_details(internal_lot_id);

alter table receiving_details enable row level security;
drop policy if exists receiving_details_select_policy on receiving_details;
create policy receiving_details_select_policy on receiving_details
  for select using (auth.role() = 'authenticated');
drop policy if exists receiving_details_insert_policy on receiving_details;
create policy receiving_details_insert_policy on receiving_details
  for insert with check (auth.role() = 'authenticated');

-- Append-only, like its parent log_entries row (no update/delete grant;
-- enforced below with the same reject trigger used in the core migration).
grant select, insert on table receiving_details to authenticated;

drop trigger if exists trg_reject_update_delete on public.receiving_details;
create trigger trg_reject_update_delete
before update or delete on public.receiving_details
for each row execute function public.reject_update_delete();

-- 3) inventory_adjustments: link a receiving-caused adjustment back to the
--    log entry that caused it — the same traceability pattern already used
--    for production-cycle deductions (see production_raw_materials_deducted.sql,
--    which added production_cycle_id the same way). adjustment_type already
--    has no CHECK constraint (it's used today with 'purchase', 'usage',
--    'cycle_count', 'correction', 'usage_reversal' — plain text, app-enforced),
--    so 'receiving_log' / 'receiving_log_correction' need no migration of
--    their own; this column is the only schema change this step needs.
alter table inventory_adjustments
  add column if not exists log_entry_id uuid references log_entries(id) on delete set null;

create index if not exists idx_inventory_adjustments_log_entry_id on inventory_adjustments(log_entry_id);

-- 4) submit_receiving_entry: the ONE-transaction path for a receiving
--    submission (safety rule: roll back everything on any failure). A
--    plpgsql function body is already one transaction in Postgres — any
--    exception raised anywhere below undoes every write this call made,
--    including the new raw material row if one was created.
--    security invoker (not definer): runs as whatever role calls it,
--    same as every other write path in this app — the service role used
--    by the API route already bypasses RLS on its own, and nothing here
--    needs elevated privileges beyond what `authenticated` already has.
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
  v_unit text;
begin
  if v_raw_material_id is null and v_new_material is not null then
    -- Matches the exact column set every other "New inventory item" path in
    -- this app inserts (src/app/inventory/page.tsx, formulation/new, and
    -- formulation/[id]) — user_id is set on every one of them, so it's
    -- treated as required here too rather than risking a NOT NULL failure.
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
    coalesce(payload->'values', '{}'::jsonb),
    coalesce(payload->'template_snapshot', '{}'::jsonb),
    false,
    null,
    null,
    v_corrects_entry_id,
    payload->>'correction_reason',
    (payload->>'created_by_account')::uuid
  )
  returning id into v_entry_id;

  -- Lot id: a correction keeps the original receipt's lot id (same
  -- physical shipment); a new receipt gets a fresh one, reset daily.
  if v_corrects_entry_id is not null then
    select internal_lot_id into v_lot_id
    from receiving_details
    where log_entry_id = v_corrects_entry_id;
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
    coa_received, notes, created_new_raw_material
  ) values (
    v_entry_id, v_raw_material_id, payload->>'supplier', payload->>'supplier_lot_number', v_lot_id,
    case when payload->>'quantity_received_grams' is null then null else (payload->>'quantity_received_grams')::numeric end,
    v_quantity_added,
    payload->>'material_unit_at_receipt',
    case when payload->>'expiration_date' is null or payload->>'expiration_date' = '' then null else (payload->>'expiration_date')::date end,
    payload->>'po_or_invoice_number',
    (payload->>'packaging_intact')::boolean,
    (payload->>'identity_verified')::boolean,
    (payload->>'coa_received')::boolean,
    payload->>'notes',
    v_created_new_material
  );

  if payload->'files' is not null then
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

  -- Inventory increase, through the same table/column the Raw Materials
  -- page itself uses (inventory_adjustments + inventory_items.quantity_on_hand).
  if v_corrects_entry_id is not null then
    v_delta := v_quantity_added - coalesce(v_original_quantity_added, 0);
    v_adjustment_type := 'receiving_log_correction';
    v_note := 'Receiving correction, entry ' || v_entry_id::text || ' (lot ' || v_lot_id || ')';
  else
    v_delta := v_quantity_added;
    v_adjustment_type := 'receiving_log';
    v_note := 'Received ' || v_quantity_added::text || ' ' || (payload->>'material_unit_at_receipt') ||
      ' (lot ' || v_lot_id || ', supplier ' || coalesce(payload->>'supplier', '') || ')';
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
    'createdNewRawMaterial', v_created_new_material
  );
end;
$$;

-- Called via the API route using the service-role client; granted to both
-- roles defensively in case this project's default function privileges
-- have been hardened away from PUBLIC.
grant execute on function public.submit_receiving_entry(jsonb) to authenticated, service_role;
