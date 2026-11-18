-- Marketing & Sales: Launch Pipeline, supplier lead times, Retail Prospecting,
-- Marketing Hub and Retail line sheets. Run in the Supabase SQL editor
-- BEFORE deploying the code.
--
-- Safety rules this file follows:
--  - Additive only. New tables, functions, triggers, policies and one private
--    storage bucket. The only existing table touched is raw_material_suppliers,
--    which gets two nullable columns (lead_time_days, lead_time_note).
--  - No existing column, function, policy or role assignment is changed.
--    Sales Data, Stats and Retail are untouched (their sidebar move is code only).
--  - Nothing is ever hard-deleted by the app: rows are archived, voided or
--    soft-deleted. No delete policy exists for browser users.
--  - Row level security on every new table: active employees with the group's
--    feature (has_feature(); Admins pass automatically), nothing for anon.
--    Line sheets are Admin only.
--  - Safe to run more than once.

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.is_admin()') is null or to_regprocedure('public.has_feature(text)') is null
     or to_regprocedure('public.is_active_employee()') is null then
    raise exception 'Run the employee access migrations first (is_admin() / has_feature() are missing).';
  end if;
  if to_regclass('public.raw_material_suppliers') is null then
    raise exception 'Run procurement_suppliers.sql first (raw_material_suppliers is missing).';
  end if;
  if to_regclass('public.formulation_products') is null then
    raise exception 'Run formulation.sql first (formulation_products is missing).';
  end if;
  if to_regclass('public.retailers') is null or to_regclass('public.company_profiles') is null then
    raise exception 'Run retail_invoices.sql first (retailers is missing).';
  end if;
  if to_regclass('public.products') is null or to_regclass('public.inventory_items') is null
     or to_regclass('public.employee_accounts') is null then
    raise exception 'products, inventory_items or employee_accounts is missing.';
  end if;
end $$;

-- Shared trigger: keep updated_at current.
create or replace function growth_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Only http or https URLs, no spaces, at most 2000 characters.
create or replace function growth_url_ok(u text) returns boolean
language sql immutable as $$
  select u is null or (char_length(u) <= 2000 and u ~* '^https?://[^[:space:]]+$')
$$;

-- 1) Supplier lead times (raw_material_suppliers: two nullable columns) --------------------
alter table raw_material_suppliers add column if not exists lead_time_days integer;
alter table raw_material_suppliers add column if not exists lead_time_note text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rms_lead_time_days_range') then
    alter table raw_material_suppliers add constraint rms_lead_time_days_range
      check (lead_time_days is null or (lead_time_days between 0 and 365));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rms_lead_time_note_len') then
    alter table raw_material_suppliers add constraint rms_lead_time_note_len
      check (lead_time_note is null or char_length(lead_time_note) <= 200);
  end if;
end $$;

-- 2) Launch Pipeline ---------------------------------------------------------------------
create table if not exists launches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  formulation_product_id uuid references formulation_products(id) on delete set null,
  status text not null default 'planning',
  target_launch_date date not null,
  planned_test_batch_date date,
  test_batch_units numeric(14,3),
  buffer_days integer not null default 2,
  notes text,
  created_by_name text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint launches_name_ok check (char_length(btrim(name)) between 1 and 200),
  constraint launches_status_ok check (status in ('planning', 'active', 'launched', 'paused', 'cancelled')),
  constraint launches_units_ok check (test_batch_units is null or test_batch_units > 0),
  constraint launches_buffer_ok check (buffer_days between 0 and 30),
  constraint launches_notes_len check (notes is null or char_length(notes) <= 4000)
);

