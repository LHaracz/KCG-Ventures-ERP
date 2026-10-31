-- Editable SOP documents with a live Formula Table.
-- Run in the Supabase SQL editor AFTER compliance_sops.sql and formulation.sql.
-- Idempotent: safe to run more than once.
--
-- Additive only. The single allowed relaxation is dropping NOT NULL on
-- sop_versions.file_path / original_filename / file_size_bytes, because
-- document versions have no file. No column is dropped or renamed.
--
-- Published versions are immutable: triggers reject DELETE on sop_versions
-- and any UPDATE that changes a column other than is_current.

-- 1) sops: document format, linked product, one autosaved draft per SOP ---
alter table sops add column if not exists format text not null default 'pdf';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sops_format_check') then
    alter table sops add constraint sops_format_check check (format in ('pdf', 'document'));
  end if;
end $$;
alter table sops add column if not exists product_id uuid references products(id) on delete set null;
alter table sops add column if not exists draft_content jsonb;
alter table sops add column if not exists draft_revision integer not null default 0;
alter table sops add column if not exists draft_updated_at timestamptz;
alter table sops add column if not exists draft_updated_by uuid;
alter table sops add column if not exists draft_base_version_id uuid;
create index if not exists idx_sops_product_id on sops(product_id);

-- 2) sop_versions: document content + frozen formula snapshot ------------
alter table sop_versions alter column file_path drop not null;
alter table sop_versions alter column original_filename drop not null;
alter table sop_versions alter column file_size_bytes drop not null;

alter table sop_versions add column if not exists content jsonb;
alter table sop_versions add column if not exists formula_snapshot jsonb;
-- Existing rows (all PDF uploads) get 'upload'; every new insert sets it explicitly.
alter table sop_versions add column if not exists source text not null default 'upload';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sop_versions_source_check') then
    alter table sop_versions add constraint sop_versions_source_check
      check (source in ('upload', 'editor', 'auto_formula_update', 'migration'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sop_versions_has_body_check') then
    alter table sop_versions add constraint sop_versions_has_body_check
      check (file_path is not null or content is not null);
  end if;
end $$;
alter table sop_versions add column if not exists published_by_name text;
alter table sop_versions add column if not exists search_text text;
-- No FK on purpose: a formulation row's lifecycle must never touch a published version.
alter table sop_versions add column if not exists trigger_formulation_id uuid;

create unique index if not exists idx_sop_versions_one_auto_per_formulation
  on sop_versions(sop_id, trigger_formulation_id)
  where trigger_formulation_id is not null;

-- 3) sop_formula_refs: which products each SOP's CURRENT version uses ----
--    Rewritten on every publish by flipping `active` (never deleted).
create table if not exists sop_formula_refs (
  sop_id uuid not null references sops(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (sop_id, product_id)
);
create index if not exists idx_sop_formula_refs_product on sop_formula_refs(product_id) where active;

alter table sop_formula_refs enable row level security;
drop policy if exists sop_formula_refs_shared_policy on sop_formula_refs;
create policy sop_formula_refs_shared_policy on sop_formula_refs
  for select using (auth.role() = 'authenticated');
grant select on table sop_formula_refs to authenticated;

-- 4) sop_images + private "sop-images" bucket -----------------------------
create table if not exists sop_images (
  id uuid primary key default gen_random_uuid(),
  sop_id uuid not null references sops(id) on delete cascade,
  path text not null unique,
  original_filename text,
  file_size_bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists idx_sop_images_sop_id on sop_images(sop_id);
alter table sop_images enable row level security;
drop policy if exists sop_images_shared_policy on sop_images;
create policy sop_images_shared_policy on sop_images
  for select using (auth.role() = 'authenticated');
grant select on table sop_images to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sop-images', 'sop-images', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

-- 5) sop_migration_staging: authored bodies for the PDF conversion -------
--    Service role only: RLS on, no policies, no grants to app roles.
create table if not exists sop_migration_staging (
  id uuid primary key default gen_random_uuid(),
  sop_id uuid not null unique references sops(id) on delete cascade,
  slug text not null unique,
  source_version_id uuid not null,
  is_product_sop boolean not null default false,
  product_id uuid references products(id) on delete set null,
  content jsonb not null,
  approved boolean not null default false,
  applied_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A product SOP may hold formula tables for more than one product (e.g. two gum flavors).
alter table sop_migration_staging add column if not exists product_ids uuid[] not null default '{}';
alter table sop_migration_staging enable row level security;
revoke all on table sop_migration_staging from anon, authenticated;

-- 6) Immutability of published versions -----------------------------------
create or replace function sop_versions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    -- Only the automated test suite may remove its own throwaway rows,
    -- through sop_test_cleanup() below (service role only).
    if current_setting('kcg.sop_test_cleanup', true) = 'on'
       and exists (select 1 from sops s where s.id = old.sop_id and s.title like '[TEST] %') then
      return old;
    end if;
    raise exception 'Published SOP versions cannot be deleted.' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'is_current') is distinct from (to_jsonb(old) - 'is_current') then
    raise exception 'Published SOP versions are immutable (only is_current may change).' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_sop_versions_no_delete on sop_versions;
create trigger trg_sop_versions_no_delete before delete on sop_versions
  for each row execute function sop_versions_guard();
drop trigger if exists trg_sop_versions_immutable on sop_versions;
create trigger trg_sop_versions_immutable before update on sop_versions
  for each row execute function sop_versions_guard();

