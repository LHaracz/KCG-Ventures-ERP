-- Retail: retailers, payment terms by business (including consignment),
-- per-retailer price lists, invoice settings, and the invoice generator.
-- Admin only. Run in the Supabase SQL editor BEFORE deploying the code.
--
-- Safety rules this file follows:
--  - Additive only. New tables, functions, triggers and policies. No
--    existing table, column, function or policy is changed. New tables
--    reference company_profiles and products.
--  - Invoices are standalone documents: nothing here creates, reads or
--    updates Shopify orders, inventory, batches, Sales Data or Stats.
--  - ERP invoice numbers ({prefix}-{YYYY}-{NNN}) come from an atomic counter
--    bumped in the same transaction as the insert, so a failed or abandoned
--    save never uses a number, and numbers are never reused.
--  - Invoices are soft-deleted (deleted_at). A deleted invoice frees its
--    Shopify order number for a new invoice; its ERP number stays retired.
--  - Safe to run more than once.

-- 0) Preconditions ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.is_admin()') is null or to_regprocedure('public.is_active_employee()') is null then
    raise exception 'Run the employee access migrations first (is_admin() / is_active_employee() are missing).';
  end if;
  if to_regclass('public.company_profiles') is null then
    raise exception 'Run purchase_orders_core.sql first (company_profiles is missing).';
  end if;
  if to_regclass('public.products') is null then
    raise exception 'The products table is missing.';
  end if;
end $$;

-- Shared trigger: keep updated_at current.
create or replace function retail_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- 1) retailers -------------------------------------------------------------------
create table if not exists retailers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  description text,
  website_url text,
  contact_name text,
  contact_email text,
  contact_phone text,
  billing_line1 text,
  billing_line2 text,
  billing_city text,
  billing_state text,
  billing_zip text,
  billing_country text,
  shipping_same_as_billing boolean not null default true,
  shipping_name text,
  shipping_line1 text,
  shipping_line2 text,
  shipping_city text,
  shipping_state text,
  shipping_zip text,
  shipping_country text,
  tax_exempt boolean not null default false,
  resale_certificate_number text,
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_name text,
  constraint retailers_name_len check (char_length(btrim(name)) between 1 and 200 and name = btrim(name)),
  constraint retailers_legal_name_len check (legal_name is null or char_length(legal_name) <= 200),
  constraint retailers_description_len check (description is null or char_length(description) <= 4000),
  constraint retailers_website_ok check (
    website_url is null or (char_length(website_url) <= 2000 and website_url ~* '^https?://[^[:space:]]+$')
  ),
  constraint retailers_contact_name_len check (contact_name is null or char_length(contact_name) <= 200),
  constraint retailers_contact_email_ok check (
    contact_email is null or (char_length(contact_email) <= 254 and contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  constraint retailers_contact_phone_len check (contact_phone is null or char_length(contact_phone) <= 50),
  constraint retailers_address_len check (
    coalesce(char_length(billing_line1), 0) <= 200 and coalesce(char_length(billing_line2), 0) <= 200
    and coalesce(char_length(billing_city), 0) <= 200 and coalesce(char_length(billing_state), 0) <= 200
    and coalesce(char_length(billing_zip), 0) <= 200 and coalesce(char_length(billing_country), 0) <= 200
    and coalesce(char_length(shipping_name), 0) <= 200
    and coalesce(char_length(shipping_line1), 0) <= 200 and coalesce(char_length(shipping_line2), 0) <= 200
    and coalesce(char_length(shipping_city), 0) <= 200 and coalesce(char_length(shipping_state), 0) <= 200
    and coalesce(char_length(shipping_zip), 0) <= 200 and coalesce(char_length(shipping_country), 0) <= 200
  ),
  constraint retailers_resale_len check (resale_certificate_number is null or char_length(resale_certificate_number) <= 100),
  constraint retailers_notes_len check (notes is null or char_length(notes) <= 4000),
  constraint retailers_updated_by_len check (updated_by_name is null or char_length(updated_by_name) <= 200)
);
create unique index if not exists retailers_name_unique on retailers (lower(name)) where archived_at is null;

drop trigger if exists retailers_touch_updated_at on retailers;
create trigger retailers_touch_updated_at before update on retailers
  for each row execute function retail_touch_updated_at();

-- 2) retailer_terms: default payment terms for one retailer and one business ---------
create table if not exists retailer_terms (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid not null references retailers(id) on delete restrict,
  company_profile_id uuid not null references company_profiles(id) on delete restrict,
  terms_type text not null,
  net_days integer,
  terms_start text not null default 'invoice_date',
  consignment_our_share_percent numeric(5,2),
  consignment_schedule text,
  consignment_days_to_pay integer,
  consignment_extra_terms text,
  updated_at timestamptz not null default now(),
  updated_by_name text,
  constraint retailer_terms_unique unique (retailer_id, company_profile_id),
  constraint retailer_terms_type_ok check (terms_type in ('net', 'due_on_receipt', 'due_on_delivery', 'prepaid', 'consignment')),
  constraint retailer_terms_start_ok check (terms_start in ('invoice_date', 'delivery_date')),
  constraint retailer_terms_net_days_range check (net_days is null or net_days between 1 and 180),
  constraint retailer_terms_net_days_required check (terms_type <> 'net' or net_days is not null),
  constraint retailer_terms_schedule_ok check (consignment_schedule is null or consignment_schedule in ('biweekly', 'monthly')),
  constraint retailer_terms_days_to_pay_range check (consignment_days_to_pay is null or consignment_days_to_pay between 1 and 180),
  constraint retailer_terms_consignment_required check (
    terms_type <> 'consignment' or (
      consignment_our_share_percent is not null and consignment_our_share_percent > 0 and consignment_our_share_percent < 100
      and consignment_schedule is not null and consignment_days_to_pay is not null
    )
  ),
  constraint retailer_terms_extra_len check (consignment_extra_terms is null or char_length(consignment_extra_terms) <= 1000)
);

