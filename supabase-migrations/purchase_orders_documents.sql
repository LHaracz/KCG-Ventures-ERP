-- Purchase Orders (Phase 2): purchase_orders + po_lines, and the two RPCs
-- that are the only way to create or edit one. Run purchase_orders_core.sql
-- first. Run in the Supabase SQL editor.
--
-- Safety rules this file exists to satisfy:
--  - No changes to any existing table. Everything here is new.
--  - Money is numeric, never float. Every total is computed server-side
--    inside these RPCs — the client's subtotal/tax/total are never
--    trusted, even on edit.
--  - PO numbers are never reused or reassigned: create_purchase_order is
--    the only caller of assign_po_number(), update_purchase_order never
--    calls it, and a soft-deleted PO's row (and its number) is never
--    removed — only deleted_at is set.

-- 1) purchase_orders
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique,
  prefix text not null,
  year integer not null,
  sequence integer not null,

  company_profile_id uuid not null references company_profiles(id) on delete restrict,
  company_snapshot jsonb not null,

  order_date date not null,
  needed_by_date date not null,

  vendor_name text not null,
  vendor_contact_name text,
  vendor_email text,
  vendor_phone text,
  vendor_account_number text,
  vendor_address_line1 text not null,
  vendor_address_line2 text,
  vendor_city text not null,
  vendor_state text not null,
  vendor_zip text not null,
  vendor_country text not null,

  ship_to jsonb not null,

  payment_terms text not null,
  shipping_method text not null,
  freight_terms text not null,
  reference_number text,

  prepared_by_name text not null,
  authorized_by_name text not null,
  authorized_by_title text not null,
  buyer_phone text not null,
  buyer_email text not null,

  shipping_cost numeric(12,2) not null default 0,
  tax_exempt boolean not null default false,
  tax_rate_percent numeric(6,3) not null default 0,
  subtotal numeric(12,2) not null,
  tax_amount numeric(12,2) not null,
  total numeric(12,2) not null,

  special_instructions text,
  terms_text text not null,
  notes_to_vendor text,
  internal_notes text,

  deleted_at timestamptz,
  last_downloaded_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_account uuid
);

create index if not exists idx_purchase_orders_company_profile_id on purchase_orders(company_profile_id);
create index if not exists idx_purchase_orders_deleted_at on purchase_orders(deleted_at);
create index if not exists idx_purchase_orders_order_date on purchase_orders(order_date);
create index if not exists idx_purchase_orders_vendor_name on purchase_orders(vendor_name);
create index if not exists idx_purchase_orders_created_at on purchase_orders(created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_purchase_orders_set_updated_at on public.purchase_orders;
create trigger trg_purchase_orders_set_updated_at
before update on public.purchase_orders
for each row execute function public.set_updated_at();

alter table purchase_orders enable row level security;
drop policy if exists purchase_orders_select_policy on purchase_orders;
create policy purchase_orders_select_policy on purchase_orders
  for select using (auth.role() = 'authenticated');
drop policy if exists purchase_orders_insert_policy on purchase_orders;
create policy purchase_orders_insert_policy on purchase_orders
  for insert with check (auth.role() = 'authenticated');
drop policy if exists purchase_orders_update_policy on purchase_orders;
create policy purchase_orders_update_policy on purchase_orders
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- No delete grant, ever: a PO is soft-deleted (deleted_at set) so its
-- number is never freed up for reuse.
grant select, insert, update on table purchase_orders to authenticated;

-- 2) po_lines
create table if not exists po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  line_number integer not null,
  item_number text,
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit text not null,
  unit_price numeric(12,4) not null check (unit_price > 0),
  line_total numeric(12,2) not null,
  constraint po_lines_number_unique_per_po unique (po_id, line_number)
);

create index if not exists idx_po_lines_po_id on po_lines(po_id);

alter table po_lines enable row level security;
drop policy if exists po_lines_select_policy on po_lines;
create policy po_lines_select_policy on po_lines
  for select using (auth.role() = 'authenticated');
drop policy if exists po_lines_insert_policy on po_lines;
create policy po_lines_insert_policy on po_lines
  for insert with check (auth.role() = 'authenticated');
drop policy if exists po_lines_delete_policy on po_lines;
create policy po_lines_delete_policy on po_lines
  for delete using (auth.role() = 'authenticated');

