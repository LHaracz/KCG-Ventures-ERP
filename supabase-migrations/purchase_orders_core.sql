-- Purchase Orders (Phase 1): company profiles + PO numbering.
-- Run in the Supabase SQL editor, before purchase_orders_documents.sql.
--
-- Safety rules this file exists to satisfy:
--  - No changes to any existing table. Everything here is new.
--  - PO numbers are never reused or reassigned (see po_counters and
--    assign_po_number() below — the atomic-increment half of that
--    guarantee; the other half, that a PO keeps its number forever once
--    assigned and deleted POs are soft-deleted only, lives in
--    purchase_orders_documents.sql's create_purchase_order()).

-- 1) company_profiles: one row per business (BotanIQals, MiniLeaf), each
--    with its own letterhead, defaults, and PO prefix. Never deleted —
--    archived_at is how a profile is retired (see the "New business
--    profile" action on the settings page).
create table if not exists company_profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  legal_name text not null,
  po_prefix text not null,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  country text,
  phone text,
  email text,
  website text,
  logo_path text,
  accent_color text not null default '#1a472a',
  default_buyer_name text,
  default_buyer_title text,
  default_buyer_phone text,
  default_buyer_email text,
  default_payment_terms text,
  default_shipping_method text,
  default_freight_terms text,
  default_special_instructions text,
  default_terms_text text,
  footer_note text,
  ship_to_default jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint company_profiles_accent_color_format check (accent_color ~* '^#[0-9a-f]{6}$')
);

create index if not exists idx_company_profiles_archived_at on company_profiles(archived_at);

alter table company_profiles enable row level security;
drop policy if exists company_profiles_select_policy on company_profiles;
create policy company_profiles_select_policy on company_profiles
  for select using (auth.role() = 'authenticated');
drop policy if exists company_profiles_insert_policy on company_profiles;
create policy company_profiles_insert_policy on company_profiles
  for insert with check (auth.role() = 'authenticated');
drop policy if exists company_profiles_update_policy on company_profiles;
create policy company_profiles_update_policy on company_profiles
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- No delete grant anywhere — a profile is archived (archived_at set via an
-- ordinary update), never deleted, since POs reference it by id.
grant select, insert, update on table company_profiles to authenticated;

-- 2) company-assets: private Storage bucket for profile logos. PNG/JPEG
--    only, 2 MB cap. A replaced logo's old file is never removed here —
--    see logoStorage.ts — because older POs' company_snapshot still
--    points at it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-assets', 'company-assets', false, 2097152, array['image/png', 'image/jpeg'])
on conflict (id) do update set
  public = false,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/png', 'image/jpeg'];

drop policy if exists company_assets_bucket_shared_policy on storage.objects;
create policy company_assets_bucket_shared_policy on storage.objects
  for all using (bucket_id = 'company-assets' and auth.role() = 'authenticated')
  with check (bucket_id = 'company-assets' and auth.role() = 'authenticated');

-- 3) po_counters: one row per (prefix, year) — the only state behind PO
--    numbering. "Year" is the calendar year in America/New_York at the
--    moment a PO is first saved (see assign_po_number below), not UTC, so
--    the sequence rolls over at local midnight on Dec 31, not UTC
--    midnight.
create table if not exists po_counters (
  prefix text not null,
  year integer not null,
  last_number integer not null default 0,
  primary key (prefix, year)
);

alter table po_counters enable row level security;
drop policy if exists po_counters_select_policy on po_counters;
create policy po_counters_select_policy on po_counters
  for select using (auth.role() = 'authenticated');

-- No insert/update/delete grant for ordinary clients: the only writer is
-- assign_po_number() below, called exclusively from inside
-- create_purchase_order() (purchase_orders_documents.sql) using the
-- service role, which bypasses RLS/grants entirely. This isn't an
-- append-only table (rows are updated in place, once per prefix+year),
-- it's simply not meant to be writable from the client at all.
grant select on table po_counters to authenticated;

-- 4) assign_po_number: the ONE place that ever bumps a counter. Does the
--    increment with INSERT ... ON CONFLICT DO UPDATE ... RETURNING, which
--    Postgres executes as a single atomic statement — two POs saved at
--    the exact same instant still get two different numbers, never the
--    same one, with no advisory lock needed. Called from inside
--    create_purchase_order()'s own transaction (a plpgsql function body
--    is already one transaction), so the increment and the PO insert
--    either both happen or neither does: a form abandoned before saving
--    never calls this function at all, so it never consumes a number.
--
--    Format: {prefix}-{YYYY}-{NNN}, NNN zero-padded to 3 digits and
--    growing naturally past 999 (1000, 1001, ... — never re-padded).
create or replace function public.assign_po_number(p_prefix text)
returns table (po_number text, po_year integer, po_sequence integer)
language plpgsql
security invoker
as $$
declare
  v_year integer := extract(year from (now() at time zone 'America/New_York'))::integer;
  v_seq integer;