create table if not exists launch_tasks (
  id uuid primary key default gen_random_uuid(),
  launch_id uuid not null references launches(id) on delete cascade,
  title text not null,
  phase text not null default 'other',
  auto_kind text,
  owner_account_id uuid references employee_accounts(id) on delete set null,
  due_date date,
  status text not null default 'todo',
  done_at timestamptz,
  done_by_name text,
  notes text,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint launch_tasks_title_ok check (char_length(btrim(title)) between 1 and 200),
  constraint launch_tasks_phase_ok check (phase in ('formulation', 'ingredients', 'test_batch', 'production', 'content', 'retail', 'launch', 'other')),
  constraint launch_tasks_auto_ok check (auto_kind is null or auto_kind in ('formula_final', 'ingredients_ready')),
  constraint launch_tasks_status_ok check (status in ('todo', 'in_progress', 'blocked', 'done')),
  constraint launch_tasks_notes_len check (notes is null or char_length(notes) <= 2000)
);
create index if not exists launch_tasks_launch_idx on launch_tasks (launch_id);
create index if not exists launch_tasks_owner_idx on launch_tasks (owner_account_id);

create table if not exists launch_ingredients (
  id uuid primary key default gen_random_uuid(),
  launch_id uuid not null references launches(id) on delete cascade,
  raw_material_id uuid not null references inventory_items(id) on delete cascade,
  supplier_link_id uuid references raw_material_suppliers(id) on delete set null,
  status text not null default 'pending',
  qty_ordered numeric(14,3),
  ordered_at date,
  expected_arrival date,
  po_reference text,
  arrived_at date,
  arrived_source text,
  -- The Receiving Log entry that marked this row arrived (automatic arrivals),
  -- and entries an Admin chose to ignore with Undo (never re-applied).
  arrived_entry_id uuid,
  ignored_receiving_entry_ids uuid[] not null default '{}',
  in_formula boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint launch_ingredients_unique unique (launch_id, raw_material_id),
  constraint launch_ingredients_status_ok check (status in ('pending', 'ordered', 'arrived', 'skipped')),
  constraint launch_ingredients_qty_ok check (qty_ordered is null or qty_ordered >= 0),
  constraint launch_ingredients_po_len check (po_reference is null or char_length(po_reference) <= 100),
  constraint launch_ingredients_source_ok check (arrived_source is null or arrived_source in ('manual', 'receiving_log')),
  constraint launch_ingredients_notes_len check (notes is null or char_length(notes) <= 1000),
  constraint launch_ingredients_ordered_has_date check (status not in ('ordered') or ordered_at is not null),
  constraint launch_ingredients_arrived_has_date check (status <> 'arrived' or (arrived_at is not null and arrived_source is not null))
);
create index if not exists launch_ingredients_material_idx on launch_ingredients (raw_material_id);

-- Activity shown on the launch's Notes tab (append-only).
create table if not exists launch_events (
  id uuid primary key default gen_random_uuid(),
  launch_id uuid not null references launches(id) on delete cascade,
  event text not null,
  detail text,
  actor_name text,
  created_at timestamptz not null default now(),
  constraint launch_events_event_ok check (event in ('created', 'status_changed', 'dates_shifted', 'test_batch_date_changed',
    'ingredient_ordered', 'ingredient_arrived', 'ingredient_undone', 'ingredient_skipped', 'task_completed', 'task_reopened', 'synced_formula')),
  constraint launch_events_detail_len check (detail is null or char_length(detail) <= 500)
);
create index if not exists launch_events_launch_idx on launch_events (launch_id, created_at);