drop trigger if exists retailer_terms_touch_updated_at on retailer_terms;
create trigger retailer_terms_touch_updated_at before update on retailer_terms
  for each row execute function retail_touch_updated_at();

-- 3) retailer_prices: wholesale price and MSRP per retailer and product -------------
create table if not exists retailer_prices (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid not null references retailers(id) on delete restrict,
  product_id uuid not null references products(id) on delete cascade,
  wholesale_price numeric(12,4),
  msrp numeric(12,4),
  notes text,
  updated_at timestamptz not null default now(),
  updated_by_name text,
  constraint retailer_prices_unique unique (retailer_id, product_id),
  constraint retailer_prices_wholesale_ok check (wholesale_price is null or wholesale_price >= 0),
  constraint retailer_prices_msrp_ok check (msrp is null or msrp >= 0),
  constraint retailer_prices_notes_len check (notes is null or char_length(notes) <= 500)
);

drop trigger if exists retailer_prices_touch_updated_at on retailer_prices;
create trigger retailer_prices_touch_updated_at before update on retailer_prices
  for each row execute function retail_touch_updated_at();

-- 4) invoice_settings: one row per business ----------------------------------------
-- product_scope says which products the invoice form offers for this
-- business (products.is_microgreen marks MiniLeaf products).
create table if not exists invoice_settings (
  id uuid primary key default gen_random_uuid(),
  company_profile_id uuid not null unique references company_profiles(id) on delete restrict,
  invoice_prefix text not null default 'KCG-INV',
  payable_to text,
  remit_line1 text,
  remit_line2 text,
  remit_city text,
  remit_state text,
  remit_zip text,
  remit_country text,
  payment_instructions text,
  default_terms_type text not null default 'net',
  default_net_days integer not null default 30,
  default_tax_rate_percent numeric(6,3) not null default 0,
  footer_note text,
  product_scope text not null default 'all',
  updated_at timestamptz not null default now(),
  updated_by_name text,
  constraint invoice_settings_prefix_ok check (invoice_prefix ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,19}$'),
  constraint invoice_settings_payable_len check (payable_to is null or char_length(payable_to) <= 200),
  constraint invoice_settings_remit_len check (
    coalesce(char_length(remit_line1), 0) <= 200 and coalesce(char_length(remit_line2), 0) <= 200
    and coalesce(char_length(remit_city), 0) <= 200 and coalesce(char_length(remit_state), 0) <= 200
    and coalesce(char_length(remit_zip), 0) <= 200 and coalesce(char_length(remit_country), 0) <= 200
  ),
  constraint invoice_settings_instructions_len check (payment_instructions is null or char_length(payment_instructions) <= 2000),
  constraint invoice_settings_terms_ok check (default_terms_type in ('net', 'due_on_receipt', 'due_on_delivery', 'prepaid')),
  constraint invoice_settings_net_days_range check (default_net_days between 1 and 180),
  constraint invoice_settings_tax_range check (default_tax_rate_percent >= 0 and default_tax_rate_percent <= 100),
  constraint invoice_settings_footer_len check (footer_note is null or char_length(footer_note) <= 500),
  constraint invoice_settings_scope_ok check (product_scope in ('botaniqals', 'minileaf', 'all'))
);

