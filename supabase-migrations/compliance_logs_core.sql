-- Compliance Logs: core engine (Phase 1 of the Compliance Logs build).
-- Employee roster, the log-template engine (log_types / log_fields), and
-- entries/files/reviews. Receiving-specific tables, seeded templates, and
-- release-warnings tables are in their own migration files
-- (compliance_logs_receiving.sql, compliance_logs_seed_templates.sql,
-- compliance_logs_release_warnings.sql) — run this one first.
--
-- Follows this app's shared-data RLS convention (see
-- shared_reference_data_write_policies.sql / compliance_sops.sql): a single
-- "authenticated can do anything" policy per table, no per-row ownership
-- column. log_entries / log_entry_files / log_entry_reviews are the
-- exception — see the append-only section below.
--
-- Run in the Supabase SQL editor.

-- 1) employees -----------------------------------------------------------
-- A name-selection roster, not an authentication mechanism (the ERP has one
-- business login) — see the "Performed by" help text on every log form.
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  role_title text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_employees_active on employees(active);

alter table employees enable row level security;
drop policy if exists employees_shared_policy on employees;
create policy employees_shared_policy on employees
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Delete is allowed at the DB level; the Employees settings page only
-- offers it for an employee with zero log_entries/log_entry_reviews rows
-- and otherwise offers Deactivate instead (an app-level check, not a DB
-- constraint — deleting an employee who IS referenced is still safe
-- because performed_by_name / reviewed_by_name are snapshots that outlive
-- the employees row either way).
grant select, insert, update, delete on table employees to authenticated;

-- 2) log_types -------------------------------------------------------------
create table if not exists log_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  linked_sop_id uuid references sops(id) on delete set null,
  schedule_type text not null default 'none'
    constraint log_types_schedule_type_check
    check (schedule_type in ('none', 'daily', 'weekly', 'monthly', 'per_cycle')),
  -- Days of week for a 'daily' schedule, e.g. ["mon","tue","wed","thu","fri"].
  schedule_days jsonb not null default '["mon","tue","wed","thu","fri"]'::jsonb,
  include_in_release_check boolean not null default false,
  special_type text
    constraint log_types_special_type_check
    check (special_type is null or special_type = 'receiving'),
  is_seeded boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint log_types_slug_unique unique (slug)
);

create index if not exists idx_log_types_archived_at on log_types(archived_at);

alter table log_types enable row level security;
drop policy if exists log_types_shared_policy on log_types;
create policy log_types_shared_policy on log_types
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- No delete grant: a log type is never hard-deleted (archive only), so an
-- entry's log_type_id and template_snapshot stay meaningful forever.
grant select, insert, update on table log_types to authenticated;

-- 3) log_fields --------------------------------------------------------
create table if not exists log_fields (
  id uuid primary key default gen_random_uuid(),
  log_type_id uuid not null references log_types(id) on delete cascade,
  key text not null,
  label text not null,
  field_type text not null
    constraint log_fields_field_type_check
    check (field_type in (
      'text', 'longtext', 'number', 'select', 'checklist', 'date', 'datetime',
      'pass_fail', 'yes_no', 'employee', 'sop', 'production_cycle', 'raw_material'
    )),
  required boolean not null default false,
  options jsonb,
  min_value numeric,
  max_value numeric,
  unit text,
  help_text text,
  sort_order integer not null default 0,
  archived_at timestamptz,
  constraint log_fields_key_unique_per_type unique (log_type_id, key)
);

create index if not exists idx_log_fields_log_type_id on log_fields(log_type_id);

alter table log_fields enable row level security;
drop policy if exists log_fields_shared_policy on log_fields;
create policy log_fields_shared_policy on log_fields
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- No delete grant: a field that has ever collected data is archived, never
-- hard-deleted, so every past entry's template_snapshot stays explainable.
-- A field with zero entries against it can still be "removed" from the
-- builder by archiving it — the builder just doesn't expose a delete path.
grant select, insert, update on table log_fields to authenticated;

-- 4) log_entries -------------------------------------------------------
create table if not exists log_entries (
  id uuid primary key default gen_random_uuid(),
  log_type_id uuid not null references log_types(id) on delete restrict,
  entry_number integer not null,
  performed_at timestamptz not null default now(),
  performed_by_employee_id uuid references employees(id) on delete set null,
  performed_by_name text not null,
  values jsonb not null default '{}'::jsonb,
  template_snapshot jsonb not null default '{}'::jsonb,
  production_cycle_id uuid references production_cycles(id) on delete set null,
  is_out_of_spec boolean not null default false,
  out_of_spec_details jsonb,
  corrective_action text,
  corrects_entry_id uuid references log_entries(id) on delete set null,
  correction_reason text,
  created_at timestamptz not null default now(),
  created_by_account uuid references auth.users(id) on delete set null,
  constraint log_entries_number_unique_per_type unique (log_type_id, entry_number)
);

