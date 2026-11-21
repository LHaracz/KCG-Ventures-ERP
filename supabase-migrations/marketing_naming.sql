-- Marketing Hub: short post names (topic letter + subtopic letter + number,
-- for example AA-1 or B-1), subtopics (the content_series table), hashtag
-- lists on subtopics and products, caption history, and schedule groups on
-- the calendar.
-- Run in the Supabase SQL editor BEFORE deploying the code that uses it, and
-- after ad_library.sql. Then run the files in
-- supabase/conversions/2026-11-naming/ (backup, preview, apply).
--
-- What this file changes (and nothing else):
--  - content_pillars: last_unsorted_post_number (not null, default 0).
--  - content_series: code (one letter, set by the conversion or when a
--    subtopic is created) and last_post_number; the subtopic name is now
--    unique per topic (was unique across all topics); a letter is unique per
--    topic (archived subtopics keep theirs); hashtags up to 2000 characters.
--  - premade_posts: title becomes optional (existing titles stay as the
--    imported title); the per-topic unique title index is dropped; captions
--    up to 100000 characters (a ceiling that only protects the database);
--    post_number and name_history; one number per topic and subtopic group
--    (archived posts included, so numbers are never reused).
--  - content_posts: schedule_group_id; the rule that scheduled or posted
--    entries need a caption now applies only to entries without a library
--    post (library entries read the caption live and freeze it at Posted).
--  - marketing_product_profiles: hashtags up to 2000 characters.
--  - New tables premade_post_products and premade_post_caption_history
--    (append-only), a trigger that saves the old caption whenever a caption
--    changes, and the functions create_subtopic, create_premade_post,
--    move_premade_posts, update_premade_caption, find_duplicate_post_names
--    and sync_calendar_titles.
--  - No existing row is changed by this file. Safe to run more than once.

begin;

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regclass('public.premade_posts') is null or to_regclass('public.content_series') is null
     or to_regclass('public.content_pillars') is null or to_regclass('public.content_posts') is null
     or to_regclass('public.marketing_product_profiles') is null then
    raise exception 'Run marketing_sales.sql and ad_library.sql first (the Marketing Hub tables are missing).';
  end if;
  if to_regprocedure('public.has_feature(text)') is null or to_regprocedure('public.is_active_employee()') is null then
    raise exception 'Run the employee access migrations first (has_feature() / is_active_employee() are missing).';
  end if;
end $$;

-- 1) content_pillars ------------------------------------------------------------
alter table content_pillars add column if not exists last_unsorted_post_number integer not null default 0;

-- 2) content_series (subtopics) ------------------------------------------------------
alter table content_series add column if not exists code text;
alter table content_series add column if not exists last_post_number integer not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'content_series_code_ok') then
    alter table content_series add constraint content_series_code_ok check (code is null or code ~ '^[A-Z]$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'content_series_counter_ok') then
    alter table content_series add constraint content_series_counter_ok check (last_post_number >= 0);
  end if;
end $$;
drop index if exists content_series_name_unique;
create unique index if not exists content_series_pillar_name_unique on content_series (pillar_id, lower(btrim(name))) where archived_at is null;
create unique index if not exists content_series_pillar_code_unique on content_series (pillar_id, code) where code is not null;
alter table content_series drop constraint if exists content_series_len;
alter table content_series add constraint content_series_len check (
  coalesce(char_length(cover_text), 0) <= 300 and coalesce(char_length(default_hashtags), 0) <= 2000
  and coalesce(char_length(notes), 0) <= 1000);

-- 3) premade_posts ---------------------------------------------------------------------
alter table premade_posts alter column title drop not null;
drop index if exists premade_posts_title_unique;
alter table premade_posts drop constraint if exists premade_posts_len;
alter table premade_posts add constraint premade_posts_len check (
  coalesce(char_length(hook), 0) <= 300 and coalesce(char_length(caption), 0) <= 100000
  and coalesce(char_length(hashtags), 0) <= 1500 and coalesce(char_length(cta_text), 0) <= 200
  and coalesce(char_length(style_tag), 0) <= 60 and coalesce(char_length(duration_text), 0) <= 30
  and coalesce(char_length(visual_direction), 0) <= 2000 and coalesce(char_length(why_it_converts), 0) <= 2000
  and coalesce(char_length(visual_notes), 0) <= 500 and coalesce(char_length(best_window_text), 0) <= 200
  and coalesce(char_length(best_window_why), 0) <= 300 and coalesce(char_length(notes), 0) <= 2000
  and coalesce(char_length(permission_confirmed_by_name), 0) <= 200 and coalesce(char_length(risky_ack_by_name), 0) <= 200
  and coalesce(char_length(created_by_name), 0) <= 200 and coalesce(char_length(risky_ack_hash), 0) <= 100);
