-- Procurement: suppliers, and which suppliers sell each raw material.
-- Run in the Supabase SQL editor BEFORE deploying the Procurement page.
-- Requires the employee access migrations (employee_accounts_roles.sql and
-- employee_access_policies.sql) to have run already.
--
-- Safety rules this file follows:
--  - Additive only. Two new tables, their triggers, two functions and
--    their policies. No existing table, column or policy is changed.
--  - Nothing is hard-deleted by the app: suppliers and links are archived
--    (archived_at). The only delete allowed is the automatic one when a raw
--    material itself is deleted on the Raw Materials page (its links go
--    with it, so that page's Delete button keeps working).
--  - Purchase Orders stay independent: no link between a PO and a supplier
--    is stored anywhere.
--  - No logins, passwords or card numbers are stored (and the app warns
--    against typing them into notes).
--  - Safe to run more than once.

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.has_feature(text)') is null or to_regprocedure('public.is_active_employee()') is null then
    raise exception 'Run the employee access migrations first (has_feature() / is_active_employee() are missing).';
  end if;
  if to_regclass('public.inventory_items') is null then
    raise exception 'inventory_items (Raw Materials) was not found.';
  end if;
end $$;

-- 1) suppliers: one row per supplier, shared by every raw material it sells.
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website_url text,
  contact_name text,
  contact_email text,
  contact_phone text,
  account_number text,
  payment_methods text[] not null default '{}'::text[],
  payment_notes text,
  ordering_notes text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  country text,
  default_po_payment_terms text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_name text,
  constraint suppliers_name_len check (char_length(btrim(name)) between 1 and 200),
  constraint suppliers_website_url_ok check (
    website_url is null or (char_length(website_url) <= 2000 and website_url ~* '^https?://[^[:space:]]+$')
  ),
  constraint suppliers_contact_name_len check (contact_name is null or char_length(contact_name) <= 200),
  constraint suppliers_contact_email_ok check (
    contact_email is null or (char_length(contact_email) <= 254 and contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  constraint suppliers_contact_phone_len check (contact_phone is null or char_length(contact_phone) <= 50),
  constraint suppliers_account_number_len check (account_number is null or char_length(account_number) <= 100),
  constraint suppliers_payment_methods_ok check (
    payment_methods <@ array['credit_card', 'wire_transfer', 'phone_order', 'po_required', 'invoice_terms', 'other']::text[]
  ),
  constraint suppliers_payment_notes_len check (payment_notes is null or char_length(payment_notes) <= 2000),
  constraint suppliers_ordering_notes_len check (ordering_notes is null or char_length(ordering_notes) <= 2000),
  constraint suppliers_address_len check (
    coalesce(char_length(address_line1), 0) <= 200 and coalesce(char_length(address_line2), 0) <= 200
    and coalesce(char_length(city), 0) <= 200 and coalesce(char_length(state), 0) <= 200
    and coalesce(char_length(zip), 0) <= 200 and coalesce(char_length(country), 0) <= 200
  ),
  -- The same options as the Purchase Order form's payment terms list.
  constraint suppliers_default_po_payment_terms_ok check (
    default_po_payment_terms is null or default_po_payment_terms in
      ('Net 30', 'Net 60', 'Due on receipt', '50% deposit, balance on delivery', 'Prepaid')
  ),
  constraint suppliers_updated_by_name_len check (updated_by_name is null or char_length(updated_by_name) <= 200)
);

-- Names are unique ignoring case and surrounding spaces (archived included).
create unique index if not exists suppliers_name_unique on suppliers (lower(btrim(name)));

-- 2) raw_material_suppliers: one row per raw material and supplier pair.
create table if not exists raw_material_suppliers (
  id uuid primary key default gen_random_uuid(),
  raw_material_id uuid not null references inventory_items(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete restrict,
  is_preferred boolean not null default false,
  product_url text,
  supplier_item text,
  pack_info text,
  coa_policy text not null default 'unknown',
  notes text,
  link_updated_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rms_product_url_ok check (
    product_url is null or (char_length(product_url) <= 2000 and product_url ~* '^https?://[^[:space:]]+$')
  ),
  constraint rms_supplier_item_len check (supplier_item is null or char_length(supplier_item) <= 200),
  constraint rms_pack_info_len check (pack_info is null or char_length(pack_info) <= 200),
  constraint rms_coa_policy_ok check (coa_policy in ('included', 'request', 'not_available', 'unknown')),
  constraint rms_notes_len check (notes is null or char_length(notes) <= 2000),
  constraint rms_archived_not_preferred check (archived_at is null or not is_preferred)
);

-- One active link per pair, and at most one active preferred link per raw material.
create unique index if not exists rms_active_pair_unique
  on raw_material_suppliers (raw_material_id, supplier_id) where archived_at is null;
create unique index if not exists rms_one_preferred_unique
  on raw_material_suppliers (raw_material_id) where is_preferred and archived_at is null;
create index if not exists rms_supplier_idx on raw_material_suppliers (supplier_id);

-- 3) Triggers -------------------------------------------------------------------
create or replace function procurement_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists suppliers_touch_updated_at on suppliers;
create trigger suppliers_touch_updated_at before update on suppliers
  for each row execute function procurement_touch_updated_at();
