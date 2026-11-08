/**
 * PGlite with the real migrations needed for employee access tests: the
 * fulfillment and batch migrations (via createBatchDb), the compliance, SOP
 * and purchase-order migrations, and employee_accounts_roles.sql.
 *
 * auth.uid() and auth.role() read the request.jwt.claim.* settings, like
 * Supabase. `asUser(pg, userId)` switches to the authenticated role with that
 * user, so row level security applies; `asService(pg)` switches back.
 * Invented data and example.test addresses only.
 */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createBatchDb } from "./batchDb";

const root = path.resolve(__dirname, "../../..");
export const migration = (f: string) => readFileSync(path.join(root, "supabase-migrations", f), "utf8");

export async function createAccessDb() {
  const { pg, client } = await createBatchDb();
  await pg.exec(`
    alter table auth.users add column if not exists email text;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role') $$;
    create schema if not exists storage;
    create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    grant usage on schema public, auth to anon, authenticated, service_role;
    -- Base tables that live outside the repo's migrations (shapes as used by the app).
    create table if not exists inventory_items (id uuid primary key default gen_random_uuid(), user_id uuid,
      name text, unit text, cost_per_unit numeric, par_level numeric, quantity_on_hand numeric default 0,
      last_count_date date, created_at timestamptz default now());
    create table if not exists inventory_adjustments (id uuid primary key default gen_random_uuid(), inventory_item uuid,
      adjustment_type text, quantity_delta numeric, note text, created_at timestamptz default now(), user_id uuid);
  `);
  for (const f of [
    "compliance_sops.sql",
    "sop_editable_documents.sql",
    "compliance_logs_core.sql",
    "compliance_logs_seed_templates.sql",
    "compliance_logs_receiving.sql",
    "compliance_logs_release_warnings.sql",
    "purchase_orders_core.sql",
    "purchase_orders_documents.sql",
    "employee_accounts_roles.sql",
  ]) {
    try {
      await pg.exec(migration(f));
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`);
    }
  }
  await pg.exec(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant usage, select on all sequences in schema public to authenticated;
    -- Like Supabase: the service role has full grants and bypasses RLS.
    alter role service_role bypassrls;
    grant all on all tables in schema public to service_role;
    grant all on all sequences in schema public to service_role;
    grant execute on all functions in schema public to service_role;
    revoke execute on function bootstrap_admins(text[]) from service_role;
  `);
  return { pg, client };
}

/** Runs migration 2 (policies) as the database owner, then re-applies test grants. */
export async function applyPolicies(pg: PGlite) {
  await asOwner(pg);
  await pg.exec(migration("employee_access_policies.sql"));
  await pg.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
}

let n = 0;
/** Creates an auth user (invented example.test address) and returns its id. */
export async function addAuthUser(pg: PGlite, email = `person${++n}@example.test`): Promise<string> {
  const r = await pg.query<{ id: string }>(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email]);
  return r.rows[0].id;
}

/** Acts as a signed-in user: authenticated role, with RLS. */
export async function asUser(pg: PGlite, userId: string) {
  await pg.exec(`reset role`);
  await pg.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [userId]);
  await pg.exec(`set role authenticated`);
}
/** Acts as anon (no user). */
export async function asAnon(pg: PGlite) {
  await pg.exec(`reset role`);
  await pg.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'anon', false)`);
  await pg.exec(`set role anon`);
}
/** Back to the database owner (like the SQL editor; bypasses RLS). */
export async function asOwner(pg: PGlite) {
  await pg.exec(`reset role`);
  await pg.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)`);
}
/** Service role: what server code uses. */
export async function asService(pg: PGlite) {
  await pg.exec(`reset role`);
  await pg.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'service_role', false)`);
  await pg.exec(`set role service_role`);
}

export const roleId = async (pg: PGlite, name: string) =>
  (await pg.query<{ id: string }>(`select id from roles where lower(name) = lower($1)`, [name])).rows[0]?.id;

/** An active account (owner-side insert) with the given roles. Returns { userId, accountId }. */
export async function addEmployee(
  pg: PGlite,
  opts: { roles: string[]; status?: "invited" | "active" | "deactivated"; first?: string; last?: string; email?: string },
) {
  const userId = await addAuthUser(pg, opts.email);
  const email = (await pg.query<{ email: string }>(`select email from auth.users where id = $1`, [userId])).rows[0].email;
  const acc = await pg.query<{ id: string }>(
    `insert into employee_accounts (user_id, email, first_name, last_name, status, invited_at, accepted_at)
     values ($1, $2, $3, $4, 'active', now(), now()) returning id`,
    [userId, email, opts.first ?? "Test", opts.last ?? "Person"],
  );
  const accountId = acc.rows[0].id;
  for (const r of opts.roles) {
    await pg.query(`insert into employee_roles (employee_id, role_id) values ($1, $2)`, [accountId, await roleId(pg, r)]);
  }
  if (opts.status && opts.status !== "active") {
    await pg.query(`update employee_accounts set status = $2 where id = $1`, [accountId, opts.status]);
  }
  return { userId, accountId, email };
}