drop trigger if exists invoice_settings_touch_updated_at on invoice_settings;
create trigger invoice_settings_touch_updated_at before update on invoice_settings
  for each row execute function retail_touch_updated_at();

-- Seed one blank row per existing business (no addresses, emails or notes).
insert into invoice_settings (company_profile_id, product_scope)
select p.id,
  case
    when lower(btrim(p.display_name)) = 'minileaf' then 'minileaf'
    when lower(btrim(p.display_name)) = 'botaniqals' then 'botaniqals'
    else 'all'
  end
from company_profiles p
where not exists (select 1 from invoice_settings s where s.company_profile_id = p.id);

-- 5) invoice_counters and assign_invoice_number ---------------------------------------
create table if not exists invoice_counters (
  prefix text not null,
  year integer not null,
  last_number integer not null default 0,
  primary key (prefix, year)
);

-- The ONE place that bumps a counter: a single atomic INSERT ... ON CONFLICT
-- DO UPDATE ... RETURNING, so two saves at the same instant never get the
-- same number. Called only inside create_invoice(), in the same transaction
-- as the insert. Year is the America/New_York year. {prefix}-{YYYY}-{NNN},
-- padded to 3 digits and growing past 999.
create or replace function assign_invoice_number(p_prefix text)
returns table (invoice_number text, invoice_year integer, invoice_sequence integer)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_year integer := extract(year from (now() at time zone 'America/New_York'))::integer;
  v_seq integer;
begin
  insert into invoice_counters (prefix, year, last_number)
  values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update set last_number = invoice_counters.last_number + 1
  returning last_number into v_seq;
  return query select
    p_prefix || '-' || v_year::text || '-' || case when v_seq < 1000 then lpad(v_seq::text, 3, '0') else v_seq::text end,
    v_year,
    v_seq;
end $$;

