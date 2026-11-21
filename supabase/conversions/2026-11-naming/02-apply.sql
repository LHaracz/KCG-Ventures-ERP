-- Marketing Hub naming conversion, step 2: apply. One transaction.
-- Run 00-backup.sql and review 01-preview.sql first.
--  1. Gives every subtopic without a letter the next unused letter in its
--     topic, in the order sort_order, created_at, id.
--  2. Numbers every post without a number inside its topic-and-subtopic
--     group (archived posts too, so their numbers stay reserved): posts with a
--     subtopic by series_position (empty last), sort_order, created_at, id;
--     posts without one by sort_order, created_at, id. Numbers continue after
--     any already used. The old display name becomes the first entry of
--     name_history.
--  3. Sets each group's counter to the highest number used.
--  4. Dismisses open "Auto name" flags (by "System conversion").
--  5. Changes no caption, hook, hashtag, title or other content, and deletes
--     nothing.
-- It records itself in naming_conversion_log; running it again does nothing.
-- It refuses to run if a post's subtopic belongs to another topic or a topic
-- has more than 26 subtopics (see the PROBLEM rows in 01-preview.sql).
begin;

create table if not exists naming_conversion_log (
  key text primary key,
  ran_at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb
);
alter table naming_conversion_log enable row level security;
revoke all on naming_conversion_log from anon, authenticated;

do $$
declare
  v_letters integer := 0;
  v_numbered integer := 0;
  v_flags integer := 0;
  v_bad integer;
begin
  if exists (select 1 from naming_conversion_log where key = '2026-11-naming') then
    raise notice 'The naming conversion already ran on %. Nothing changed.', (select ran_at from naming_conversion_log where key = '2026-11-naming');
    return;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'premade_posts' and column_name = 'post_number') then
    raise exception 'Run supabase-migrations/marketing_naming.sql first.';
  end if;
  select count(*) into v_bad from premade_posts p join content_series s on s.id = p.series_id where s.pillar_id <> p.pillar_id;
  if v_bad > 0 then
    raise exception '% post(s) have a subtopic that belongs to another topic. Fix them first (see 01-preview.sql). Nothing changed.', v_bad;
  end if;
  select count(*) into v_bad from (select pillar_id from content_series group by pillar_id having count(*) > 26) x;
  if v_bad > 0 then
    raise exception '% topic(s) have more than 26 subtopics. Nothing changed.', v_bad;
  end if;

  -- 1) Subtopic letters
  with letters as (
    select chr(65 + g) as l, g from generate_series(0, 25) g
  ),
  free as (
    select p.id as pillar_id, l.l, row_number() over (partition by p.id order by l.g) as rn
    from content_pillars p cross join letters l
    where not exists (select 1 from content_series s where s.pillar_id = p.id and s.code = l.l)
  ),
  todo as (
    select s.id, s.pillar_id, row_number() over (partition by s.pillar_id order by s.sort_order, s.created_at, s.id) as rn
    from content_series s where s.code is null
  )
  update content_series s set code = f.l
  from todo t join free f on f.pillar_id = t.pillar_id and f.rn = t.rn
  where s.id = t.id;
  get diagnostics v_letters = row_count;

  -- 2) Post numbers
  with grp_max as (
    select pillar_id, series_id, coalesce(max(post_number), 0) as mx from premade_posts group by pillar_id, series_id
  ),
  unnumbered as (
    select p.id, p.pillar_id, p.series_id,
      row_number() over (
        partition by p.pillar_id, p.series_id
        order by case when p.series_id is not null then (p.series_position is null)::int else 0 end,
                 case when p.series_id is not null then p.series_position end nulls last,
                 p.sort_order, p.created_at, p.id) as rn
    from premade_posts p
    where p.post_number is null
  ),
  plan as (
    select u.id, g.mx + u.rn as number, c.code || ' - ' || coalesce(p.title, '') as old_name
    from unnumbered u
    join premade_posts p on p.id = u.id
    join content_pillars c on c.id = p.pillar_id
    join grp_max g on g.pillar_id = u.pillar_id and g.series_id is not distinct from u.series_id
  )
  update premade_posts p
  set post_number = plan.number,
      name_history = jsonb_build_array(jsonb_build_object('name', plan.old_name, 'changed_at', now())) || p.name_history
  from plan
  where p.id = plan.id;
  get diagnostics v_numbered = row_count;

  -- 3) Counters
  update content_series s set last_post_number = greatest(s.last_post_number, x.mx)
  from (select series_id, max(post_number) as mx from premade_posts where series_id is not null group by series_id) x
  where s.id = x.series_id;
  update content_pillars c set last_unsorted_post_number = greatest(c.last_unsorted_post_number, x.mx)
  from (select pillar_id, max(post_number) as mx from premade_posts where series_id is null group by pillar_id) x
  where c.id = x.pillar_id;

  -- 4) Auto name flags
  update premade_post_flags set dismissed_by_name = 'System conversion', dismissed_at = now()
  where flag_key = 'auto_name' and dismissed_at is null;
  get diagnostics v_flags = row_count;

  insert into naming_conversion_log (key, counts)
  values ('2026-11-naming', jsonb_build_object('subtopic_letters', v_letters, 'posts_numbered', v_numbered, 'flags_dismissed', v_flags));
  raise notice 'Subtopic letters assigned: %. Posts numbered: %. Auto name flags dismissed: %.', v_letters, v_numbered, v_flags;
end $$;

-- What changed (one row): counts from the log.
select key, ran_at, counts from naming_conversion_log where key = '2026-11-naming';

commit;