-- 3) Retail Prospecting --------------------------------------------------------------------
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'other',
  status text not null default 'to_visit',
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  phone text,
  website_url text,
  contact_name text,
  contact_title text,
  contact_email text,
  assigned_account_id uuid references employee_accounts(id) on delete set null,
  next_follow_up_date date,
  source text,
  notes text,
  lost_reason text,
  retailer_id uuid references retailers(id) on delete set null,
  archived_at timestamptz,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_name_ok check (char_length(btrim(name)) between 1 and 200),
  constraint leads_category_ok check (category in ('health_food', 'pharmacy', 'grocery', 'gift', 'boutique', 'gym_wellness', 'other')),
  constraint leads_status_ok check (status in ('to_visit', 'visited', 'samples_left', 'follow_up', 'negotiating', 'won', 'lost')),
  constraint leads_text_len check (
    coalesce(char_length(address_line1), 0) <= 200 and coalesce(char_length(address_line2), 0) <= 200
    and coalesce(char_length(city), 0) <= 100 and coalesce(char_length(state), 0) <= 50 and coalesce(char_length(zip), 0) <= 20
    and coalesce(char_length(phone), 0) <= 50 and coalesce(char_length(contact_name), 0) <= 200
    and coalesce(char_length(contact_title), 0) <= 200 and coalesce(char_length(contact_email), 0) <= 320),
  constraint leads_website_ok check (growth_url_ok(website_url)),
  constraint leads_source_len check (source is null or char_length(source) <= 200),
  constraint leads_notes_len check (notes is null or char_length(notes) <= 4000),
  constraint leads_lost_reason_len check (lost_reason is null or char_length(lost_reason) <= 500)
);
create index if not exists leads_status_idx on leads (status) where archived_at is null;
create index if not exists leads_follow_up_idx on leads (next_follow_up_date) where archived_at is null;

create table if not exists lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  activity_date date not null,
  type text not null,
  outcome text,
  summary text,
  next_step text,
  by_name text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_activities_type_ok check (type in ('visit', 'call', 'email', 'samples', 'other')),
  constraint lead_activities_outcome_ok check (outcome is null or outcome in ('no_decision_maker', 'spoke_with_buyer',
    'samples_left', 'interested', 'placing_order', 'not_interested', 'other')),
  constraint lead_activities_summary_len check (summary is null or char_length(summary) <= 2000),
  constraint lead_activities_next_len check (next_step is null or char_length(next_step) <= 500)
);
create index if not exists lead_activities_lead_idx on lead_activities (lead_id, activity_date);

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trip_date date not null,
  status text not null default 'planned',
  notes text,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_name_ok check (char_length(btrim(name)) between 1 and 200),
  constraint trips_status_ok check (status in ('planned', 'completed', 'cancelled')),
  constraint trips_notes_len check (notes is null or char_length(notes) <= 2000)
);

create table if not exists trip_stops (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  stop_order integer not null default 0,
  logged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_stops_unique unique (trip_id, lead_id)
);

-- One row (id = true).
create table if not exists prospecting_settings (
  id boolean primary key default true,
  goal_retailers integer,
  goal_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospecting_settings_single check (id),
  constraint prospecting_settings_goal_ok check (goal_retailers is null or goal_retailers between 1 and 10000)
);
insert into prospecting_settings (id) values (true) on conflict (id) do nothing;

-- 4) Marketing Hub -----------------------------------------------------------------------
create table if not exists marketing_assets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  business text not null default 'botaniqals',
  formulation_product_id uuid references formulation_products(id) on delete set null,
  asset_type text not null default 'photo',
  source text not null,
  file_path text,
  url text,
  mime_type text,
  size_bytes bigint,
  project_url text,
  status text not null default 'draft',
  notes text,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_assets_title_ok check (char_length(btrim(title)) between 1 and 200),
  constraint marketing_assets_business_ok check (business in ('botaniqals', 'minileaf', 'brand')),
  constraint marketing_assets_type_ok check (asset_type in ('photo', 'video', 'logo', 'template', 'packaging', 'document', 'other')),
  constraint marketing_assets_source_ok check (
    (source = 'upload' and file_path is not null and url is null
      and mime_type in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')
      and size_bytes between 1 and 26214400)
    or (source = 'link' and url is not null and file_path is null)),
  constraint marketing_assets_url_ok check (growth_url_ok(url) and growth_url_ok(project_url)),
  constraint marketing_assets_status_ok check (status in ('draft', 'ready', 'archived')),
  constraint marketing_assets_notes_len check (notes is null or char_length(notes) <= 1000)
);
create unique index if not exists marketing_assets_file_unique on marketing_assets (file_path) where file_path is not null;

