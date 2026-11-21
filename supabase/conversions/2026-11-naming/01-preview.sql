-- Marketing Hub naming conversion, step 1: preview (SELECT only, changes nothing).
-- One result table, sorted by section:
--   1 Subtopic letter      every subtopic and the letter it gets
--   2 Post                 every post, its current name, the proposed name and its group
--   3 Group                posts per group and the highest number
--   4 No subtopic          posts with no subtopic (named "{topic letter}-{n}")
--   5 PROBLEM ...          must be empty: a post whose subtopic is in another
--                          topic, a topic with more than 26 subtopics, or a
--                          duplicate proposed name. 02-apply.sql refuses to
--                          run while any of these exist.
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
),
codes as (
  select s.id, s.pillar_id, s.name, s.code as current_code, coalesce(s.code, f.l) as code
  from content_series s
  left join todo t on t.id = s.id
  left join free f on f.pillar_id = t.pillar_id and f.rn = t.rn
),
mismatched as (
  select p.id from premade_posts p join content_series s on s.id = p.series_id where s.pillar_id <> p.pillar_id
),
grp_max as (
  select pillar_id, series_id, coalesce(max(post_number), 0) as mx from premade_posts group by pillar_id, series_id
),
unnumbered as (
  select p.id,
    row_number() over (
      partition by p.pillar_id, p.series_id
      order by case when p.series_id is not null then (p.series_position is null)::int else 0 end,
               case when p.series_id is not null then p.series_position end nulls last,
               p.sort_order, p.created_at, p.id) as rn
  from premade_posts p
  where p.post_number is null and p.id not in (select id from mismatched)
),
plan as (
  select p.id, p.pillar_id, p.series_id, p.archived_at,
    c.code as pillar_code, c.name as pillar_name, k.code as series_code, k.name as series_name,
    case when p.post_number is not null then premade_post_name(c.code, k.current_code, p.post_number)
         else c.code || ' - ' || coalesce(p.title, '') end as current_name,
    coalesce(p.post_number, g.mx + u.rn) as number
  from premade_posts p
  join content_pillars c on c.id = p.pillar_id
  left join codes k on k.id = p.series_id
  left join grp_max g on g.pillar_id = p.pillar_id and g.series_id is not distinct from p.series_id
  left join unnumbered u on u.id = p.id
  where p.id not in (select id from mismatched)
),
named as (
  select *, premade_post_name(pillar_code, series_code, number::int) as proposed_name from plan
),
rows as (
  select 1 as sort_section, 'Subtopic letter' as section, c.code as topic, k.name as subtopic,
         coalesce(k.current_code, '(none)') as current_name, k.code as proposed_name, '' as detail, k.code as sort_key
  from codes k join content_pillars c on c.id = k.pillar_id
  union all
  select 2, 'Post', pillar_code || ' · ' || pillar_name, coalesce(series_code || ' · ' || series_name, 'No subtopic'),
         current_name, proposed_name, case when archived_at is not null then 'archived (number kept reserved)' else '' end,
         lpad(number::text, 6, '0')
  from named
  union all
  select 3, 'Group', pillar_code || ' · ' || pillar_name, coalesce(series_code || ' · ' || series_name, 'No subtopic'),
         count(*)::text || ' posts', 'highest number ' || max(number)::text, '', coalesce(series_code, '')
  from named group by pillar_code, pillar_name, series_code, series_name
  union all
  select 4, 'No subtopic', pillar_code || ' · ' || pillar_name, 'No subtopic', current_name, proposed_name, '', lpad(number::text, 6, '0')
  from named where series_id is null
  union all
  select 5, 'PROBLEM: subtopic belongs to another topic', c.code, s.name,
         c.code || ' - ' || coalesce(p.title, ''), '', 'post topic ' || c.code || ', subtopic topic ' || c2.code, ''
  from premade_posts p
  join content_pillars c on c.id = p.pillar_id
  join content_series s on s.id = p.series_id
  join content_pillars c2 on c2.id = s.pillar_id
  where s.pillar_id <> p.pillar_id
  union all
  select 5, 'PROBLEM: more than 26 subtopics', c.code || ' · ' || c.name, '', count(*)::text || ' subtopics', '', '', ''
  from content_series s join content_pillars c on c.id = s.pillar_id
  group by c.code, c.name having count(*) > 26
  union all
  select 5, 'PROBLEM: duplicate proposed name', '', '', string_agg(current_name, ' | '), proposed_name, count(*)::text || ' posts', proposed_name
  from named where archived_at is null
  group by proposed_name having count(*) > 1
)
select section, topic, subtopic, current_name, proposed_name, detail
from rows
order by sort_section, topic, subtopic, sort_key, current_name;