alter table premade_posts add column if not exists post_number integer;
alter table premade_posts add column if not exists name_history jsonb not null default '[]'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'premade_posts_number_ok') then
    alter table premade_posts add constraint premade_posts_number_ok check (post_number is null or post_number >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'premade_posts_name_history_ok') then
    alter table premade_posts add constraint premade_posts_name_history_ok check (jsonb_typeof(name_history) = 'array');
  end if;
end $$;
create unique index if not exists premade_posts_group_number_unique
  on premade_posts (pillar_id, coalesce(series_id, '00000000-0000-0000-0000-000000000000'::uuid), post_number)
  where post_number is not null;

-- 4) content_posts ------------------------------------------------------------------------
alter table content_posts add column if not exists schedule_group_id uuid;
create index if not exists content_posts_schedule_group_idx on content_posts (schedule_group_id) where schedule_group_id is not null;
alter table content_posts drop constraint if exists content_posts_ready_caption;
alter table content_posts add constraint content_posts_ready_caption check (
  premade_post_id is not null
  or status not in ('ready', 'scheduled', 'posted')
  or char_length(btrim(coalesce(caption, ''))) > 0);

-- 5) marketing_product_profiles -------------------------------------------------------------
alter table marketing_product_profiles drop constraint if exists mpp_len;
alter table marketing_product_profiles add constraint mpp_len check (
  coalesce(char_length(tagline), 0) <= 150 and coalesce(char_length(short_description), 0) <= 300
  and coalesce(char_length(long_description), 0) <= 2000 and coalesce(char_length(label_ingredients), 0) <= 2000
  and coalesce(char_length(key_points), 0) <= 1500 and coalesce(char_length(hashtags), 0) <= 2000
  and coalesce(char_length(do_not_say), 0) <= 1000);

-- 6) New tables -------------------------------------------------------------------------------
create table if not exists premade_post_products (
  premade_post_id uuid not null references premade_posts(id) on delete restrict,
  formulation_product_id uuid not null references formulation_products(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (premade_post_id, formulation_product_id)
);

create table if not exists premade_post_caption_history (
  id uuid primary key default gen_random_uuid(),
  premade_post_id uuid not null references premade_posts(id) on delete restrict,
  caption text not null,
  changed_by_name text,
  changed_at timestamptz not null default now(),
  source text not null default 'other',
  constraint ppch_source_ok check (source in ('table_edit', 'form', 'restore', 'other')),
  constraint ppch_name_len check (changed_by_name is null or char_length(changed_by_name) <= 200)
);
create index if not exists ppch_post_idx on premade_post_caption_history (premade_post_id, changed_at desc);

-- Row level security, as in the rest of the hub: active employees with
-- growth.marketing read and add; nobody updates or deletes from the browser.
do $$
declare
  t text;
  v_check text := 'is_active_employee() and has_feature(''growth.marketing'')';
begin
  foreach t in array array['premade_post_products', 'premade_post_caption_history'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke update, delete, truncate on %I from authenticated', t);
    execute format('grant select, insert on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('create policy %I on %I for select to authenticated using (%s)', t || '_select', t, v_check);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (%s)', t || '_insert', t, v_check);
  end loop;
end $$;

-- 7) Caption history trigger ----------------------------------------------------------------
-- The update functions set app.actor_name (and app.caption_source) for their
-- own transaction with set_config(..., true).
create or replace function premade_caption_history_trg() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_src text := nullif(current_setting('app.caption_source', true), '');
begin
  if new.caption is distinct from old.caption and char_length(btrim(coalesce(old.caption, ''))) > 0 then
    insert into premade_post_caption_history (premade_post_id, caption, changed_by_name, source)
    values (
      old.id,
      old.caption,
      left(coalesce(nullif(btrim(current_setting('app.actor_name', true)), ''), 'Unknown'), 200),
      case when v_src in ('table_edit', 'form', 'restore', 'other') then v_src else 'other' end);
  end if;
  return new;
end $$;
drop trigger if exists premade_posts_caption_history on premade_posts;
create trigger premade_posts_caption_history after update of caption on premade_posts
  for each row execute function premade_caption_history_trg();

-- 8) Names ---------------------------------------------------------------------------------------
-- "AA-1" (topic letter, subtopic letter, number) or "B-1" (no subtopic).
create or replace function premade_post_name(p_pillar_code text, p_series_code text, p_number integer) returns text
language sql immutable as $$
  select p_pillar_code || coalesce(p_series_code, '') || '-' || p_number::text
