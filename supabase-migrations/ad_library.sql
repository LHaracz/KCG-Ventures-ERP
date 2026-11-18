-- Marketing Hub: Ad Library (premade reels and picture posts), content
-- pillars and series, closing lines, the avoid list, posting windows and
-- rhythm, categorized assets with product and ingredient tags. Run in the
-- Supabase SQL editor BEFORE deploying the code. Needs marketing_sales.sql.
--
-- Safety rules this file follows:
--  - Additive only. New tables, one view, functions, triggers and policies.
--  - Existing tables changed: content_posts gets two nullable columns
--    (premade_post_id, premade_synced_at) and marketing_assets gets four
--    nullable columns (category, context_label, shot_date, is_full_lineup).
--    No existing row is updated. The only rows added to an existing-data
--    concern are links in the NEW table asset_product_links, copied from
--    marketing_assets.formulation_product_id (insert only).
--  - Nothing is hard-deleted by the app (rows are archived). No delete policy
--    for browser users; no anon access.
--  - Row level security on every new table: active employees with
--    growth.marketing (Admins pass). The avoid list is readable with
--    growth.marketing but only Admins change it.
--  - Contains no playbook content. The only seeded rows are two ingredient
--    tags (product facts).
--  - Safe to run more than once.

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.is_admin()') is null or to_regprocedure('public.has_feature(text)') is null
     or to_regprocedure('public.is_active_employee()') is null then
    raise exception 'Run the employee access migrations first (is_admin() / has_feature() are missing).';
  end if;
  if to_regclass('public.content_posts') is null or to_regclass('public.marketing_assets') is null
     or to_regclass('public.claims') is null or to_regprocedure('public.growth_touch_updated_at()') is null then
    raise exception 'Run marketing_sales.sql first (the Marketing Hub tables are missing).';
  end if;
end $$;

-- Validators for the jsonb arrays (immutable, used in check constraints).
create or replace function adlib_beats_ok(b jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(b) = 'array' and jsonb_array_length(b) <= 20 and not exists (
    select 1 from jsonb_array_elements(b) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'beat') is distinct from 'string'
       or char_length(e ->> 'beat') > 1000
       or (e ? 'time' and jsonb_typeof(e -> 'time') <> 'string')
       or char_length(coalesce(e ->> 'time', '')) > 20)
$$;

create or replace function adlib_needs_ok(n jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(n) = 'array' and jsonb_array_length(n) <= 20 and not exists (
    select 1 from jsonb_array_elements(n) e
    where jsonb_typeof(e) <> 'object'
       or char_length(coalesce(e ->> 'key', '')) not between 1 and 80
       or char_length(coalesce(e ->> 'label', '')) not between 1 and 120
       or coalesce(e ->> 'kind', '') not in ('graphic', 'photo', 'video', 'other')
       or coalesce(e ->> 'status', '') not in ('needed', 'ready')
       or char_length(coalesce(e ->> 'note', '')) > 200
       or (e ? 'asset_id' and e -> 'asset_id' <> 'null'::jsonb
           and coalesce(e ->> 'asset_id', '') !~ '^[0-9a-fA-F-]{36}$'))
$$;

create or replace function adlib_ranges_ok(r jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(r) = 'array' and jsonb_array_length(r) <= 6 and not exists (
    select 1 from jsonb_array_elements(r) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(e ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or char_length(coalesce(e ->> 'note', '')) > 60)
$$;

-- 1) Content pillars ------------------------------------------------------------
create table if not exists content_pillars (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  description text,
  recurring boolean not null default false,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_pillars_code_ok check (code ~ '^[A-Z]$'),
  constraint content_pillars_name_ok check (char_length(btrim(name)) between 1 and 100),
  constraint content_pillars_description_len check (description is null or char_length(description) <= 500),
  -- One letter per non-archived pillar. Deferrable so a re-lettering can swap
  -- letters inside one transaction (reletter_pillars below).
  constraint content_pillars_code_unique exclude using btree (code with =) where (archived_at is null)
    deferrable initially immediate
);
create unique index if not exists content_pillars_name_unique on content_pillars (lower(btrim(name))) where archived_at is null;

-- 2) Series ---------------------------------------------------------------------
create table if not exists content_series (
  id uuid primary key default gen_random_uuid(),
  pillar_id uuid not null references content_pillars(id) on delete restrict,
  name text not null,
  cover_text text,
  default_hashtags text,
  notes text,
  sort_order integer not null default 0,
  source_ref text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_series_name_ok check (char_length(btrim(name)) between 1 and 200),
  constraint content_series_len check (coalesce(char_length(cover_text), 0) <= 300 and coalesce(char_length(default_hashtags), 0) <= 1500
    and coalesce(char_length(notes), 0) <= 1000),
  constraint content_series_source_ref_unique unique (source_ref)
);
create unique index if not exists content_series_name_unique on content_series (lower(btrim(name)));

-- 3) Closing lines ----------------------------------------------------------------
create table if not exists closing_lines (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  used_with_note text,
  source_ref text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint closing_lines_text_ok check (char_length(btrim(text)) between 1 and 300),
  constraint closing_lines_note_len check (used_with_note is null or char_length(used_with_note) <= 100),
  constraint closing_lines_source_ref_unique unique (source_ref)
);
create unique index if not exists closing_lines_text_unique on closing_lines (lower(btrim(text))) where archived_at is null;

