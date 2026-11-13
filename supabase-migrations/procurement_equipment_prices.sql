-- Procurement: equipment, equipment categories, equipment supplier listings,
-- and listing prices (raw materials and equipment).
-- Run in the Supabase SQL editor BEFORE deploying the code that uses it, and
-- after procurement_suppliers.sql.
--
-- Safety rules this file follows:
--  - Additive only. Three new tables with their triggers, functions and
--    policies, and three nullable columns on raw_material_suppliers (price,
--    price_note, price_updated_at). No other existing table, column,
--    function or policy is changed; archive_supplier() is left as it is and
--    a new archive_supplier_listings() covers equipment too.
--  - No hard deletes: equipment, categories and listings are archived.
--  - Purchase Orders stay independent: nothing links a PO to a supplier or
--    equipment item.
--  - Safe to run more than once.

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regclass('public.suppliers') is null or to_regclass('public.raw_material_suppliers') is null then
    raise exception 'Run procurement_suppliers.sql first (suppliers / raw_material_suppliers are missing).';
  end if;
  if to_regprocedure('public.has_feature(text)') is null or to_regprocedure('public.is_active_employee()') is null then
    raise exception 'Run the employee access migrations first (has_feature() / is_active_employee() are missing).';
  end if;
end $$;

-- 1) Prices on raw material listings (nullable, additive) ----------------------
alter table raw_material_suppliers add column if not exists price numeric(14,4)
  constraint rms_price_positive check (price > 0);
alter table raw_material_suppliers add column if not exists price_note text
  constraint rms_price_note_len check (price_note is null or char_length(price_note) <= 200);
alter table raw_material_suppliers add column if not exists price_updated_at timestamptz;

-- 2) equipment_categories --------------------------------------------------------
create table if not exists equipment_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint equipment_categories_name_len check (char_length(btrim(name)) between 1 and 100 and name = btrim(name))
);
create unique index if not exists equipment_categories_name_unique
  on equipment_categories (lower(name)) where archived_at is null;

insert into equipment_categories (name, sort_order)
select v.name, v.sort_order
from (values ('Production', 1), ('Warehouse', 2), ('Office', 3), ('Other', 4)) as v(name, sort_order)
where not exists (
  select 1 from equipment_categories c where lower(c.name) = lower(v.name) and c.archived_at is null
);

-- 3) equipment_items -----------------------------------------------------------------
create table if not exists equipment_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id uuid not null references equipment_categories(id) on delete restrict,
  description text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_name text,
  constraint equipment_items_name_len check (char_length(btrim(name)) between 1 and 200 and name = btrim(name)),
  constraint equipment_items_description_len check (description is null or char_length(description) <= 2000),
  constraint equipment_items_updated_by_name_len check (updated_by_name is null or char_length(updated_by_name) <= 200)
);
create unique index if not exists equipment_items_name_unique
  on equipment_items (lower(name)) where archived_at is null;
create index if not exists equipment_items_category_idx on equipment_items (category_id);

-- 4) equipment_suppliers: one row per equipment item and supplier pair ---------------
create table if not exists equipment_suppliers (
  id uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references equipment_items(id) on delete restrict,
  supplier_id uuid not null references suppliers(id) on delete restrict,
  is_preferred boolean not null default false,
  product_url text,
  supplier_item text,
  price numeric(14,4),
  price_note text,
  price_updated_at timestamptz,
  notes text,
  link_updated_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint es_product_url_ok check (
    product_url is null or (char_length(product_url) <= 2000 and product_url ~* '^https?://[^[:space:]]+$')
  ),
  constraint es_supplier_item_len check (supplier_item is null or char_length(supplier_item) <= 200),
  constraint es_price_positive check (price is null or price > 0),
  constraint es_price_note_len check (price_note is null or char_length(price_note) <= 200),
  constraint es_notes_len check (notes is null or char_length(notes) <= 2000),
  constraint es_archived_not_preferred check (archived_at is null or not is_preferred)
);
create unique index if not exists es_active_pair_unique
  on equipment_suppliers (equipment_id, supplier_id) where archived_at is null;