$$;

-- The name a post shows now: the short name once numbered, otherwise the
-- old display name ("{letter} - {title}").
create or replace function premade_current_name(p_post_id uuid) returns text
language sql stable set search_path = public, pg_temp as $$
  select case
    when p.post_number is not null then premade_post_name(c.code, s.code, p.post_number)
    else c.code || ' - ' || coalesce(p.title, '')
  end
  from premade_posts p
  join content_pillars c on c.id = p.pillar_id
  left join content_series s on s.id = p.series_id
  where p.id = p_post_id
$$;

-- Server code calls these with the service role (the route has already
-- checked growth.marketing); anyone else needs the feature.
create or replace function growth_marketing_guard() returns void
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return;
  end if;
  if not (is_active_employee() and has_feature('growth.marketing')) then
    raise exception 'You don''t have access to the Marketing Hub.' using errcode = '42501';
  end if;
end $$;

-- 9) create_subtopic ------------------------------------------------------------------------------
-- Internal: takes the next unused letter in the topic (archived subtopics keep
-- theirs, so letters are never reused). The caller holds the topic's row lock.
create or replace function growth_new_subtopic(p_pillar_id uuid, p_name text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_code text;
  v_id uuid;
  v_sort integer;
begin
  if char_length(v_name) not between 1 and 200 then
    raise exception 'Enter a subtopic name (up to 200 characters).' using errcode = '22023';
  end if;
  select chr(65 + g) into v_code
  from generate_series(0, 25) g
  where chr(65 + g) not in (select s.code from content_series s where s.pillar_id = p_pillar_id and s.code is not null)
  order by g
  limit 1;
  if v_code is null then
    raise exception 'This topic already has 26 subtopics (A to Z). Archive is not enough: letters are never reused. Use another topic.' using errcode = '22023';
  end if;
  select coalesce(max(sort_order), 0) + 1 into v_sort from content_series where pillar_id = p_pillar_id;
  insert into content_series (pillar_id, name, code, sort_order)
  values (p_pillar_id, v_name, v_code, v_sort)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;

create or replace function create_subtopic(p_pillar_id uuid, p_name text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_pillar content_pillars%rowtype;
begin
  perform growth_marketing_guard();
  select * into v_pillar from content_pillars where id = p_pillar_id for update;
  if not found then
    raise exception 'Unknown topic.' using errcode = 'P0002';
  end if;
  if v_pillar.archived_at is not null then
    raise exception 'That topic is archived.' using errcode = '22023';
  end if;
  return growth_new_subtopic(p_pillar_id, p_name);
end $$;

-- 10) create_premade_post ------------------------------------------------------------------------
-- payload: { pillar_id, series_id | null, new_subtopic_name | null,
--   actor_name, post: {category, caption, hook, ...}, asset_ids: [], product_ids: [] }
create or replace function create_premade_post(payload jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_pillar content_pillars%rowtype;
  v_series_id uuid;
  v_series_code text;
  v_number integer;
  v_id uuid;
  v_post premade_posts%rowtype;
  v_new text := nullif(btrim(coalesce(payload ->> 'new_subtopic_name', '')), '');
  v_sub jsonb;
begin
  perform growth_marketing_guard();
  select * into v_pillar from content_pillars where id = (payload ->> 'pillar_id')::uuid for update;
  if not found then
    raise exception 'Choose a topic.' using errcode = 'P0002';
  end if;
  if v_pillar.archived_at is not null then
    raise exception 'That topic is archived. Choose an active topic.' using errcode = '22023';
  end if;
  if v_new is not null then
    v_sub := growth_new_subtopic(v_pillar.id, v_new);
    v_series_id := (v_sub ->> 'id')::uuid;
  else
    v_series_id := nullif(payload ->> 'series_id', '')::uuid;
  end if;
  if v_series_id is not null then
    update content_series set last_post_number = last_post_number + 1
    where id = v_series_id and pillar_id = v_pillar.id and archived_at is null
    returning last_post_number, code into v_number, v_series_code;
    if not found then
      raise exception 'Choose a subtopic of this topic.' using errcode = '22023';
    end if;
    if v_series_code is null then
      raise exception 'This subtopic has no letter yet. Run the naming conversion first.' using errcode = '22023';
    end if;
  else
    update content_pillars set last_unsorted_post_number = last_unsorted_post_number + 1
    where id = v_pillar.id
    returning last_unsorted_post_number into v_number;
  end if;

  v_post := jsonb_populate_record(null::premade_posts, coalesce(payload -> 'post', '{}'::jsonb));
  insert into premade_posts (
    title, category, picture_format, business, pillar_id, series_id, status, intent, products_mentioned,
    hook, caption, hashtags, cta_text, style_tag, duration_text, duration_min_seconds, duration_max_seconds,
    script_beats, visual_direction, why_it_converts, visual_notes, best_window_text, best_window_why,
    asset_needs, needs_customer_permission, notes, sort_order, created_by_name, post_number)
  values (
    v_post.title, v_post.category, v_post.picture_format, coalesce(v_post.business, 'botaniqals'), v_pillar.id, v_series_id,
    coalesce(v_post.status, 'drafting'), coalesce(v_post.intent, 'organic'), coalesce(v_post.products_mentioned, '{}'),
    v_post.hook, v_post.caption, v_post.hashtags, v_post.cta_text, v_post.style_tag, v_post.duration_text,
    v_post.duration_min_seconds, v_post.duration_max_seconds, coalesce(v_post.script_beats, '[]'::jsonb),
    v_post.visual_direction, v_post.why_it_converts, v_post.visual_notes, v_post.best_window_text, v_post.best_window_why,
    coalesce(v_post.asset_needs, '[]'::jsonb), coalesce(v_post.needs_customer_permission, false), v_post.notes, 0,
    nullif(left(btrim(coalesce(payload ->> 'actor_name', '')), 200), ''), v_number)
  returning id into v_id;

  insert into premade_post_assets (premade_post_id, asset_id)
  select distinct v_id, x::uuid from jsonb_array_elements_text(coalesce(payload -> 'asset_ids', '[]'::jsonb)) x;
  insert into premade_post_products (premade_post_id, formulation_product_id)
  select distinct v_id, x::uuid from jsonb_array_elements_text(coalesce(payload -> 'product_ids', '[]'::jsonb)) x;

  return jsonb_build_object('id', v_id, 'name', premade_post_name(v_pillar.code, v_series_code, v_number), 'series_id', v_series_id);
end $$;

-- 11) move_premade_posts ---------------------------------------------------------------------------
-- Moves posts to a topic (and subtopic, or none). Each gets the next number of
-- its new group, in the order of the current names; the old name goes into
-- name_history. Calendar entries that aren't Posted get the new name as their
-- stored title. Posts already in that group are left alone.
create or replace function move_premade_posts(p_post_ids uuid[], p_pillar_id uuid, p_subtopic_id uuid, p_new_subtopic_name text, p_actor_name text default null)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_pillar content_pillars%rowtype;
  v_series_id uuid := p_subtopic_id;
  v_series_code text;
  v_number integer;
  v_old text;
  v_new_name text;
  v_out jsonb := '[]'::jsonb;
  r record;
begin
  perform growth_marketing_guard();
  if coalesce(array_length(p_post_ids, 1), 0) = 0 then
    raise exception 'Select the posts first.' using errcode = '22023';
  end if;
  select * into v_pillar from content_pillars where id = p_pillar_id for update;
  if not found then
    raise exception 'Choose a topic.' using errcode = 'P0002';
  end if;
  if v_pillar.archived_at is not null then
    raise exception 'That topic is archived. Choose an active topic.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_new_subtopic_name, '')), '') is not null then
    v_series_id := (growth_new_subtopic(v_pillar.id, p_new_subtopic_name) ->> 'id')::uuid;
  end if;
  if v_series_id is not null then
    select code into v_series_code from content_series where id = v_series_id and pillar_id = v_pillar.id and archived_at is null;
    if not found then
      raise exception 'Choose a subtopic of this topic.' using errcode = '22023';
    end if;
    if v_series_code is null then
      raise exception 'This subtopic has no letter yet. Run the naming conversion first.' using errcode = '22023';
    end if;
  end if;
  if (select count(*) from premade_posts where id = any(p_post_ids)) <> (select count(distinct x) from unnest(p_post_ids) x) then
    raise exception 'Unknown library post.' using errcode = 'P0002';
  end if;

  for r in
    select p.id, p.pillar_id, p.series_id
    from premade_posts p
    join content_pillars c on c.id = p.pillar_id
    left join content_series s on s.id = p.series_id
    where p.id = any(p_post_ids)
    order by c.code, s.code nulls first, p.post_number nulls last, p.created_at, p.id
    for update of p
  loop
    if r.pillar_id = v_pillar.id and r.series_id is not distinct from v_series_id then
      continue;
    end if;
    v_old := premade_current_name(r.id);
    if v_series_id is not null then
      update content_series set last_post_number = last_post_number + 1 where id = v_series_id returning last_post_number into v_number;
    else
      update content_pillars set last_unsorted_post_number = last_unsorted_post_number + 1 where id = v_pillar.id returning last_unsorted_post_number into v_number;
    end if;
    update premade_posts
    set pillar_id = v_pillar.id,
        series_id = v_series_id,
        post_number = v_number,
        name_history = name_history || jsonb_build_array(jsonb_build_object('name', v_old, 'changed_at', now()))
    where id = r.id;
    v_new_name := premade_post_name(v_pillar.code, v_series_code, v_number);
    update content_posts set title = v_new_name where premade_post_id = r.id and status <> 'posted';
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'old_name', v_old, 'new_name', v_new_name));
  end loop;
  return v_out;