-- 4) Premade posts (the Ad Library) ------------------------------------------------
create table if not exists premade_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  picture_format text,
  business text not null default 'botaniqals',
  pillar_id uuid not null references content_pillars(id) on delete restrict,
  series_id uuid references content_series(id) on delete restrict,
  series_position integer,
  status text not null default 'idea',
  intent text not null default 'organic',
  is_recurring boolean not null default false,
  platforms text[] not null default '{}',
  products_mentioned text[] not null default '{}',
  hook text,
  caption text,
  hashtags text,
  cta_text text,
  style_tag text,
  duration_text text,
  duration_min_seconds integer,
  duration_max_seconds integer,
  script_beats jsonb not null default '[]'::jsonb,
  visual_direction text,
  why_it_converts text,
  visual_notes text,
  best_window_text text,
  best_window_why text,
  asset_needs jsonb not null default '[]'::jsonb,
  needs_customer_permission boolean not null default false,
  permission_confirmed_by_name text,
  permission_confirmed_at timestamptz,
  risky_ack_hash text,
  risky_ack_by_name text,
  risky_ack_at timestamptz,
  notes text,
  source_ref text,
  sort_order integer not null default 0,
  created_by_name text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint premade_posts_title_ok check (char_length(btrim(title)) between 1 and 150),
  constraint premade_posts_category_ok check (category in ('reel', 'picture_post')),
  constraint premade_posts_picture_format_ok check (picture_format is null or picture_format in ('carousel', 'single_image', 'story', 'unknown')),
  constraint premade_posts_business_ok check (business in ('botaniqals', 'minileaf', 'brand')),
  constraint premade_posts_status_ok check (status in ('idea', 'drafting', 'ready', 'paused')),
  constraint premade_posts_intent_ok check (intent in ('organic', 'paid', 'both')),
  constraint premade_posts_platforms_ok check (platforms <@ array['instagram', 'tiktok', 'facebook', 'youtube']::text[]),
  constraint premade_posts_products_ok check (cardinality(products_mentioned) <= 20),
  constraint premade_posts_series_position_ok check (series_position is null or series_position between 1 and 1000),
  constraint premade_posts_len check (
    coalesce(char_length(hook), 0) <= 300 and coalesce(char_length(caption), 0) <= 4000
    and coalesce(char_length(hashtags), 0) <= 1500 and coalesce(char_length(cta_text), 0) <= 200
    and coalesce(char_length(style_tag), 0) <= 60 and coalesce(char_length(duration_text), 0) <= 30
    and coalesce(char_length(visual_direction), 0) <= 2000 and coalesce(char_length(why_it_converts), 0) <= 2000
    and coalesce(char_length(visual_notes), 0) <= 500 and coalesce(char_length(best_window_text), 0) <= 200
    and coalesce(char_length(best_window_why), 0) <= 300 and coalesce(char_length(notes), 0) <= 2000
    and coalesce(char_length(permission_confirmed_by_name), 0) <= 200 and coalesce(char_length(risky_ack_by_name), 0) <= 200
    and coalesce(char_length(created_by_name), 0) <= 200 and coalesce(char_length(risky_ack_hash), 0) <= 100),
  constraint premade_posts_duration_ok check (
    (duration_min_seconds is null or duration_min_seconds between 0 and 3600)
    and (duration_max_seconds is null or duration_max_seconds between 0 and 3600)
    and (duration_min_seconds is null or duration_max_seconds is null or duration_min_seconds <= duration_max_seconds)),
  constraint premade_posts_beats_ok check (adlib_beats_ok(script_beats)),
  constraint premade_posts_needs_ok check (adlib_needs_ok(asset_needs)),
  constraint premade_posts_source_ref_unique unique (source_ref)
);
create unique index if not exists premade_posts_title_unique on premade_posts (pillar_id, lower(btrim(title))) where archived_at is null;
create index if not exists premade_posts_series_idx on premade_posts (series_id);

-- The display name "{pillar code} - {title}" is computed, never stored.
create or replace view premade_posts_named with (security_invoker = true) as
  select p.*, c.code as pillar_code, c.code || ' - ' || p.title as display_name
  from premade_posts p join content_pillars c on c.id = p.pillar_id;