-- 6) invoices and invoice_lines ------------------------------------------------------------
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null,
  prefix text not null,
  year integer not null,
  sequence integer not null,
  order_number text not null,
  company_profile_id uuid not null references company_profiles(id) on delete restrict,
  company_snapshot jsonb not null default '{}'::jsonb,
  retailer_id uuid not null references retailers(id) on delete restrict,
  retailer_snapshot jsonb not null default '{}'::jsonb,
  bill_to jsonb not null default '{}'::jsonb,
  ship_to jsonb not null default '{}'::jsonb,
  invoice_date date not null,
  delivery_date date not null,
  terms_type text not null,
  net_days integer,
  terms_start text not null default 'invoice_date',
  consignment_our_share_percent numeric(5,2),
  consignment_schedule text,
  consignment_days_to_pay integer,
  consignment_extra_terms text,
  due_date date,
  retailer_po_number text,
  delivery_fee numeric(12,2) not null default 0,
  tax_exempt boolean not null default false,
  tax_rate_percent numeric(6,3) not null default 0,
  subtotal numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  notes_to_retailer text,
  internal_notes text,
  deleted_at timestamptz,
  last_downloaded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_name text,
  constraint invoices_number_unique unique (invoice_number),
  constraint invoices_order_number_len check (char_length(btrim(order_number)) between 1 and 50),
  constraint invoices_terms_type_ok check (terms_type in ('net', 'due_on_receipt', 'due_on_delivery', 'prepaid', 'consignment')),
  constraint invoices_terms_start_ok check (terms_start in ('invoice_date', 'delivery_date')),
  constraint invoices_net_days_range check (net_days is null or net_days between 1 and 180),
  constraint invoices_net_days_required check (terms_type <> 'net' or net_days is not null),
  constraint invoices_schedule_ok check (consignment_schedule is null or consignment_schedule in ('biweekly', 'monthly')),
  constraint invoices_days_to_pay_range check (consignment_days_to_pay is null or consignment_days_to_pay between 1 and 180),
  constraint invoices_consignment_required check (
    terms_type <> 'consignment' or (
      consignment_our_share_percent is not null and consignment_our_share_percent > 0 and consignment_our_share_percent < 100
      and consignment_schedule is not null and consignment_days_to_pay is not null
    )
  ),
  constraint invoices_extra_terms_len check (consignment_extra_terms is null or char_length(consignment_extra_terms) <= 1000),
  constraint invoices_due_date_required check (terms_type = 'consignment' or due_date is not null),
  constraint invoices_consignment_no_due_date check (terms_type <> 'consignment' or due_date is null),
  constraint invoices_delivery_after_invoice check (delivery_date >= invoice_date),
  constraint invoices_po_len check (retailer_po_number is null or char_length(retailer_po_number) <= 100),
  constraint invoices_delivery_fee_ok check (delivery_fee >= 0),
  constraint invoices_tax_rate_range check (tax_rate_percent >= 0 and tax_rate_percent <= 100),
  constraint invoices_total_ok check (total >= 0 and subtotal >= 0 and tax_amount >= 0),
  constraint invoices_notes_len check (
    coalesce(char_length(notes_to_retailer), 0) <= 2000 and coalesce(char_length(internal_notes), 0) <= 2000
  ),
  constraint invoices_created_by_len check (created_by_name is null or char_length(created_by_name) <= 200)
);
-- One active invoice per Shopify order (case-insensitive). Deleted invoices
-- free the order number; their ERP invoice numbers stay unique forever.
create unique index if not exists invoices_order_number_active_unique
  on invoices (lower(order_number)) where deleted_at is null;
create index if not exists invoices_retailer_idx on invoices (retailer_id);
create index if not exists invoices_company_idx on invoices (company_profile_id);

-- updated_at moves on every real edit, but not when only last_downloaded_at
-- changes (recording a download is not an edit; "Edited since last
-- download" compares the two).
create or replace function invoices_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - 'last_downloaded_at' - 'updated_at') = (to_jsonb(old) - 'last_downloaded_at' - 'updated_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists invoices_touch_updated_at on invoices;
create trigger invoices_touch_updated_at before update on invoices
  for each row execute function invoices_touch_updated_at();

create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete restrict,
  line_number integer not null,
  product_id uuid references products(id) on delete set null,
  description text not null,
  quantity numeric(14,3) not null,
  unit text not null,
  unit_price numeric(12,4) not null,
  line_total numeric(12,2) not null,
  constraint invoice_lines_number_unique unique (invoice_id, line_number),
  constraint invoice_lines_description_len check (char_length(btrim(description)) between 1 and 500),
  constraint invoice_lines_quantity_ok check (quantity > 0),
  constraint invoice_lines_unit_len check (char_length(btrim(unit)) between 1 and 30),
  constraint invoice_lines_unit_price_ok check (unit_price >= 0),
  constraint invoice_lines_line_total_ok check (line_total >= 0)
);

-- At most 100 lines per invoice.
create or replace function invoice_lines_limit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (select count(*) from invoice_lines where invoice_id = new.invoice_id) > 100 then
    raise exception 'An invoice can have at most 100 lines.';
  end if;
  return new;
end $$;

drop trigger if exists invoice_lines_limit on invoice_lines;
create trigger invoice_lines_limit after insert on invoice_lines
  for each row execute function invoice_lines_limit();