drop trigger if exists rms_touch_updated_at on raw_material_suppliers;
create trigger rms_touch_updated_at before update on raw_material_suppliers
  for each row execute function procurement_touch_updated_at();

-- link_updated_at follows product_url (set when it is added or changed,
-- cleared when it is removed, never set by hand). The first active supplier
-- of a raw material becomes preferred. Archiving a link clears its star;
-- no other link is promoted.
create or replace function raw_material_suppliers_before_write() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.link_updated_at := case when new.product_url is null then null else now() end;
    if new.archived_at is null and not exists (
      select 1 from raw_material_suppliers r
      where r.raw_material_id = new.raw_material_id and r.archived_at is null
    ) then
      new.is_preferred := true;
    end if;
  else
    if new.product_url is distinct from old.product_url then
      new.link_updated_at := case when new.product_url is null then null else now() end;
    else
      new.link_updated_at := old.link_updated_at;
    end if;
  end if;
  if new.archived_at is not null then
    new.is_preferred := false;
  end if;
  return new;
end $$;

drop trigger if exists rms_before_write on raw_material_suppliers;
create trigger rms_before_write before insert or update on raw_material_suppliers
  for each row execute function raw_material_suppliers_before_write();

-- No hard deletes: archive instead. The one exception is a link whose raw
-- material is being deleted (the cascade from inventory_items).
create or replace function suppliers_no_delete() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Suppliers are never deleted. Archive the supplier instead.';
end $$;

drop trigger if exists suppliers_no_delete on suppliers;
create trigger suppliers_no_delete before delete on suppliers
  for each row execute function suppliers_no_delete();

create or replace function raw_material_suppliers_no_delete() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from inventory_items i where i.id = old.raw_material_id) then
    raise exception 'Supplier links are never deleted. Remove (archive) the link instead.';
  end if;
  return old;
end $$;

drop trigger if exists rms_no_delete on raw_material_suppliers;
create trigger rms_no_delete before delete on raw_material_suppliers
  for each row execute function raw_material_suppliers_no_delete();

-- 4) Functions (server code only, through the service role) --------------------
-- Makes one link the preferred supplier of its raw material and clears the
-- others, in one transaction.
create or replace function set_preferred_supplier(p_raw_material_id uuid, p_link_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from raw_material_suppliers where raw_material_id = p_raw_material_id for update;
  if not exists (
    select 1 from raw_material_suppliers
    where id = p_link_id and raw_material_id = p_raw_material_id and archived_at is null
  ) then
    raise exception 'That supplier link was not found for this raw material, or it is archived.';
  end if;
  update raw_material_suppliers set is_preferred = false
    where raw_material_id = p_raw_material_id and is_preferred and id <> p_link_id;
  update raw_material_suppliers set is_preferred = true where id = p_link_id;
end $$;

-- Archives a supplier and every active link it has (their stars are
-- cleared by the trigger). Returns how many links were archived.
create or replace function archive_supplier(p_supplier_id uuid, p_actor_name text) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare v_count integer;
begin
  perform 1 from suppliers where id = p_supplier_id and archived_at is null for update;
  if not found then
    raise exception 'That supplier was not found, or it is already archived.';
  end if;
  update raw_material_suppliers set archived_at = now()
    where supplier_id = p_supplier_id and archived_at is null;
  get diagnostics v_count = row_count;
  update suppliers set archived_at = now(), updated_by_name = p_actor_name where id = p_supplier_id;
  return v_count;
end $$;

do $$
declare f text;
begin
  foreach f in array array['set_preferred_supplier(uuid, uuid)', 'archive_supplier(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 5) Row level security -----------------------------------------------------------
-- Same convention as Raw Materials (employee_access_policies.sql): an active
-- employee holding the feature. Procurement is guarded by the Purchase
-- Orders feature (inventory.purchase_orders). The browser may only read;
-- every write goes through server routes that validate input and check the
-- same feature.
alter table suppliers enable row level security;
alter table raw_material_suppliers enable row level security;

revoke all on suppliers, raw_material_suppliers from anon;
revoke insert, update, delete, truncate on suppliers, raw_material_suppliers from authenticated;
grant select on suppliers, raw_material_suppliers to authenticated;
grant all on suppliers, raw_material_suppliers to service_role;

drop policy if exists suppliers_select_procurement on suppliers;
create policy suppliers_select_procurement on suppliers
  for select to authenticated
  using (is_active_employee() and has_feature('inventory.purchase_orders'));

drop policy if exists raw_material_suppliers_select_procurement on raw_material_suppliers;
create policy raw_material_suppliers_select_procurement on raw_material_suppliers
  for select to authenticated
  using (is_active_employee() and has_feature('inventory.purchase_orders'));