create table if not exists premade_post_flags (
  id uuid primary key default gen_random_uuid(),
  premade_post_id uuid not null references premade_posts(id) on delete restrict,
  flag_key text not null,
  detail jsonb not null default '{}'::jsonb,
  dismissed_by_name text,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint premade_post_flags_key_ok check (flag_key in ('auto_name', 'pillar_assigned', 'format_review', 'product_renamed', 'typo_fixed')),
  constraint premade_post_flags_unique unique (premade_post_id, flag_key),
  constraint premade_post_flags_dismissed_ok check ((dismissed_at is null) = (dismissed_by_name is null))
);

create table if not exists premade_post_claims (
  premade_post_id uuid not null references premade_posts(id) on delete restrict,
  claim_id uuid not null references claims(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (premade_post_id, claim_id)
);
create table if not exists premade_post_assets (
  premade_post_id uuid not null references premade_posts(id) on delete restrict,
  asset_id uuid not null references marketing_assets(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (premade_post_id, asset_id)
);

-- 5) Avoid list (Admin-only writes) ---------------------------------------------------
create table if not exists avoid_phrases (
  id uuid primary key default gen_random_uuid(),
  phrase text not null,
  note text,
  source text not null default 'manual',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint avoid_phrases_phrase_ok check (char_length(btrim(phrase)) between 1 and 80),
  constraint avoid_phrases_note_len check (note is null or char_length(note) <= 200),
  constraint avoid_phrases_source_ok check (source in ('playbook', 'manual'))
);
create unique index if not exists avoid_phrases_phrase_unique on avoid_phrases (lower(btrim(phrase)));

-- 6) Posting windows, day notes, rhythm, reference notes ------------------------------------
create table if not exists posting_time_windows (
  id uuid primary key default gen_random_uuid(),
  day_of_week integer not null,
  platform text not null,
  window_text text,
  ranges jsonb not null default '[]'::jsonb,
  quality text not null default 'good',
  source text not null default 'playbook',
  updated_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posting_time_windows_day_ok check (day_of_week between 0 and 6),
  constraint posting_time_windows_platform_ok check (platform in ('instagram', 'tiktok', 'facebook')),
  constraint posting_time_windows_text_len check (window_text is null or char_length(window_text) <= 100),
  constraint posting_time_windows_ranges_ok check (adlib_ranges_ok(ranges)),
  constraint posting_time_windows_quality_ok check (quality in ('peak', 'good', 'weak', 'avoid', 'none')),
  constraint posting_time_windows_source_ok check (source in ('playbook', 'own_data')),
  constraint posting_time_windows_unique unique (day_of_week, platform)
);

create table if not exists posting_day_notes (
  day_of_week integer primary key,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posting_day_notes_day_ok check (day_of_week between 0 and 6),
  constraint posting_day_notes_len check (note is null or char_length(note) <= 500)
);

create table if not exists posting_rhythm (
  id uuid primary key default gen_random_uuid(),
  days integer[] not null default '{}',
  label text not null,
  pillar_ids uuid[] not null default '{}',
  active boolean not null default true,
  note text,
  source_ref text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posting_rhythm_days_ok check (days <@ array[0, 1, 2, 3, 4, 5, 6] and cardinality(days) between 1 and 7),
  constraint posting_rhythm_label_ok check (char_length(btrim(label)) between 1 and 200),
  constraint posting_rhythm_note_len check (note is null or char_length(note) <= 300),
  constraint posting_rhythm_pillars_ok check (cardinality(pillar_ids) <= 26),
  constraint posting_rhythm_source_ref_unique unique (source_ref)
);

create table if not exists reference_notes (
  key text primary key,
  body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reference_notes_key_ok check (key in ('best_times_source', 'paid_ads_note', 'ad_windows_note')),
  constraint reference_notes_len check (body is null or char_length(body) <= 3000)
);

-- 7) Asset categories and tags -------------------------------------------------------
create table if not exists asset_ingredient_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  archived_at timestamptz,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asset_ingredient_tags_name_ok check (char_length(btrim(name)) between 1 and 100)
);
create unique index if not exists asset_ingredient_tags_name_unique on asset_ingredient_tags (lower(btrim(name))) where archived_at is null;

create table if not exists asset_product_links (
  asset_id uuid not null references marketing_assets(id) on delete restrict,
  formulation_product_id uuid not null references formulation_products(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, formulation_product_id)
);
create table if not exists asset_ingredient_links (
  asset_id uuid not null references marketing_assets(id) on delete restrict,
  ingredient_tag_id uuid not null references asset_ingredient_tags(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, ingredient_tag_id)
);

