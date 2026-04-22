-- Audit ownership completeness before re-enabling strict user-scoped reads.
-- Run in Supabase SQL Editor.

-- 1) Null ownership counts
select 'microgreens' as table_name, count(*) as null_user_id_rows
from public.microgreens
where user_id is null
union all
select 'products', count(*)
from public.products
where user_id is null
union all
select 'bom_lines', count(*)
from public.bom_lines
where user_id is null
union all
select 'freeze_dryer_profiles', count(*)
from public.freeze_dryer_profiles
where user_id is null
union all
select 'freeze_dryer_machine_settings', count(*)
from public.freeze_dryer_machine_settings
where user_id is null;

-- 2) Ownership distribution by user_id
select 'microgreens' as table_name, user_id, count(*) as rows_per_owner
from public.microgreens
group by user_id
order by table_name, rows_per_owner desc;

select 'products' as table_name, user_id, count(*) as rows_per_owner
from public.products
group by user_id
order by table_name, rows_per_owner desc;

select 'bom_lines' as table_name, user_id, count(*) as rows_per_owner
from public.bom_lines
group by user_id
order by table_name, rows_per_owner desc;

select 'freeze_dryer_profiles' as table_name, user_id, count(*) as rows_per_owner
from public.freeze_dryer_profiles
group by user_id
order by table_name, rows_per_owner desc;

select 'freeze_dryer_machine_settings' as table_name, user_id, count(*) as rows_per_owner
from public.freeze_dryer_machine_settings
group by user_id
order by table_name, rows_per_owner desc;
