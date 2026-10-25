-- Compliance Logs: release-warnings panel (Phase 5). Run
-- compliance_logs_core.sql first. Run in the Supabase SQL editor.
--
-- One row per Complete Production attempt on a BotanIQals cycle (including
-- every re-completion after a Reopen — old rows are kept, never updated).
-- No existing table is touched by this file.
create table if not exists batch_compliance_reviews (
  id uuid primary key default gen_random_uuid(),
  production_cycle_id uuid not null references production_cycles(id) on delete cascade,
  warnings jsonb not null default '[]'::jsonb,
  acknowledged_by_name text,
  acknowledged_note text,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_batch_compliance_reviews_cycle_id on batch_compliance_reviews(production_cycle_id);
create index if not exists idx_batch_compliance_reviews_created_at on batch_compliance_reviews(created_at);

alter table batch_compliance_reviews enable row level security;
drop policy if exists batch_compliance_reviews_select_policy on batch_compliance_reviews;
create policy batch_compliance_reviews_select_policy on batch_compliance_reviews
  for select using (auth.role() = 'authenticated');
drop policy if exists batch_compliance_reviews_insert_policy on batch_compliance_reviews;
create policy batch_compliance_reviews_insert_policy on batch_compliance_reviews
  for insert with check (auth.role() = 'authenticated');

-- No update/delete grant: each completion attempt gets its own row (a new
-- one on every re-completion after a Reopen), so past reviews are never
-- edited in place — matching how the Compliance column on Production
-- Cycles & Planner always reads "the latest row for this cycle".
grant select, insert on table batch_compliance_reviews to authenticated;
