-- Marketing Hub naming conversion, step 0: backup.
-- Copies premade_posts, content_series, content_pillars, premade_post_flags
-- and content_posts into new tables named with today's date (New York), for
-- example backup_20261121_premade_posts. Run it once per day; a second run
-- on the same day stops without changing anything. Contains no post text
-- itself; it only copies the tables.
do $$
declare
  v_day text := to_char(now() at time zone 'America/New_York', 'YYYYMMDD');
  t text;
  v_name text;
begin
  if to_regclass('public.premade_posts') is null then
    raise exception 'premade_posts is missing. Run the Marketing Hub migrations first.';
  end if;
  foreach t in array array['premade_posts', 'content_series', 'content_pillars', 'premade_post_flags', 'content_posts'] loop
    v_name := format('backup_%s_%s', v_day, t);
    if to_regclass('public.' || v_name) is not null then
      raise exception 'A backup from today already exists (%). Nothing was copied.', v_name;
    end if;
  end loop;
  foreach t in array array['premade_posts', 'content_series', 'content_pillars', 'premade_post_flags', 'content_posts'] loop
    v_name := format('backup_%s_%s', v_day, t);
    execute format('create table %I as table %I', v_name, t);
    execute format('alter table %I enable row level security', v_name);
    execute format('revoke all on %I from anon, authenticated', v_name);
    raise notice 'Copied % into %', t, v_name;
  end loop;
end $$;
