-- Marketing Hub assets: HEIC, GIF and MP4 uploads.
-- Run in the Supabase SQL editor BEFORE deploying the code that uses it, and
-- after marketing_sales.sql and ad_library.sql.
--
-- What this file does:
--  - Adds five nullable columns to marketing_assets: preview_path (the JPG
--    made from a HEIC), poster_path (a still frame of a GIF or MP4), width,
--    height and duration_seconds. Existing rows are not updated.
--  - Widens the existing rule marketing_assets_source_ok (approved change):
--    uploads may now also be image/heic, image/heif, image/gif and video/mp4,
--    up to 200 MB. The rule is dropped and added back in one transaction;
--    every existing row already passes it. Links are unchanged.
--  - Updates the private "marketing-assets" bucket: keeps every type it
--    allows today, adds the four new ones, and raises its size limit to
--    200 MB.
--    NOTE: Supabase also has a GLOBAL file size limit (Dashboard > Storage >
--    Settings). It is 50 MB on the Free plan, and it wins over this bucket
--    value: a file over the global limit is refused even if it is under
--    200 MB here.
--  - No new tables, no policy changes. Safe to run more than once.

begin;

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regclass('public.marketing_assets') is null then
    raise exception 'Run marketing_sales.sql first (marketing_assets is missing).';
  end if;
end $$;

-- 1) New nullable columns -------------------------------------------------------
alter table marketing_assets add column if not exists preview_path text;
alter table marketing_assets add column if not exists poster_path text;
alter table marketing_assets add column if not exists width integer;
alter table marketing_assets add column if not exists height integer;
alter table marketing_assets add column if not exists duration_seconds numeric(10,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'marketing_assets_media_ok') then
    alter table marketing_assets add constraint marketing_assets_media_ok check (
      (preview_path is null or (source = 'upload' and preview_path = file_path || '.preview.jpg'))
      and (poster_path is null or (source = 'upload' and poster_path = file_path || '.poster.jpg'))
      and (width is null or width between 1 and 100000)
      and (height is null or height between 1 and 100000)
      and (duration_seconds is null or duration_seconds between 0 and 86400)
    );
  end if;
end $$;

-- 2) Widen the upload rule ------------------------------------------------------------
alter table marketing_assets drop constraint if exists marketing_assets_source_ok;
alter table marketing_assets add constraint marketing_assets_source_ok check (
  (source = 'upload' and file_path is not null and url is null
    and mime_type in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf',
                      'image/heic', 'image/heif', 'image/gif', 'video/mp4')
    and size_bytes between 1 and 209715200)
  or (source = 'link' and url is not null and file_path is null));

-- 3) The bucket: keep every allowed type, add the new ones, 200 MB -------------------
update storage.buckets
-- (A null list means "any type" and is left null.)
set allowed_mime_types = case when allowed_mime_types is null then null else array(
      select distinct t from unnest(
        allowed_mime_types || array['image/heic', 'image/heif', 'image/gif', 'video/mp4']
      ) as t order by t) end,
    file_size_limit = 209715200
where id = 'marketing-assets';

commit;