-- 8) New nullable columns on two existing tables --------------------------------------------
alter table content_posts add column if not exists premade_post_id uuid references premade_posts(id) on delete set null;
alter table content_posts add column if not exists premade_synced_at timestamptz;
create index if not exists content_posts_premade_idx on content_posts (premade_post_id) where premade_post_id is not null;

alter table marketing_assets add column if not exists category text;
alter table marketing_assets add column if not exists context_label text;
alter table marketing_assets add column if not exists shot_date date;
alter table marketing_assets add column if not exists is_full_lineup boolean default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'marketing_assets_category_ok') then
    alter table marketing_assets add constraint marketing_assets_category_ok
      check (category is null or category in ('product', 'group_product', 'ingredient', 'market', 'retail', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'marketing_assets_context_label_len') then
    alter table marketing_assets add constraint marketing_assets_context_label_len
      check (context_label is null or char_length(context_label) <= 200);
  end if;
end $$;

-- 9) Backfill (insert only) and seed tags ----------------------------------------------------
-- Existing assets keep their row as is; their legacy product tag is copied
-- into the link table so it shows as a product tag.
insert into asset_product_links (asset_id, formulation_product_id)
select id, formulation_product_id from marketing_assets where formulation_product_id is not null
on conflict do nothing;

insert into asset_ingredient_tags (name)
select v.name from (values ('Nano-hydroxyapatite'), ('Birch xylitol')) as v(name)
where not exists (select 1 from asset_ingredient_tags t where lower(btrim(t.name)) = lower(v.name) and t.archived_at is null);

-- 10) Re-letter pillars in one transaction (letters stay unique at commit) --------------------
-- p_codes: {"<pillar id>": "B", ...}. Called by the server (service role).
create or replace function reletter_pillars(p_codes jsonb) returns void
language plpgsql as $$
begin
  set constraints content_pillars_code_unique deferred;
  update content_pillars c set code = p_codes ->> c.id::text
  where p_codes ? c.id::text and c.code is distinct from (p_codes ->> c.id::text);
  set constraints content_pillars_code_unique immediate;
end $$;
revoke all on function reletter_pillars(jsonb) from public, anon, authenticated;
grant execute on function reletter_pillars(jsonb) to service_role;

-- 11) updated_at triggers -------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['content_pillars', 'content_series', 'closing_lines', 'premade_posts', 'premade_post_flags',
    'premade_post_claims', 'premade_post_assets', 'avoid_phrases', 'posting_time_windows', 'posting_day_notes',
    'posting_rhythm', 'reference_notes', 'asset_ingredient_tags', 'asset_product_links', 'asset_ingredient_links'] loop
    execute format('drop trigger if exists %I on %I', t || '_touch_updated_at', t);
    execute format('create trigger %I before update on %I for each row execute function growth_touch_updated_at()', t || '_touch_updated_at', t);
  end loop;
end $$;

-- 12) Row level security --------------------------------------------------------------------
do $$
declare
  t text;
  v_check text := 'is_active_employee() and has_feature(''growth.marketing'')';
begin
  foreach t in array array['content_pillars', 'content_series', 'closing_lines', 'premade_posts', 'premade_post_flags',
    'premade_post_claims', 'premade_post_assets', 'posting_time_windows', 'posting_day_notes', 'posting_rhythm',
    'reference_notes', 'asset_ingredient_tags', 'asset_product_links', 'asset_ingredient_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke delete, truncate on %I from authenticated', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('create policy %I on %I for select to authenticated using (%s)', t || '_select', t, v_check);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (%s)', t || '_insert', t, v_check);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('create policy %I on %I for update to authenticated using (%s) with check (%s)', t || '_update', t, v_check, v_check);
  end loop;

  -- Avoid list: readable with growth.marketing; only Admins add or change it.
  alter table avoid_phrases enable row level security;
  revoke all on avoid_phrases from anon;
  revoke delete, truncate on avoid_phrases from authenticated;
  grant select, insert, update on avoid_phrases to authenticated;
  grant all on avoid_phrases to service_role;
  drop policy if exists avoid_phrases_select on avoid_phrases;
  create policy avoid_phrases_select on avoid_phrases for select to authenticated
    using (is_active_employee() and (has_feature('growth.marketing') or is_admin()));
  drop policy if exists avoid_phrases_insert on avoid_phrases;
  create policy avoid_phrases_insert on avoid_phrases for insert to authenticated with check (is_active_employee() and is_admin());
  drop policy if exists avoid_phrases_update on avoid_phrases;
  create policy avoid_phrases_update on avoid_phrases for update to authenticated
    using (is_active_employee() and is_admin()) with check (is_active_employee() and is_admin());
end $$;

revoke all on premade_posts_named from anon;
grant select on premade_posts_named to authenticated, service_role;