create table if not exists marketing_product_profiles (
  id uuid primary key default gen_random_uuid(),
  formulation_product_id uuid not null unique references formulation_products(id) on delete cascade,
  tagline text,
  short_description text,
  long_description text,
  label_ingredients text,
  key_points text,
  hashtags text,
  do_not_say text,
  primary_asset_id uuid references marketing_assets(id) on delete set null,
  updated_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mpp_len check (
    coalesce(char_length(tagline), 0) <= 150 and coalesce(char_length(short_description), 0) <= 300
    and coalesce(char_length(long_description), 0) <= 2000 and coalesce(char_length(label_ingredients), 0) <= 2000
    and coalesce(char_length(key_points), 0) <= 1500 and coalesce(char_length(hashtags), 0) <= 500
    and coalesce(char_length(do_not_say), 0) <= 1000)
);

create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  claim_text text not null,
  formulation_product_id uuid references formulation_products(id) on delete set null,
  claim_type text not null default 'other',
  status text not null default 'draft',
  evidence_note text,
  evidence_url text,
  review_note text,
  reviewed_by_name text,
  reviewed_at timestamptz,
  review_again_on date,
  created_by_name text,
  -- Who made the latest change (copied into claim_events by the trigger).
  updated_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claims_text_ok check (char_length(btrim(claim_text)) between 1 and 500),
  constraint claims_type_ok check (claim_type in ('ingredient_fact', 'benefit', 'comparison', 'certification', 'other')),
  constraint claims_status_ok check (status in ('draft', 'in_review', 'approved', 'rejected', 'retired')),
  constraint claims_evidence_len check (evidence_note is null or char_length(evidence_note) <= 2000),
  constraint claims_evidence_url_ok check (growth_url_ok(evidence_url)),
  constraint claims_review_note_len check (review_note is null or char_length(review_note) <= 1000),
  constraint claims_reject_needs_note check (status <> 'rejected' or char_length(btrim(coalesce(review_note, ''))) > 0)
);

create table if not exists claim_events (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id) on delete cascade,
  event text not null,
  actor_name text,
  note text,
  claim_text_snapshot text,
  created_at timestamptz not null default now(),
  constraint claim_events_event_ok check (event in ('created', 'edited', 'submitted', 'approved', 'rejected', 'retired', 'reset_to_draft'))
);
create index if not exists claim_events_claim_idx on claim_events (claim_id, created_at);

create table if not exists content_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  business text not null default 'botaniqals',
  formulation_product_id uuid references formulation_products(id) on delete set null,
  platform text not null default 'instagram',
  post_type text not null default 'reel',
  status text not null default 'idea',
  scheduled_date date,
  scheduled_time time,
  owner_account_id uuid references employee_accounts(id) on delete set null,
  caption text,
  hashtags text,
  project_url text,
  posted_url text,
  posted_at date,
  notes text,
  risky_words_checked boolean not null default false,
  archived_at timestamptz,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_posts_title_ok check (char_length(btrim(title)) between 1 and 200),
  constraint content_posts_business_ok check (business in ('botaniqals', 'minileaf', 'brand')),
  constraint content_posts_platform_ok check (platform in ('instagram', 'tiktok', 'facebook', 'youtube', 'other')),
  constraint content_posts_type_ok check (post_type in ('reel', 'story', 'post', 'ad', 'other')),
  constraint content_posts_status_ok check (status in ('idea', 'scripting', 'filming', 'editing', 'ready', 'scheduled', 'posted')),
  constraint content_posts_len check (coalesce(char_length(caption), 0) <= 4000 and coalesce(char_length(hashtags), 0) <= 1000
    and coalesce(char_length(notes), 0) <= 2000),
  constraint content_posts_urls_ok check (growth_url_ok(project_url) and growth_url_ok(posted_url)),
  constraint content_posts_ready_caption check (status not in ('ready', 'scheduled', 'posted') or char_length(btrim(coalesce(caption, ''))) > 0)
);
create index if not exists content_posts_date_idx on content_posts (scheduled_date) where archived_at is null;

create table if not exists content_post_assets (
  post_id uuid not null references content_posts(id) on delete cascade,
  asset_id uuid not null references marketing_assets(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, asset_id)
);
create table if not exists content_post_claims (
  post_id uuid not null references content_posts(id) on delete cascade,
  claim_id uuid not null references claims(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, claim_id)
);

