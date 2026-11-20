-- Marketing Hub: asset categories you can add and delete.
-- Run in the Supabase SQL editor BEFORE deploying the code that uses it, and
-- after ad_library.sql (and the asset media migrations).
--
-- What this file does:
--  - Creates asset_categories (key, label, sort order). The six built-in
--    categories are added the first time (Product, Group product,
--    Ingredient, Markets, Retail, Other), with the same keys assets use today.
--    They are only added while the table is empty, so running this file
--    again never brings back a category that was deleted.
--  - Replaces the fixed list rule marketing_assets_category_ok with a foreign
--    key: an asset's category must be a row in asset_categories, and a
--    category can't be deleted while ANY asset uses it (archived ones too).
--    Every existing asset already uses one of the six built-in keys or none,
--    so no row is changed.
--  - Row level security like the other Marketing Hub tables: readable by
--    employees with the Marketing feature; the app writes through the server.
--  - Safe to run more than once.

begin;

do $$
begin
  if to_regclass('public.marketing_assets') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'marketing_assets' and column_name = 'category') then
    raise exception 'Run marketing_sales.sql and ad_library.sql first (marketing_assets.category is missing).';
  end if;
end $$;

-- 1) The table ----------------------------------------------------------------------
create table if not exists asset_categories (
  key text primary key,
  label text not null,
  sort_order integer not null default 100,
  is_builtin boolean not null default false,
  created_by_name text,
  created_at timestamptz not null default now(),
  constraint asset_categories_key_ok check (key ~ '^[a-z0-9_]{1,40}$'),
  constraint asset_categories_label_ok check (char_length(label) between 1 and 60 and label = btrim(label)),
  constraint asset_categories_created_by_len check (created_by_name is null or char_length(created_by_name) <= 200)
);
create unique index if not exists asset_categories_label_unique on asset_categories (lower(label));

-- 2) The six built-ins, only the first time ---------------------------------------
insert into asset_categories (key, label, sort_order, is_builtin)
select v.key, v.label, v.sort_order, true
from (values
  ('product', 'Product', 10),
  ('group_product', 'Group product', 20),
  ('ingredient', 'Ingredient', 30),
  ('market', 'Markets', 40),
  ('retail', 'Retail', 50),
  ('other', 'Other', 1000)
) as v(key, label, sort_order)
where not exists (select 1 from asset_categories);

-- 3) Assets point at a category row --------------------------------------------------
alter table marketing_assets drop constraint if exists marketing_assets_category_ok;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'marketing_assets_category_fk') then
    alter table marketing_assets add constraint marketing_assets_category_fk
      foreign key (category) references asset_categories(key) on update restrict on delete restrict;
  end if;
end $$;
create index if not exists marketing_assets_category_idx on marketing_assets (category);

-- 4) Row level security -----------------------------------------------------------------
alter table asset_categories enable row level security;
revoke all on asset_categories from anon;
revoke insert, update, delete, truncate on asset_categories from authenticated;
grant select on asset_categories to authenticated;
grant all on asset_categories to service_role;
drop policy if exists asset_categories_select on asset_categories;
create policy asset_categories_select on asset_categories for select to authenticated
  using (is_active_employee() and has_feature('growth.marketing'));

commit;