create unique index if not exists es_one_preferred_unique
  on equipment_suppliers (equipment_id) where is_preferred and archived_at is null;
create index if not exists es_supplier_idx on equipment_suppliers (supplier_id);

-- 5) Triggers ---------------------------------------------------------------------------
-- price_updated_at follows price on both listing tables: set when a price is
-- added or changed to a different value, cleared when the price is cleared,
-- never set by hand. Changing the note or anything else leaves it alone.
create or replace function procurement_price_stamp() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.price_updated_at := case when new.price is null then null else now() end;
  elsif new.price is distinct from old.price then
    new.price_updated_at := case when new.price is null then null else now() end;
  else
    new.price_updated_at := old.price_updated_at;
  end if;
  return new;
end $$;

drop trigger if exists rms_price_stamp on raw_material_suppliers;
create trigger rms_price_stamp before insert or update on raw_material_suppliers
  for each row execute function procurement_price_stamp();
drop trigger if exists es_price_stamp on equipment_suppliers;
create trigger es_price_stamp before insert or update on equipment_suppliers
  for each row execute function procurement_price_stamp();

-- updated_at (procurement_touch_updated_at comes from procurement_suppliers.sql).
drop trigger if exists equipment_items_touch_updated_at on equipment_items;
create trigger equipment_items_touch_updated_at before update on equipment_items
  for each row execute function procurement_touch_updated_at();
drop trigger if exists es_touch_updated_at on equipment_suppliers;
create trigger es_touch_updated_at before update on equipment_suppliers
  for each row execute function procurement_touch_updated_at();