create table if not exists caption_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  platform text,
  body text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caption_templates_name_ok check (char_length(btrim(name)) between 1 and 150),
  constraint caption_templates_platform_ok check (platform is null or platform in ('instagram', 'tiktok', 'facebook', 'youtube', 'other')),
  constraint caption_templates_body_ok check (char_length(body) between 1 and 2000)
);

create table if not exists risky_words (
  id uuid primary key default gen_random_uuid(),
  phrase text not null,
  note text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint risky_words_phrase_ok check (char_length(btrim(phrase)) between 1 and 80),
  constraint risky_words_note_len check (note is null or char_length(note) <= 200)
);
create unique index if not exists risky_words_phrase_unique on risky_words (lower(btrim(phrase)));
-- A conservative starter list (Admins edit it). It is not a legal check.
insert into risky_words (phrase)
select p from unnest(array['cure', 'cures', 'treat', 'treats', 'treatment', 'prevent', 'prevents', 'prevention', 'heal', 'heals',
  'remedy', 'diagnose', 'disease', 'cavity', 'cavities', 'tooth decay', 'gum disease', 'gingivitis', 'clinically proven',
  'FDA approved', 'guaranteed']) p
on conflict do nothing;

-- 5) Line sheets (Retail, Admin only) --------------------------------------------------------
create table if not exists line_sheets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_profile_id uuid not null references company_profiles(id),
  retailer_id uuid references retailers(id) on delete set null,
  prepared_for text,
  price_basis text not null default 'standard',
  standard_wholesale_percent numeric(5,2),
  show_margin boolean not null default false,
  minimum_order_text text,
  lead_time_text text,
  payment_terms_text text,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  company_snapshot jsonb not null default '{}'::jsonb,
  prices_saved_at timestamptz not null default now(),
  created_by_name text,
  deleted_at timestamptz,
  last_downloaded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_sheets_name_ok check (char_length(btrim(name)) between 1 and 200),
  constraint line_sheets_basis_ok check (price_basis in ('retailer', 'standard')),
  constraint line_sheets_basis_fields check (
    (price_basis = 'retailer' and retailer_id is not null)
    or (price_basis = 'standard' and standard_wholesale_percent is not null)),
  constraint line_sheets_percent_ok check (standard_wholesale_percent is null or (standard_wholesale_percent > 0 and standard_wholesale_percent <= 100)),
  constraint line_sheets_len check (
    coalesce(char_length(prepared_for), 0) <= 200 and coalesce(char_length(minimum_order_text), 0) <= 300
    and coalesce(char_length(lead_time_text), 0) <= 300 and coalesce(char_length(payment_terms_text), 0) <= 300
    and coalesce(char_length(contact_name), 0) <= 200 and coalesce(char_length(contact_email), 0) <= 320
    and coalesce(char_length(contact_phone), 0) <= 50 and coalesce(char_length(notes), 0) <= 2000)
);

create table if not exists line_sheet_lines (
  id uuid primary key default gen_random_uuid(),
  line_sheet_id uuid not null references line_sheets(id) on delete cascade,
  line_number integer not null,
  product_id uuid references products(id) on delete set null,
  name text not null,
  description text,
  size_text text,
  case_pack_text text,
  wholesale_price numeric(12,4),
  msrp numeric(12,4),
  photo_asset_id uuid references marketing_assets(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_sheet_lines_number_unique unique (line_sheet_id, line_number),
  constraint line_sheet_lines_number_ok check (line_number between 1 and 60),
  constraint line_sheet_lines_name_ok check (char_length(btrim(name)) between 1 and 200),
  constraint line_sheet_lines_len check (coalesce(char_length(description), 0) <= 500
    and coalesce(char_length(size_text), 0) <= 100 and coalesce(char_length(case_pack_text), 0) <= 100),
  constraint line_sheet_lines_prices_ok check ((wholesale_price is null or wholesale_price >= 0) and (msrp is null or msrp >= 0))
);

create or replace function line_sheet_lines_limit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (select count(*) from line_sheet_lines where line_sheet_id = new.line_sheet_id) > 60 then
    raise exception 'A line sheet can have at most 60 products.' using errcode = 'check_violation';
  end if;
  return null;
end $$;
drop trigger if exists line_sheet_lines_limit on line_sheet_lines;
create trigger line_sheet_lines_limit after insert or update on line_sheet_lines
  for each row execute function line_sheet_lines_limit();

-- 6) Claims: review rules and history ---------------------------------------------------------
-- Browser users (authenticated) need is_admin() to approve, reject or retire.
-- Server code (service role) and the SQL editor are trusted: the server
-- routes check Admin before they do it.
create or replace function claims_can_review() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select is_admin() or coalesce(auth.role(), '') not in ('authenticated', 'anon')
$$;