-- 7) create_invoice / update_invoice ----------------------------------------------------
-- Called only by server code (service role) after it has validated the
-- payload and computed due_date. Line totals, subtotal, tax and total are
-- computed HERE (round half up to cents), never taken from the payload.
create or replace function invoice_write_lines(p_invoice_id uuid, p_lines jsonb)
returns numeric
language plpgsql set search_path = public, pg_temp as $$
declare
  v_line jsonb;
  v_n integer := 0;
  v_qty numeric;
  v_price numeric;
  v_total numeric;
  v_subtotal numeric := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'An invoice needs at least one line.';
  end if;
  if jsonb_array_length(p_lines) > 100 then
    raise exception 'An invoice can have at most 100 lines.';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    v_qty := (v_line->>'quantity')::numeric;
    v_price := (v_line->>'unit_price')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: quantity must be greater than 0.', v_n; end if;
    if v_price is null or v_price < 0 then raise exception 'Line %: unit price must be 0 or more.', v_n; end if;
    v_total := round(round(v_qty, 3) * round(v_price, 4), 2);
    insert into invoice_lines (invoice_id, line_number, product_id, description, quantity, unit, unit_price, line_total)
    values (
      p_invoice_id, v_n, nullif(v_line->>'product_id', '')::uuid, btrim(v_line->>'description'),
      v_qty, btrim(v_line->>'unit'), v_price, v_total
    );
    v_subtotal := v_subtotal + v_total;
  end loop;
  return v_subtotal;
end $$;

create or replace function invoice_apply_totals(p_invoice_id uuid, p_subtotal numeric)
returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  update invoices set
    subtotal = p_subtotal,
    tax_amount = case when tax_exempt then 0 else round(p_subtotal * tax_rate_percent / 100, 2) end,
    total = p_subtotal + delivery_fee + case when tax_exempt then 0 else round(p_subtotal * tax_rate_percent / 100, 2) end
  where id = p_invoice_id;
end $$;

create or replace function create_invoice(payload jsonb)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_prefix text;
  v_assigned record;
  v_id uuid;
  v_subtotal numeric;
begin
  select coalesce(s.invoice_prefix, 'KCG-INV') into v_prefix
  from company_profiles p left join invoice_settings s on s.company_profile_id = p.id
  where p.id = (payload->>'company_profile_id')::uuid;
  if not found then raise exception 'Unknown business.'; end if;

  select * into v_assigned from assign_invoice_number(v_prefix);

  insert into invoices (
    invoice_number, prefix, year, sequence, order_number, company_profile_id, company_snapshot,
    retailer_id, retailer_snapshot, bill_to, ship_to, invoice_date, delivery_date,
    terms_type, net_days, terms_start, consignment_our_share_percent, consignment_schedule,
    consignment_days_to_pay, consignment_extra_terms, due_date, retailer_po_number,
    delivery_fee, tax_exempt, tax_rate_percent, notes_to_retailer, internal_notes, created_by_name
  ) values (
    v_assigned.invoice_number, v_prefix, v_assigned.invoice_year, v_assigned.invoice_sequence,
    btrim(payload->>'order_number'), (payload->>'company_profile_id')::uuid, coalesce(payload->'company_snapshot', '{}'::jsonb),
    (payload->>'retailer_id')::uuid, coalesce(payload->'retailer_snapshot', '{}'::jsonb),
    coalesce(payload->'bill_to', '{}'::jsonb), coalesce(payload->'ship_to', '{}'::jsonb),
    (payload->>'invoice_date')::date, (payload->>'delivery_date')::date,
    payload->>'terms_type', (payload->>'net_days')::integer, coalesce(payload->>'terms_start', 'invoice_date'),
    (payload->>'consignment_our_share_percent')::numeric, payload->>'consignment_schedule',
    (payload->>'consignment_days_to_pay')::integer, payload->>'consignment_extra_terms',
    (payload->>'due_date')::date, payload->>'retailer_po_number',
    coalesce((payload->>'delivery_fee')::numeric, 0), coalesce((payload->>'tax_exempt')::boolean, false),
    coalesce((payload->>'tax_rate_percent')::numeric, 0), payload->>'notes_to_retailer', payload->>'internal_notes',
    payload->>'created_by_name'
  ) returning id into v_id;

  v_subtotal := invoice_write_lines(v_id, payload->'lines');
  perform invoice_apply_totals(v_id, v_subtotal);
  return jsonb_build_object('id', v_id, 'invoice_number', v_assigned.invoice_number);