-- Equipment listings work like raw material listings: link_updated_at
-- follows product_url, the first active supplier becomes preferred, and
-- archiving a listing clears its star without promoting another.
create or replace function equipment_suppliers_before_write() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.link_updated_at := case when new.product_url is null then null else now() end;
    if new.archived_at is null and not exists (
      select 1 from equipment_suppliers e
      where e.equipment_id = new.equipment_id and e.archived_at is null
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

drop trigger if exists es_before_write on equipment_suppliers;
create trigger es_before_write before insert or update on equipment_suppliers
  for each row execute function equipment_suppliers_before_write();

-- A category can't be archived while an active equipment item uses it, and
-- an equipment item can't be put in an archived category.
create or replace function equipment_categories_archive_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare n integer;
begin
  if new.archived_at is not null and old.archived_at is null then
    select count(*) into n from equipment_items i where i.category_id = new.id and i.archived_at is null;
    if n > 0 then
      raise exception '% % this category. Move them to another category before archiving it.',
        n, case when n = 1 then 'item uses' else 'items use' end
        using hint = 'category_in_use';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists equipment_categories_archive_guard on equipment_categories;
create trigger equipment_categories_archive_guard before update on equipment_categories
  for each row execute function equipment_categories_archive_guard();

create or replace function equipment_items_category_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.archived_at is null and exists (
    select 1 from equipment_categories c where c.id = new.category_id and c.archived_at is not null
  ) then
    raise exception 'That category is archived. Choose an active category.' using hint = 'category_archived';
  end if;
  return new;
end $$;

drop trigger if exists equipment_items_category_guard on equipment_items;
create trigger equipment_items_category_guard before insert or update on equipment_items
  for each row execute function equipment_items_category_guard();

-- No hard deletes on the new tables.
create or replace function procurement_equipment_no_delete() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Equipment, categories and their supplier listings are never deleted. Archive them instead.';
end $$;

drop trigger if exists equipment_categories_no_delete on equipment_categories;
create trigger equipment_categories_no_delete before delete on equipment_categories
  for each row execute function procurement_equipment_no_delete();
drop trigger if exists equipment_items_no_delete on equipment_items;
create trigger equipment_items_no_delete before delete on equipment_items
  for each row execute function procurement_equipment_no_delete();
drop trigger if exists es_no_delete on equipment_suppliers;
create trigger es_no_delete before delete on equipment_suppliers
  for each row execute function procurement_equipment_no_delete();

-- 6) Functions (server code only, through the service role) -----------------------------
create or replace function set_preferred_equipment_supplier(p_equipment_id uuid, p_link_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from equipment_suppliers where equipment_id = p_equipment_id for update;
  if not exists (
    select 1 from equipment_suppliers
    where id = p_link_id and equipment_id = p_equipment_id and archived_at is null
  ) then
    raise exception 'That supplier listing was not found for this equipment item, or it is archived.';
  end if;
  update equipment_suppliers set is_preferred = false
    where equipment_id = p_equipment_id and is_preferred and id <> p_link_id;
  update equipment_suppliers set is_preferred = true where id = p_link_id;
end $$;

-- Archives an equipment item and its active supplier listings. Returns the
-- number of listings archived.
create or replace function archive_equipment_item(p_equipment_id uuid, p_actor_name text) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare v_count integer;
begin
  perform 1 from equipment_items where id = p_equipment_id and archived_at is null for update;
  if not found then
    raise exception 'That equipment item was not found, or it is already archived.';
  end if;
  update equipment_suppliers set archived_at = now()
    where equipment_id = p_equipment_id and archived_at is null;
  get diagnostics v_count = row_count;
  update equipment_items set archived_at = now(), updated_by_name = p_actor_name where id = p_equipment_id;
  return v_count;
end $$;

-- Archives a supplier with all its raw material AND equipment listings
-- (their stars are cleared by the triggers). Returns both counts.
create or replace function archive_supplier_listings(p_supplier_id uuid, p_actor_name text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_raw integer; v_eq integer;
begin
  perform 1 from suppliers where id = p_supplier_id and archived_at is null for update;
  if not found then
    raise exception 'That supplier was not found, or it is already archived.';
  end if;
  update raw_material_suppliers set archived_at = now()
    where supplier_id = p_supplier_id and archived_at is null;
  get diagnostics v_raw = row_count;
  update equipment_suppliers set archived_at = now()
    where supplier_id = p_supplier_id and archived_at is null;
  get diagnostics v_eq = row_count;
  update suppliers set archived_at = now(), updated_by_name = p_actor_name where id = p_supplier_id;
  return jsonb_build_object('raw_material_listings', v_raw, 'equipment_listings', v_eq);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'set_preferred_equipment_supplier(uuid, uuid)',
    'archive_equipment_item(uuid, text)',
    'archive_supplier_listings(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 7) Row level security -----------------------------------------------------------------
-- Same convention as suppliers / raw_material_suppliers: an active employee
-- holding the feature that guards Procurement (inventory.purchase_orders)
-- may read; every write goes through server routes that validate input and
-- check the same feature.
alter table equipment_categories enable row level security;
alter table equipment_items enable row level security;
alter table equipment_suppliers enable row level security;

revoke all on equipment_categories, equipment_items, equipment_suppliers from anon;
revoke insert, update, delete, truncate on equipment_categories, equipment_items, equipment_suppliers from authenticated;
grant select on equipment_categories, equipment_items, equipment_suppliers to authenticated;
grant all on equipment_categories, equipment_items, equipment_suppliers to service_role;

drop policy if exists equipment_categories_select_procurement on equipment_categories;
create policy equipment_categories_select_procurement on equipment_categories
  for select to authenticated
  using (is_active_employee() and has_feature('inventory.purchase_orders'));

drop policy if exists equipment_items_select_procurement on equipment_items;
create policy equipment_items_select_procurement on equipment_items
  for select to authenticated
  using (is_active_employee() and has_feature('inventory.purchase_orders'));

drop policy if exists equipment_suppliers_select_procurement on equipment_suppliers;
create policy equipment_suppliers_select_procurement on equipment_suppliers
  for select to authenticated
  using (is_active_employee() and has_feature('inventory.purchase_orders'));