create or replace function claims_before_write() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    -- Changing the text of an approved claim sends it back to draft.
    if old.status = 'approved' and new.claim_text is distinct from old.claim_text and new.status = 'approved' then
      new.status := 'draft';
      new.reviewed_by_name := null;
      new.reviewed_at := null;
      new.review_note := null;
    end if;
    if new.status is distinct from old.status and new.status in ('approved', 'rejected', 'retired') and not claims_can_review() then
      raise exception 'Only an Admin can approve, reject or retire a claim.' using errcode = 'insufficient_privilege';
    end if;
  elsif new.status in ('approved', 'rejected', 'retired') and not claims_can_review() then
    raise exception 'Only an Admin can approve, reject or retire a claim.' using errcode = 'insufficient_privilege';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists claims_before_write on claims;
create trigger claims_before_write before insert or update on claims
  for each row execute function claims_before_write();

create or replace function claims_after_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event text; v_note text;
begin
  if tg_op = 'INSERT' then
    v_event := 'created';
  elsif new.status is distinct from old.status then
    v_event := case new.status
      when 'in_review' then 'submitted'
      when 'approved' then 'approved'
      when 'rejected' then 'rejected'
      when 'retired' then 'retired'
      else 'reset_to_draft' end;
    if new.status in ('approved', 'rejected', 'retired') then v_note := new.review_note; end if;
  elsif new.claim_text is distinct from old.claim_text or new.claim_type is distinct from old.claim_type
     or new.formulation_product_id is distinct from old.formulation_product_id
     or new.evidence_note is distinct from old.evidence_note or new.evidence_url is distinct from old.evidence_url
     or new.review_again_on is distinct from old.review_again_on then
    v_event := 'edited';
  else
    return null;
  end if;
  insert into claim_events (claim_id, event, actor_name, note, claim_text_snapshot)
  values (new.id, v_event, coalesce(new.updated_by_name, new.created_by_name), v_note, new.claim_text);
  return null;
end $$;
drop trigger if exists claims_after_write on claims;
create trigger claims_after_write after insert or update on claims
  for each row execute function claims_after_write();

-- claim_events and launch_events are append-only.
create or replace function growth_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% rows can''t be changed or deleted.', tg_table_name using errcode = 'insufficient_privilege';
end $$;
drop trigger if exists claim_events_append_only on claim_events;
create trigger claim_events_append_only before update or delete on claim_events
  for each row execute function growth_append_only();
drop trigger if exists launch_events_append_only on launch_events;
create trigger launch_events_append_only before update or delete on launch_events
  for each row execute function growth_append_only();

-- 7) updated_at triggers --------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['launches', 'launch_tasks', 'launch_ingredients', 'leads', 'lead_activities', 'trips', 'trip_stops',
    'prospecting_settings', 'marketing_assets', 'marketing_product_profiles', 'content_posts', 'content_post_assets',
    'content_post_claims', 'caption_templates', 'risky_words', 'line_sheets', 'line_sheet_lines'] loop
    execute format('drop trigger if exists %I on %I', t || '_touch_updated_at', t);
    execute format('create trigger %I before update on %I for each row execute function growth_touch_updated_at()', t || '_touch_updated_at', t);
  end loop;