end $$;

-- Updates everything except the invoice number (which never changes), and
-- replaces the lines. Snapshots are only replaced when the payload carries
-- them (the "update business and retailer details" option).
create or replace function update_invoice(p_id uuid, payload jsonb)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_number text;
  v_subtotal numeric;
begin
  select invoice_number into v_number from invoices where id = p_id and deleted_at is null for update;
  if not found then raise exception 'That invoice was not found, or it is deleted.'; end if;

  update invoices set
    order_number = btrim(payload->>'order_number'),
    company_profile_id = (payload->>'company_profile_id')::uuid,
    company_snapshot = coalesce(payload->'company_snapshot', company_snapshot),
    retailer_id = (payload->>'retailer_id')::uuid,
    retailer_snapshot = coalesce(payload->'retailer_snapshot', retailer_snapshot),
    bill_to = coalesce(payload->'bill_to', '{}'::jsonb),
    ship_to = coalesce(payload->'ship_to', '{}'::jsonb),
    invoice_date = (payload->>'invoice_date')::date,
    delivery_date = (payload->>'delivery_date')::date,
    terms_type = payload->>'terms_type',
    net_days = (payload->>'net_days')::integer,
    terms_start = coalesce(payload->>'terms_start', 'invoice_date'),
    consignment_our_share_percent = (payload->>'consignment_our_share_percent')::numeric,
    consignment_schedule = payload->>'consignment_schedule',
    consignment_days_to_pay = (payload->>'consignment_days_to_pay')::integer,
    consignment_extra_terms = payload->>'consignment_extra_terms',
    due_date = (payload->>'due_date')::date,
    retailer_po_number = payload->>'retailer_po_number',
    delivery_fee = coalesce((payload->>'delivery_fee')::numeric, 0),
    tax_exempt = coalesce((payload->>'tax_exempt')::boolean, false),
    tax_rate_percent = coalesce((payload->>'tax_rate_percent')::numeric, 0),
    notes_to_retailer = payload->>'notes_to_retailer',
    internal_notes = payload->>'internal_notes'
  where id = p_id;

  delete from invoice_lines where invoice_id = p_id;
  v_subtotal := invoice_write_lines(p_id, payload->'lines');
  perform invoice_apply_totals(p_id, v_subtotal);
  return jsonb_build_object('id', p_id, 'invoice_number', v_number);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'assign_invoice_number(text)', 'invoice_write_lines(uuid, jsonb)', 'invoice_apply_totals(uuid, numeric)',
    'create_invoice(jsonb)', 'update_invoice(uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 8) Row level security: Admins only, no delete anywhere -------------------------------------
-- Same convention as the other Admin-only tables (employee_access_policies.sql):
-- an active employee holding the Admin role. The app writes through
-- Admin-only server routes; these policies are the database's own check.
do $$
declare t text;
begin
  foreach t in array array['retailers', 'retailer_terms', 'retailer_prices', 'invoice_settings', 'invoices', 'invoice_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke delete, truncate on %I from authenticated', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop policy if exists %I on %I', t || '_admin_select', t);
    execute format('create policy %I on %I for select to authenticated using (is_active_employee() and is_admin())', t || '_admin_select', t);
    execute format('drop policy if exists %I on %I', t || '_admin_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (is_active_employee() and is_admin())', t || '_admin_insert', t);
    execute format('drop policy if exists %I on %I', t || '_admin_update', t);
    execute format('create policy %I on %I for update to authenticated using (is_active_employee() and is_admin()) with check (is_active_employee() and is_admin())', t || '_admin_update', t);
  end loop;
end $$;

alter table invoice_counters enable row level security;
revoke all on invoice_counters from anon;
revoke insert, update, delete, truncate on invoice_counters from authenticated;
grant select on invoice_counters to authenticated;
grant all on invoice_counters to service_role;
drop policy if exists invoice_counters_admin_select on invoice_counters;
create policy invoice_counters_admin_select on invoice_counters
  for select to authenticated using (is_active_employee() and is_admin());
