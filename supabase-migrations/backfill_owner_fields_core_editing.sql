-- Backfill legacy rows missing user_id for core editing tables.
-- Run in Supabase SQL Editor after reviewing audit_owner_fields_core_editing.sql.
--
-- IMPORTANT:
-- 1) Replace the UUID in target_user_id with the correct owner account.
-- 2) This script ONLY updates rows where user_id is NULL.

begin;

with params as (
  select '00000000-0000-0000-0000-000000000000'::uuid as target_user_id
)
update public.microgreens m
set user_id = p.target_user_id
from params p
where m.user_id is null;

with params as (
  select '00000000-0000-0000-0000-000000000000'::uuid as target_user_id
)
update public.products pr
set user_id = p.target_user_id
from params p
where pr.user_id is null;

with params as (
  select '00000000-0000-0000-0000-000000000000'::uuid as target_user_id
)
update public.bom_lines b
set user_id = p.target_user_id
from params p
where b.user_id is null;

with params as (
  select '00000000-0000-0000-0000-000000000000'::uuid as target_user_id
)
update public.freeze_dryer_profiles fp
set user_id = p.target_user_id
from params p
where fp.user_id is null;

with params as (
  select '00000000-0000-0000-0000-000000000000'::uuid as target_user_id
)
update public.freeze_dryer_machine_settings fms
set user_id = p.target_user_id
from params p
where fms.user_id is null;

commit;

-- Post-backfill verification
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