-- No update grant: an edited PO's lines are replaced (delete + re-insert
-- inside update_purchase_order below), never updated in place, so every
-- line's row always reflects a single, whole "line item" write.
grant select, insert, delete on table po_lines to authenticated;

-- 3) create_purchase_order: the ONE place a PO is first created. Assigns
--    the number (via assign_po_number, inside this same transaction — see
--    purchase_orders_core.sql for why that makes the whole thing atomic),
--    recomputes every line total and the subtotal/tax/total from scratch
--    (the client's numbers in payload are never trusted), and inserts the
--    PO plus all its lines as one unit. A plpgsql function body is one
--    transaction, so a failure at any point (bad line, missing profile)
--    rolls back everything, including the number — nothing is consumed
--    for a form that never successfully saves.
create or replace function public.create_purchase_order(payload jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_profile company_profiles%rowtype;
  v_assigned record;
  v_po_id uuid;
  v_lines jsonb := payload->'lines';
  v_line jsonb;
  v_line_count integer;
  v_line_number integer := 0;
  v_quantity numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_shipping numeric := coalesce((payload->>'shipping_cost')::numeric, 0);
  v_tax_exempt boolean := coalesce((payload->>'tax_exempt')::boolean, false);
  v_tax_rate numeric := coalesce((payload->>'tax_rate_percent')::numeric, 0);
  v_tax_amount numeric;
  v_total numeric;
begin
  if payload->>'company_profile_id' is null then
    raise exception 'A business (company profile) is required.';
  end if;
  select * into v_profile from company_profiles where id = (payload->>'company_profile_id')::uuid;
  if v_profile.id is null then
    raise exception 'Selected business was not found.';
  end if;

  if payload->>'order_date' is null then raise exception 'Order date is required.'; end if;
  if payload->>'needed_by_date' is null then raise exception 'Needed-by date is required.'; end if;
  if trim(coalesce(payload->>'vendor_name', '')) = '' then raise exception 'Vendor name is required.'; end if;
  if trim(coalesce(payload->>'vendor_address_line1', '')) = '' then raise exception 'Vendor address is required.'; end if;
  if trim(coalesce(payload->>'vendor_city', '')) = '' then raise exception 'Vendor city is required.'; end if;
  if trim(coalesce(payload->>'vendor_state', '')) = '' then raise exception 'Vendor state/region is required.'; end if;
  if trim(coalesce(payload->>'vendor_zip', '')) = '' then raise exception 'Vendor zip/postal code is required.'; end if;
  if trim(coalesce(payload->>'vendor_country', '')) = '' then raise exception 'Vendor country is required.'; end if;
  if trim(coalesce(payload->>'payment_terms', '')) = '' then raise exception 'Payment terms are required.'; end if;
  if trim(coalesce(payload->>'shipping_method', '')) = '' then raise exception 'Shipping method is required.'; end if;
  if trim(coalesce(payload->>'freight_terms', '')) = '' then raise exception 'Freight terms are required.'; end if;
  if trim(coalesce(payload->>'prepared_by_name', '')) = '' then raise exception 'Prepared by is required.'; end if;
  if trim(coalesce(payload->>'authorized_by_name', '')) = '' then raise exception 'Authorized by is required.'; end if;
  if trim(coalesce(payload->>'authorized_by_title', '')) = '' then raise exception 'Authorized-by title is required.'; end if;
  if trim(coalesce(payload->>'buyer_phone', '')) = '' then raise exception 'Buyer phone is required.'; end if;
  if trim(coalesce(payload->>'buyer_email', '')) = '' then raise exception 'Buyer email is required.'; end if;
  if payload->'ship_to' is null then raise exception 'Ship-to is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'name', '')) = '' then raise exception 'Ship-to name is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'address_line1', '')) = '' then raise exception 'Ship-to address is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'city', '')) = '' then raise exception 'Ship-to city is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'state', '')) = '' then raise exception 'Ship-to state is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'zip', '')) = '' then raise exception 'Ship-to zip is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'country', '')) = '' then raise exception 'Ship-to country is required.'; end if;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
    raise exception 'At least one line item is required.';
  end if;
  v_line_count := jsonb_array_length(v_lines);
  if v_line_count < 1 then raise exception 'At least one line item is required.'; end if;
  if v_line_count > 100 then raise exception 'A purchase order can have at most 100 line items.'; end if;

  v_assigned := public.assign_po_number(v_profile.po_prefix);

  insert into purchase_orders (
    po_number, prefix, year, sequence,
    company_profile_id, company_snapshot,
    order_date, needed_by_date,
    vendor_name, vendor_contact_name, vendor_email, vendor_phone, vendor_account_number,
    vendor_address_line1, vendor_address_line2, vendor_city, vendor_state, vendor_zip, vendor_country,
    ship_to,
    payment_terms, shipping_method, freight_terms, reference_number,
    prepared_by_name, authorized_by_name, authorized_by_title, buyer_phone, buyer_email,
    shipping_cost, tax_exempt, tax_rate_percent, subtotal, tax_amount, total,
    special_instructions, terms_text, notes_to_vendor, internal_notes,
    created_by_account
  ) values (
    v_assigned.po_number, v_profile.po_prefix, v_assigned.po_year, v_assigned.po_sequence,
    v_profile.id, jsonb_build_object(
      'display_name', v_profile.display_name, 'legal_name', v_profile.legal_name,
      'address_line1', v_profile.address_line1, 'address_line2', v_profile.address_line2,
      'city', v_profile.city, 'state', v_profile.state, 'zip', v_profile.zip, 'country', v_profile.country,
      'phone', v_profile.phone, 'email', v_profile.email, 'website', v_profile.website,
      'logo_path', v_profile.logo_path, 'accent_color', v_profile.accent_color,
      'footer_note', v_profile.footer_note
    ),
    (payload->>'order_date')::date, (payload->>'needed_by_date')::date,
    trim(payload->>'vendor_name'), payload->>'vendor_contact_name', payload->>'vendor_email', payload->>'vendor_phone', payload->>'vendor_account_number',
    trim(payload->>'vendor_address_line1'), payload->>'vendor_address_line2', trim(payload->>'vendor_city'), trim(payload->>'vendor_state'), trim(payload->>'vendor_zip'), trim(payload->>'vendor_country'),
    payload->'ship_to',
    trim(payload->>'payment_terms'), trim(payload->>'shipping_method'), trim(payload->>'freight_terms'), payload->>'reference_number',
    trim(payload->>'prepared_by_name'), trim(payload->>'authorized_by_name'), trim(payload->>'authorized_by_title'), trim(payload->>'buyer_phone'), trim(payload->>'buyer_email'),
    v_shipping, v_tax_exempt, v_tax_rate, 0, 0, 0,
    payload->>'special_instructions', coalesce(payload->>'terms_text', ''), payload->>'notes_to_vendor', payload->>'internal_notes',
    (payload->>'created_by_account')::uuid
  ) returning id into v_po_id;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_line_number := v_line_number + 1;
    if trim(coalesce(v_line->>'description', '')) = '' then raise exception 'Line %: description is required.', v_line_number; end if;
    if trim(coalesce(v_line->>'unit', '')) = '' then raise exception 'Line %: unit is required.', v_line_number; end if;
    v_quantity := (v_line->>'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then raise exception 'Line %: quantity must be greater than 0.', v_line_number; end if;
    v_unit_price := (v_line->>'unit_price')::numeric;
    if v_unit_price is null or v_unit_price <= 0 then raise exception 'Line %: unit price must be greater than 0.', v_line_number; end if;
    v_line_total := round(v_quantity * v_unit_price, 2);
    v_subtotal := v_subtotal + v_line_total;

    insert into po_lines (po_id, line_number, item_number, description, quantity, unit, unit_price, line_total)
    values (v_po_id, v_line_number, v_line->>'item_number', trim(v_line->>'description'), v_quantity, trim(v_line->>'unit'), v_unit_price, v_line_total);
  end loop;

  if v_tax_exempt then
    v_tax_amount := 0;
  else
    v_tax_amount := round(v_subtotal * (v_tax_rate / 100.0), 2);
  end if;
  v_total := v_subtotal + v_shipping + v_tax_amount;

  update purchase_orders
  set subtotal = v_subtotal, tax_amount = v_tax_amount, total = v_total
  where id = v_po_id;

  return jsonb_build_object('id', v_po_id, 'po_number', v_assigned.po_number);
end;
$$;

-- 4) update_purchase_order: the ONE place an existing PO is edited. Never
--    touches po_number/prefix/year/sequence (a PO's number never changes).
--    Lines are fully replaced (delete-then-reinsert) rather than updated
--    row by row, and every total is recomputed from scratch exactly like
--    create_purchase_order — the edit form's displayed numbers are never
--    trusted either. company_snapshot is left untouched unless the caller
--    explicitly asks to refresh it (the "Update company details from the
--    current profile" checkbox).
create or replace function public.update_purchase_order(payload jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_po_id uuid := (payload->>'id')::uuid;
  v_existing purchase_orders%rowtype;
  v_profile company_profiles%rowtype;
  v_refresh_snapshot boolean := coalesce((payload->>'refresh_company_snapshot')::boolean, false);
  v_snapshot jsonb;
  v_lines jsonb := payload->'lines';
  v_line jsonb;
  v_line_count integer;
  v_line_number integer := 0;
  v_quantity numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_shipping numeric := coalesce((payload->>'shipping_cost')::numeric, 0);
  v_tax_exempt boolean := coalesce((payload->>'tax_exempt')::boolean, false);
  v_tax_rate numeric := coalesce((payload->>'tax_rate_percent')::numeric, 0);
  v_tax_amount numeric;
  v_total numeric;
begin
  if v_po_id is null then raise exception 'Missing purchase order id.'; end if;
  select * into v_existing from purchase_orders where id = v_po_id;
  if v_existing.id is null then raise exception 'Purchase order not found.'; end if;
  if v_existing.deleted_at is not null then raise exception 'A deleted purchase order cannot be edited.'; end if;

  if payload->>'company_profile_id' is null then raise exception 'A business (company profile) is required.'; end if;
  select * into v_profile from company_profiles where id = (payload->>'company_profile_id')::uuid;
  if v_profile.id is null then raise exception 'Selected business was not found.'; end if;

  if payload->>'order_date' is null then raise exception 'Order date is required.'; end if;
  if payload->>'needed_by_date' is null then raise exception 'Needed-by date is required.'; end if;
  if trim(coalesce(payload->>'vendor_name', '')) = '' then raise exception 'Vendor name is required.'; end if;
  if trim(coalesce(payload->>'vendor_address_line1', '')) = '' then raise exception 'Vendor address is required.'; end if;
  if trim(coalesce(payload->>'vendor_city', '')) = '' then raise exception 'Vendor city is required.'; end if;
  if trim(coalesce(payload->>'vendor_state', '')) = '' then raise exception 'Vendor state/region is required.'; end if;
  if trim(coalesce(payload->>'vendor_zip', '')) = '' then raise exception 'Vendor zip/postal code is required.'; end if;
  if trim(coalesce(payload->>'vendor_country', '')) = '' then raise exception 'Vendor country is required.'; end if;
  if trim(coalesce(payload->>'payment_terms', '')) = '' then raise exception 'Payment terms are required.'; end if;
  if trim(coalesce(payload->>'shipping_method', '')) = '' then raise exception 'Shipping method is required.'; end if;
  if trim(coalesce(payload->>'freight_terms', '')) = '' then raise exception 'Freight terms are required.'; end if;
  if trim(coalesce(payload->>'prepared_by_name', '')) = '' then raise exception 'Prepared by is required.'; end if;
  if trim(coalesce(payload->>'authorized_by_name', '')) = '' then raise exception 'Authorized by is required.'; end if;
  if trim(coalesce(payload->>'authorized_by_title', '')) = '' then raise exception 'Authorized-by title is required.'; end if;
  if trim(coalesce(payload->>'buyer_phone', '')) = '' then raise exception 'Buyer phone is required.'; end if;
  if trim(coalesce(payload->>'buyer_email', '')) = '' then raise exception 'Buyer email is required.'; end if;
  if payload->'ship_to' is null then raise exception 'Ship-to is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'name', '')) = '' then raise exception 'Ship-to name is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'address_line1', '')) = '' then raise exception 'Ship-to address is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'city', '')) = '' then raise exception 'Ship-to city is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'state', '')) = '' then raise exception 'Ship-to state is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'zip', '')) = '' then raise exception 'Ship-to zip is required.'; end if;
  if trim(coalesce(payload->'ship_to'->>'country', '')) = '' then raise exception 'Ship-to country is required.'; end if;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' then raise exception 'At least one line item is required.'; end if;
  v_line_count := jsonb_array_length(v_lines);
  if v_line_count < 1 then raise exception 'At least one line item is required.'; end if;
  if v_line_count > 100 then raise exception 'A purchase order can have at most 100 line items.'; end if;

  if v_refresh_snapshot then
    v_snapshot := jsonb_build_object(
      'display_name', v_profile.display_name, 'legal_name', v_profile.legal_name,
      'address_line1', v_profile.address_line1, 'address_line2', v_profile.address_line2,
      'city', v_profile.city, 'state', v_profile.state, 'zip', v_profile.zip, 'country', v_profile.country,
      'phone', v_profile.phone, 'email', v_profile.email, 'website', v_profile.website,
      'logo_path', v_profile.logo_path, 'accent_color', v_profile.accent_color,
      'footer_note', v_profile.footer_note
    );
  else
    v_snapshot := v_existing.company_snapshot;
  end if;

  delete from po_lines where po_id = v_po_id;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_line_number := v_line_number + 1;
    if trim(coalesce(v_line->>'description', '')) = '' then raise exception 'Line %: description is required.', v_line_number; end if;
    if trim(coalesce(v_line->>'unit', '')) = '' then raise exception 'Line %: unit is required.', v_line_number; end if;
    v_quantity := (v_line->>'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then raise exception 'Line %: quantity must be greater than 0.', v_line_number; end if;
    v_unit_price := (v_line->>'unit_price')::numeric;
    if v_unit_price is null or v_unit_price <= 0 then raise exception 'Line %: unit price must be greater than 0.', v_line_number; end if;
    v_line_total := round(v_quantity * v_unit_price, 2);
    v_subtotal := v_subtotal + v_line_total;

    insert into po_lines (po_id, line_number, item_number, description, quantity, unit, unit_price, line_total)
    values (v_po_id, v_line_number, v_line->>'item_number', trim(v_line->>'description'), v_quantity, trim(v_line->>'unit'), v_unit_price, v_line_total);
  end loop;

  if v_tax_exempt then
    v_tax_amount := 0;
  else
    v_tax_amount := round(v_subtotal * (v_tax_rate / 100.0), 2);
  end if;
  v_total := v_subtotal + v_shipping + v_tax_amount;

  update purchase_orders set
    company_profile_id = v_profile.id,
    company_snapshot = v_snapshot,
    order_date = (payload->>'order_date')::date,
    needed_by_date = (payload->>'needed_by_date')::date,
    vendor_name = trim(payload->>'vendor_name'),
    vendor_contact_name = payload->>'vendor_contact_name',
    vendor_email = payload->>'vendor_email',
    vendor_phone = payload->>'vendor_phone',
    vendor_account_number = payload->>'vendor_account_number',
    vendor_address_line1 = trim(payload->>'vendor_address_line1'),
    vendor_address_line2 = payload->>'vendor_address_line2',
    vendor_city = trim(payload->>'vendor_city'),
    vendor_state = trim(payload->>'vendor_state'),
    vendor_zip = trim(payload->>'vendor_zip'),
    vendor_country = trim(payload->>'vendor_country'),
    ship_to = payload->'ship_to',
    payment_terms = trim(payload->>'payment_terms'),
    shipping_method = trim(payload->>'shipping_method'),
    freight_terms = trim(payload->>'freight_terms'),
    reference_number = payload->>'reference_number',
    prepared_by_name = trim(payload->>'prepared_by_name'),
    authorized_by_name = trim(payload->>'authorized_by_name'),
    authorized_by_title = trim(payload->>'authorized_by_title'),
    buyer_phone = trim(payload->>'buyer_phone'),
    buyer_email = trim(payload->>'buyer_email'),
    shipping_cost = v_shipping,
    tax_exempt = v_tax_exempt,
    tax_rate_percent = v_tax_rate,
    subtotal = v_subtotal,
    tax_amount = v_tax_amount,
    total = v_total,
    special_instructions = payload->>'special_instructions',
    terms_text = coalesce(payload->>'terms_text', ''),
    notes_to_vendor = payload->>'notes_to_vendor',
    internal_notes = payload->>'internal_notes'
  where id = v_po_id;

  return jsonb_build_object('id', v_po_id, 'po_number', v_existing.po_number);
end;
$$;