begin
  insert into po_counters (prefix, year, last_number)
  values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update set last_number = po_counters.last_number + 1
  returning last_number into v_seq;

  return query select
    p_prefix || '-' || v_year::text || '-' ||
      case when v_seq < 1000 then lpad(v_seq::text, 3, '0') else v_seq::text end,
    v_year,
    v_seq;
end;
$$;

-- 5) Seed BotanIQals and MiniLeaf. Addresses, contacts and logos are left
--    blank for the user to fill in on the settings page. default_payment_terms
--    / default_shipping_method / default_freight_terms are seeded to the
--    first/standard option in each list (Net 30, Vendor-arranged ground,
--    Prepaid and added to invoice) purely as a sensible starting point —
--    fully editable per-profile and per-PO, nothing enforced by this choice.
insert into company_profiles (
  display_name, legal_name, po_prefix, accent_color,
  default_payment_terms, default_shipping_method, default_freight_terms,
  default_special_instructions, default_terms_text, ship_to_default
)
select
  'BotanIQals', 'KCG Ventures LLC', 'KCG-PO', '#1a472a',
  'Net 30', 'Vendor-arranged ground', 'Prepaid and added to invoice',
  '1. A Certificate of Analysis (COA) must accompany every lot shipped.
2. Each container must be labeled with the material name, vendor name, vendor lot number, net quantity, and expiration or retest date.
3. A minimum of 12 months of remaining shelf life is required at delivery unless Buyer approves otherwise in writing.
4. Vendor must provide a current Safety Data Sheet (SDS) and specification sheet with the first shipment of any material and whenever they change.
5. Material must be shipped in clean, sealed, intact packaging suitable for food/supplement-grade ingredients.',
  '1. Acceptance. Shipment of the goods or written acknowledgment of this purchase order constitutes acceptance of its terms.
2. Pricing. Prices are firm as stated. No price increase, surcharge, or additional fee is valid without Buyer''s written approval before shipment.
3. Substitutions. No substitution of item, grade, source, or specification without Buyer''s prior written approval.
4. Inspection and rejection. Buyer may inspect goods on receipt and reject goods that do not conform to this order. Rejected goods will be replaced or credited at Vendor''s expense, including return freight.
5. Delivery. Vendor will promptly notify Buyer of any anticipated delay. Buyer may cancel any portion not delivered by the needed-by date.
6. Invoicing and payment. Invoices must reference the PO number. Payment terms run from the later of the invoice date or receipt of conforming goods.
7. Changes. This order may be changed only by a written revision issued by Buyer.',
  '{"same_as_bill_to": true, "name": "", "contact_name": "", "phone": "", "address_line1": "", "address_line2": "", "city": "", "state": "", "zip": "", "country": "", "delivery_instructions": ""}'::jsonb
where not exists (select 1 from company_profiles where display_name = 'BotanIQals');

insert into company_profiles (
  display_name, legal_name, po_prefix, accent_color,
  default_payment_terms, default_shipping_method, default_freight_terms,
  default_special_instructions, default_terms_text, ship_to_default
)
select
  'MiniLeaf', 'KCG Ventures LLC', 'KCG-PO', '#1d4e89',
  'Net 30', 'Vendor-arranged ground', 'Prepaid and added to invoice',
  null,
  '1. Acceptance. Shipment of the goods or written acknowledgment of this purchase order constitutes acceptance of its terms.
2. Pricing. Prices are firm as stated. No price increase, surcharge, or additional fee is valid without Buyer''s written approval before shipment.
3. Substitutions. No substitution of item, grade, source, or specification without Buyer''s prior written approval.
4. Inspection and rejection. Buyer may inspect goods on receipt and reject goods that do not conform to this order. Rejected goods will be replaced or credited at Vendor''s expense, including return freight.
5. Delivery. Vendor will promptly notify Buyer of any anticipated delay. Buyer may cancel any portion not delivered by the needed-by date.
6. Invoicing and payment. Invoices must reference the PO number. Payment terms run from the later of the invoice date or receipt of conforming goods.
7. Changes. This order may be changed only by a written revision issued by Buyer.',
  '{"same_as_bill_to": true, "name": "", "contact_name": "", "phone": "", "address_line1": "", "address_line2": "", "city": "", "state": "", "zip": "", "country": "", "delivery_instructions": ""}'::jsonb
where not exists (select 1 from company_profiles where display_name = 'MiniLeaf');