create index if not exists idx_log_entries_log_type_id on log_entries(log_type_id);
create index if not exists idx_log_entries_performed_at on log_entries(performed_at);
create index if not exists idx_log_entries_production_cycle_id on log_entries(production_cycle_id);
create index if not exists idx_log_entries_corrects_entry_id on log_entries(corrects_entry_id);
create index if not exists idx_log_entries_is_out_of_spec on log_entries(is_out_of_spec);

-- Assigns entry_number as "current max for this log_type + 1" on insert.
-- The advisory lock serializes concurrent inserts for the same log_type so
-- two near-simultaneous submissions can never collide on the same number
-- (the unique constraint above is the backstop if they somehow did).
create or replace function public.assign_log_entry_number()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.log_type_id::text));
  select coalesce(max(entry_number), 0) + 1 into new.entry_number
  from public.log_entries
  where log_type_id = new.log_type_id;
  return new;
end;
$$;

drop trigger if exists trg_assign_log_entry_number on public.log_entries;
create trigger trg_assign_log_entry_number
before insert on public.log_entries
for each row execute function public.assign_log_entry_number();

alter table log_entries enable row level security;
drop policy if exists log_entries_select_policy on log_entries;
create policy log_entries_select_policy on log_entries
  for select using (auth.role() = 'authenticated');
drop policy if exists log_entries_insert_policy on log_entries;
create policy log_entries_insert_policy on log_entries
  for insert with check (auth.role() = 'authenticated');

-- Append-only: no update, no delete, for anyone — "Correct this entry"
-- always inserts a new row linked via corrects_entry_id instead.
grant select, insert on table log_entries to authenticated;

-- 5) log_entry_files -----------------------------------------------------
create table if not exists log_entry_files (
  id uuid primary key default gen_random_uuid(),
  log_entry_id uuid not null references log_entries(id) on delete cascade,
  file_path text not null,
  original_filename text not null,
  file_size_bytes bigint not null,
  document_type text not null
    constraint log_entry_files_document_type_check
    check (document_type in ('coa', 'sds', 'invoice', 'spec_sheet', 'other')),
  label text,
  added_at timestamptz not null default now(),
  added_by_name text not null,
  added_after_submit boolean not null default false
);

create index if not exists idx_log_entry_files_log_entry_id on log_entry_files(log_entry_id);
create index if not exists idx_log_entry_files_document_type on log_entry_files(document_type);

alter table log_entry_files enable row level security;
drop policy if exists log_entry_files_select_policy on log_entry_files;
create policy log_entry_files_select_policy on log_entry_files
  for select using (auth.role() = 'authenticated');
drop policy if exists log_entry_files_insert_policy on log_entry_files;
create policy log_entry_files_insert_policy on log_entry_files
  for insert with check (auth.role() = 'authenticated');

grant select, insert on table log_entry_files to authenticated;

-- 6) log_entry_reviews -----------------------------------------------------
create table if not exists log_entry_reviews (
  id uuid primary key default gen_random_uuid(),
  log_entry_id uuid not null references log_entries(id) on delete cascade,
  reviewed_by_employee_id uuid references employees(id) on delete set null,
  reviewed_by_name text not null,
  reviewed_at timestamptz not null default now(),
  note text
);

create index if not exists idx_log_entry_reviews_log_entry_id on log_entry_reviews(log_entry_id);

alter table log_entry_reviews enable row level security;
drop policy if exists log_entry_reviews_select_policy on log_entry_reviews;
create policy log_entry_reviews_select_policy on log_entry_reviews
  for select using (auth.role() = 'authenticated');
drop policy if exists log_entry_reviews_insert_policy on log_entry_reviews;
create policy log_entry_reviews_insert_policy on log_entry_reviews
  for insert with check (auth.role() = 'authenticated');

grant select, insert on table log_entry_reviews to authenticated;

-- 7) Append-only enforcement, at the database level, per the build spec:
--    reject any UPDATE or DELETE on the three tables above outright, for
--    every role (including the service role used by API routes) — not
--    just RLS (RLS already omits UPDATE/DELETE policies above; this
--    trigger is the hard backstop even if a policy or grant ever drifted).
create or replace function public.reject_update_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Rows in % are append-only and cannot be updated or deleted.', TG_TABLE_NAME;
end;
$$;

drop trigger if exists trg_reject_update_delete on public.log_entries;
create trigger trg_reject_update_delete
before update or delete on public.log_entries
for each row execute function public.reject_update_delete();

drop trigger if exists trg_reject_update_delete on public.log_entry_files;
create trigger trg_reject_update_delete
before update or delete on public.log_entry_files
for each row execute function public.reject_update_delete();

drop trigger if exists trg_reject_update_delete on public.log_entry_reviews;
create trigger trg_reject_update_delete
before update or delete on public.log_entry_reviews
for each row execute function public.reject_update_delete();