-- 7) Publish a version atomically -----------------------------------------
--    Creates version n+1, makes it current, rewrites sop_formula_refs and
--    (optionally) clears the draft, all in one transaction.
--    Returns the new version id, or NULL when an automatic version for the
--    same (sop, trigger formulation) already exists (idempotent).
create or replace function sop_publish_version(
  p_sop_id uuid,
  p_content jsonb,
  p_formula_snapshot jsonb,
  p_source text,
  p_published_by_name text,
  p_change_note text,
  p_effective_date date,
  p_search_text text,
  p_trigger_formulation_id uuid,
  p_product_ids uuid[],
  p_clear_draft boolean,
  p_expected_draft_revision integer,
  p_expected_current_version_id uuid,
  p_user_id uuid,
  p_set_format_document boolean,
  p_set_product_id uuid
) returns uuid
language plpgsql as $$
declare
  v_sop sops%rowtype;
  v_current_id uuid;
  v_next integer;
  v_new_id uuid;
begin
  select * into v_sop from sops where id = p_sop_id for update;
  if not found then
    raise exception 'SOP not found.' using errcode = 'P0002';
  end if;

  if p_trigger_formulation_id is not null and exists (
    select 1 from sop_versions where sop_id = p_sop_id and trigger_formulation_id = p_trigger_formulation_id
  ) then
    return null;
  end if;

  if p_expected_draft_revision is not null and v_sop.draft_revision <> p_expected_draft_revision then
    raise exception 'DRAFT_CONFLICT' using errcode = 'P0001';
  end if;

  select id into v_current_id from sop_versions where sop_id = p_sop_id and is_current;
  if p_expected_current_version_id is not null and v_current_id is distinct from p_expected_current_version_id then
    raise exception 'CURRENT_VERSION_CHANGED' using errcode = 'P0001';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next from sop_versions where sop_id = p_sop_id;

  update sop_versions set is_current = false where sop_id = p_sop_id and is_current;

  insert into sop_versions (
    sop_id, version_number, content, formula_snapshot, source, published_by_name,
    change_note, effective_date, search_text, trigger_formulation_id, is_current, uploaded_by
  ) values (
    p_sop_id, v_next, p_content, p_formula_snapshot, p_source, p_published_by_name,
    p_change_note, p_effective_date, p_search_text, p_trigger_formulation_id, true, p_user_id
  ) returning id into v_new_id;

  update sop_formula_refs set active = false, updated_at = now() where sop_id = p_sop_id and active;
  if p_product_ids is not null and array_length(p_product_ids, 1) > 0 then
    insert into sop_formula_refs (sop_id, product_id, active, updated_at)
    select p_sop_id, pid, true, now()
    from (select distinct unnest(p_product_ids) as pid) x
    where exists (select 1 from products p where p.id = x.pid)
    on conflict (sop_id, product_id) do update set active = true, updated_at = now();
  end if;

  update sops set
    format = case when p_set_format_document then 'document' else format end,
    product_id = coalesce(p_set_product_id, product_id),
    draft_content = case when p_clear_draft then null else draft_content end,
    draft_revision = case when p_clear_draft then draft_revision + 1 else draft_revision end,
    draft_updated_at = case when p_clear_draft then now() else draft_updated_at end,
    draft_updated_by = case when p_clear_draft then p_user_id else draft_updated_by end,
    draft_base_version_id = case when p_clear_draft then null else draft_base_version_id end
  where id = p_sop_id;

  return v_new_id;
exception
  when unique_violation then
    -- A concurrent automatic version for the same formulation won the race.
    if p_trigger_formulation_id is not null then
      return null;
    end if;
    raise;
end $$;

-- 8) Roll back a migrated SOP to its previous PDF version ------------------
--    Makes the given PDF version current again and sets format back to
--    'pdf'. Migrated versions stay as history.
create or replace function sop_rollback_to_version(p_sop_id uuid, p_version_id uuid) returns void
language plpgsql as $$
begin
  perform 1 from sops where id = p_sop_id for update;
  if not exists (select 1 from sop_versions where id = p_version_id and sop_id = p_sop_id and file_path is not null) then
    raise exception 'Target version is not a PDF version of this SOP.' using errcode = 'P0001';
  end if;
  update sop_versions set is_current = false where sop_id = p_sop_id and is_current and id <> p_version_id;
  update sop_versions set is_current = true where id = p_version_id;
  update sop_formula_refs set active = false, updated_at = now() where sop_id = p_sop_id and active;
  update sops set format = 'pdf' where id = p_sop_id;
end $$;

-- 9) Test-only cleanup (service role). Only touches SOPs titled "[TEST] ..." -
create or replace function sop_test_cleanup(p_sop_ids uuid[]) returns integer
language plpgsql as $$
declare v_count integer;
begin
  perform set_config('kcg.sop_test_cleanup', 'on', true);
  -- Versions first, while the parent rows (and their [TEST] titles) still exist.
  delete from sop_versions v using sops s
    where v.sop_id = s.id and s.id = any(p_sop_ids) and s.title like '[TEST] %';
  delete from sops where id = any(p_sop_ids) and title like '[TEST] %';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function sop_publish_version(uuid, jsonb, jsonb, text, text, text, date, text, uuid, uuid[], boolean, integer, uuid, uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function sop_rollback_to_version(uuid, uuid) from public, anon, authenticated;
revoke all on function sop_test_cleanup(uuid[]) from public, anon, authenticated;
grant execute on function sop_publish_version(uuid, jsonb, jsonb, text, text, text, date, text, uuid, uuid[], boolean, integer, uuid, uuid, boolean, uuid) to service_role;
grant execute on function sop_rollback_to_version(uuid, uuid) to service_role;
grant execute on function sop_test_cleanup(uuid[]) to service_role;

-- Reload the PostgREST schema cache so the new columns and functions are visible.
notify pgrst, 'reload schema';