end $$;

-- 12) update_premade_caption ------------------------------------------------------------------------
-- Changes only the caption (and updated_at), and only if nobody changed the
-- post since the caller opened it.
create or replace function update_premade_caption(p_post_id uuid, p_expected_updated_at timestamptz, p_caption text, p_actor_name text, p_source text)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_updated timestamptz;
  v_cur record;
begin
  perform growth_marketing_guard();
  if char_length(coalesce(p_caption, '')) > 100000 then
    raise exception 'This caption is longer than 100000 characters.' using errcode = '22001';
  end if;
  if coalesce(p_source, '') not in ('table_edit', 'form', 'restore', 'other') then
    raise exception 'Unknown caption source.' using errcode = '22023';
  end if;
  perform set_config('app.actor_name', left(coalesce(p_actor_name, ''), 200), true);
  perform set_config('app.caption_source', p_source, true);
  -- Compared to the millisecond: browsers keep only milliseconds of a timestamp.
  update premade_posts set caption = nullif(p_caption, ''), updated_at = now()
  where id = p_post_id and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', p_expected_updated_at)
  returning updated_at into v_updated;
  if found then
    return jsonb_build_object('ok', true, 'updated_at', v_updated);
  end if;
  select caption, updated_at into v_cur from premade_posts where id = p_post_id;
  if not found then
    raise exception 'Unknown library post.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('conflict', true, 'current_caption', v_cur.caption, 'current_updated_at', v_cur.updated_at);
