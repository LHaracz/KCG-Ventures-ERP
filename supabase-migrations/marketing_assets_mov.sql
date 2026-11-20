-- Marketing Hub assets: MOV (QuickTime) uploads.
-- Run in the Supabase SQL editor BEFORE deploying the code that uses it, and
-- after marketing_assets_media.sql.
--
-- What this file does:
--  - Widens the rule marketing_assets_source_ok once more: uploads may also be
--    video/quicktime (MOV), up to 200 MB like MP4. The rule is dropped and
--    added back in one transaction; every existing row already passes it.
--  - Adds video/quicktime to the private "marketing-assets" bucket's allowed
--    types, keeping every type it allows today. The size limit is unchanged.
--    The Supabase GLOBAL file size limit (Storage > Settings; 50 MB on the
--    Free plan) still applies and wins over the bucket's limit.
--  - No new columns, tables or policies, and no existing rows are changed.
--    Safe to run more than once.

begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'marketing_assets' and column_name = 'poster_path'
  ) then
    raise exception 'Run marketing_assets_media.sql first (marketing_assets.poster_path is missing).';
  end if;
end $$;

alter table marketing_assets drop constraint if exists marketing_assets_source_ok;
alter table marketing_assets add constraint marketing_assets_source_ok check (
  (source = 'upload' and file_path is not null and url is null
    and mime_type in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf',
                      'image/heic', 'image/heif', 'image/gif', 'video/mp4', 'video/quicktime')
    and size_bytes between 1 and 209715200)
  or (source = 'link' and url is not null and file_path is null));

-- (A null list means "any type" and is left null.)
update storage.buckets
set allowed_mime_types = case when allowed_mime_types is null then null else array(
      select distinct t from unnest(allowed_mime_types || array['video/quicktime']) as t order by t) end
where id = 'marketing-assets';

commit;
