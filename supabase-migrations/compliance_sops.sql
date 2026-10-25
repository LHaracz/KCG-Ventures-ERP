-- Compliance: SOP Library.
-- Private Storage bucket + two tables (sops, sop_versions). No existing
-- storage bucket was found anywhere in this app (grepped for `.storage.`
-- and scanned supabase-migrations/) — this is the first one. Follows the
-- same RLS convention as every other recent migration here (see
-- sales_data_variant_mapping.sql, botaniqals_optimization.sql): a single
-- `..._shared_policy` requiring just an authenticated session, no
-- per-row ownership column except where it's useful for attribution
-- (created_by / uploaded_by).
--
-- Run in the Supabase SQL editor.

-- 1) Storage bucket. PRIVATE — public is explicitly false and stays that
--    way. All reads/writes go through the API routes using the service
--    role key (supabaseAdmin), which bypasses bucket RLS entirely, so the
--    policies below are belt-and-suspenders documentation of the intended
--    access model rather than the actual enforcement path. 25 MB cap
--    matches the app-level validation in src/lib/sopStorage.ts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sops', 'sops', false, 26214400, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = 26214400,
  allowed_mime_types = array['application/pdf'];

drop policy if exists sops_bucket_shared_policy on storage.objects;
create policy sops_bucket_shared_policy on storage.objects
  for all using (bucket_id = 'sops' and auth.role() = 'authenticated')
  with check (bucket_id = 'sops' and auth.role() = 'authenticated');

-- 2) sops: one row per SOP document (its identity/metadata). The actual
--    file content lives only in sop_versions — a SOP with zero versions
--    shouldn't normally exist (the "new SOP" route creates both rows
--    together), but nothing here forbids it since a version row always
--    needs a real uploaded file first.
create table if not exists sops (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  sop_number text,
  description text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_sops_archived_at on sops(archived_at);

alter table sops enable row level security;
drop policy if exists sops_shared_policy on sops;
create policy sops_shared_policy on sops
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

grant select, insert, update on table sops to authenticated;

-- 3) sop_versions: one row per uploaded file for a SOP. file_path is the
--    Storage object path within the `sops` bucket (never a public URL —
--    those are generated on demand, short-lived, via the signed-url
--    route). Previous versions' files are never overwritten or deleted;
--    "Upload New Version" always inserts a new row. The partial unique
--    index is the actual guarantee behind "only one version per SOP may
--    have is_current = true" — the app also flips the old current row to
--    false in the same request, but the index is what makes that
--    invariant impossible to violate even if that ever drifted.
create table if not exists sop_versions (
  id uuid primary key default gen_random_uuid(),
  sop_id uuid not null references sops(id) on delete cascade,
  version_number integer not null,
  file_path text not null,
  original_filename text not null,
  file_size_bytes bigint not null,
  effective_date date,
  change_note text,
  is_current boolean not null default false,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  constraint sop_versions_sop_version_unique unique (sop_id, version_number)
);

create index if not exists idx_sop_versions_sop_id on sop_versions(sop_id);

create unique index if not exists idx_sop_versions_one_current_per_sop
  on sop_versions(sop_id)
  where is_current = true;

alter table sop_versions enable row level security;
drop policy if exists sop_versions_shared_policy on sop_versions;
create policy sop_versions_shared_policy on sop_versions
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- No delete grant anywhere in this file, on purpose — there is no
-- permanent delete in this build (archive only), for either table.
grant select, insert, update on table sop_versions to authenticated;