end $$;

-- 13) find_duplicate_post_names -------------------------------------------------------------------------
-- Returns [{ "name": "AA-1", "post_ids": [...] }, ...] for names shared by
-- more than one non-archived post (empty array when there are none).
drop function if exists find_duplicate_post_names();
create or replace function find_duplicate_post_names() returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform growth_marketing_guard();
  select coalesce(jsonb_agg(jsonb_build_object('name', d.name, 'post_ids', d.ids) order by d.name), '[]'::jsonb) into v
  from (
    select n.name, array_agg(n.id order by n.id) as ids
    from (
      select p.id, premade_post_name(c.code, s.code, p.post_number) as name
      from premade_posts p
      join content_pillars c on c.id = p.pillar_id
      left join content_series s on s.id = p.series_id
      where p.archived_at is null and p.post_number is not null
    ) n
    group by n.name
    having count(*) > 1
  ) d;
  return v;
end $$;

-- 14) sync_calendar_titles ------------------------------------------------------------------------------
-- After a topic letter changes: calendar entries that aren't Posted get the
-- post's current name as their stored title. Posted entries never change.
create or replace function sync_calendar_titles(p_post_ids uuid[] default null) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  perform growth_marketing_guard();
  update content_posts cp
  set title = left(premade_current_name(cp.premade_post_id), 200)
  where cp.premade_post_id is not null
    and cp.status <> 'posted'
    and (p_post_ids is null or cp.premade_post_id = any(p_post_ids))
    and cp.title is distinct from left(premade_current_name(cp.premade_post_id), 200);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- 15) Grants: server code only (service role), like reletter_pillars ---------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'growth_marketing_guard()', 'growth_new_subtopic(uuid, text)', 'create_subtopic(uuid, text)',
    'create_premade_post(jsonb)', 'move_premade_posts(uuid[], uuid, uuid, text, text)',
    'update_premade_caption(uuid, timestamptz, text, text, text)', 'find_duplicate_post_names()',
    'sync_calendar_titles(uuid[])'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function premade_caption_history_trg() from public, anon, authenticated;

commit;
