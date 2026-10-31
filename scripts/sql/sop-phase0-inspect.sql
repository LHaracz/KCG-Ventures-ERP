-- Read-only. Paste into the Supabase SQL editor and send back the result grid.
-- Lists NOT NULL / nullable columns on sops and sop_versions, plus any
-- existing triggers and functions that touch them.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('sops', 'sop_versions')
order by table_name, ordinal_position;

select event_object_table as table_name, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where event_object_schema = 'public' and event_object_table in ('sops', 'sop_versions', 'formulations', 'bom_lines');

select n.nspname as schema, p.proname as function_name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and (p.proname ilike '%sop%' or p.proname ilike '%formul%' or p.proname ilike '%bom%');