end $$;

-- 8) Private storage bucket (no browser policies: server-signed URLs only) ---------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('marketing-assets', 'marketing-assets', false, 26214400, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- 9) Row level security -----------------------------------------------------------------------
-- Reads and writes: active employees with the group's feature (Admins pass).
-- No delete policy and no anon access anywhere.
do $$
declare
  r record;
  v_check text;
begin
  for r in
    select * from (values
      ('launches', 'growth.launches'), ('launch_tasks', 'growth.launches'), ('launch_ingredients', 'growth.launches'),
      ('leads', 'growth.prospecting'), ('lead_activities', 'growth.prospecting'), ('trips', 'growth.prospecting'),
      ('trip_stops', 'growth.prospecting'), ('prospecting_settings', 'growth.prospecting'),
      ('marketing_assets', 'growth.marketing'), ('marketing_product_profiles', 'growth.marketing'), ('claims', 'growth.marketing'),
      ('content_posts', 'growth.marketing'), ('content_post_assets', 'growth.marketing'), ('content_post_claims', 'growth.marketing'),
      ('caption_templates', 'growth.marketing'),
      ('line_sheets', 'admin'), ('line_sheet_lines', 'admin')
    ) as v(t, k)
  loop
    v_check := case when r.k = 'admin' then 'is_active_employee() and is_admin()'
                    else format('is_active_employee() and has_feature(%L)', r.k) end;
    execute format('alter table %I enable row level security', r.t);
    execute format('revoke all on %I from anon', r.t);
    execute format('revoke delete, truncate on %I from authenticated', r.t);
    execute format('grant select, insert, update on %I to authenticated', r.t);
    execute format('grant all on %I to service_role', r.t);
    execute format('drop policy if exists %I on %I', r.t || '_select', r.t);
    execute format('create policy %I on %I for select to authenticated using (%s)', r.t || '_select', r.t, v_check);
    execute format('drop policy if exists %I on %I', r.t || '_insert', r.t);
    execute format('create policy %I on %I for insert to authenticated with check (%s)', r.t || '_insert', r.t, v_check);
    execute format('drop policy if exists %I on %I', r.t || '_update', r.t);
    execute format('create policy %I on %I for update to authenticated using (%s) with check (%s)', r.t || '_update', r.t, v_check, v_check);
  end loop;

  -- Append-only history: read with the feature, written only by triggers / server.
  for r in select * from (values ('claim_events', 'growth.marketing'), ('launch_events', 'growth.launches')) as v(t, k) loop
    execute format('alter table %I enable row level security', r.t);
    execute format('revoke all on %I from anon', r.t);
    execute format('revoke insert, update, delete, truncate on %I from authenticated', r.t);
    execute format('grant select on %I to authenticated', r.t);
    execute format('grant all on %I to service_role', r.t);
    execute format('drop policy if exists %I on %I', r.t || '_select', r.t);
    execute format('create policy %I on %I for select to authenticated using (is_active_employee() and has_feature(%L))', r.t || '_select', r.t, r.k);
  end loop;

  -- Risky words: read by Marketing Hub users (and Admins for line sheets); only Admins change them.
  alter table risky_words enable row level security;
  revoke all on risky_words from anon;
  revoke delete, truncate on risky_words from authenticated;
  grant select, insert, update on risky_words to authenticated;
  grant all on risky_words to service_role;
  drop policy if exists risky_words_select on risky_words;
  create policy risky_words_select on risky_words for select to authenticated
    using (is_active_employee() and (has_feature('growth.marketing') or is_admin()));
  drop policy if exists risky_words_insert on risky_words;
  create policy risky_words_insert on risky_words for insert to authenticated with check (is_active_employee() and is_admin());
  drop policy if exists risky_words_update on risky_words;
  create policy risky_words_update on risky_words for update to authenticated
    using (is_active_employee() and is_admin()) with check (is_active_employee() and is_admin());
end $$;

revoke all on function claims_can_review() from public, anon;
grant execute on function claims_can_review() to authenticated, service_role;
