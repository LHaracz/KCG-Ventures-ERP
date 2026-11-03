/**
 * In-memory Postgres (PGlite) with the real fulfillment migrations applied,
 * for offline tests. Supabase's auth schema and roles are stubbed. Invented
 * data only. PGlite is a single connection, so it can't run a true
 * concurrent race or check RLS as a real logged-in user; those are covered by
 * tests/db/*.spec.ts against a dev Supabase/Postgres.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pgliteSupabase } from "./pgliteSupabase";

const root = path.resolve(__dirname, "../../..");
const sql = (f: string) => readFileSync(path.join(root, "supabase-migrations", f), "utf8");

export const FIX = {
  user: "00000000-0000-4000-8000-000000000001",
  gum: "10000000-0000-4000-8000-000000000001",
  spray: "10000000-0000-4000-8000-000000000002",
  paste: "10000000-0000-4000-8000-000000000003",
  pea: "10000000-0000-4000-8000-000000000004",
  mailer: "20000000-0000-4000-8000-000000000001",
  small: "20000000-0000-4000-8000-000000000002",
  big: "20000000-0000-4000-8000-000000000003",
};

export async function createFulfillmentDb() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create table products (id uuid primary key default gen_random_uuid(), name text not null,
      is_microgreen boolean not null default false, deleted_at timestamptz);
    create table variant_component_map (id uuid primary key default gen_random_uuid(), lineitem_name text not null unique,
      business text not null, components jsonb not null default '[]'::jsonb);
  `);
  await pg.exec(sql("fulfillments_package_presets.sql"));
  await pg.exec(sql("fulfillments_status_pipeline.sql"));
  await pg.exec(sql("order_status_manual_flagging.sql"));
  // Rows that exist before the migration (in-flight orders must be untouched).
  await pg.exec(`
    insert into auth.users (id) values ('${FIX.user}');
    insert into order_status (shopify_order_id, status) values
      ('TEST-INFLIGHT-GEN', 'label_generated'), ('TEST-INFLIGHT-PRINTED', 'label_printed'), ('TEST-INFLIGHT-DONE', 'fulfilled');
  `);
  await pg.exec(sql("fulfillment_picking_staging.sql"));
  await pg.exec(`
    insert into products (id, name, is_microgreen) values
      ('${FIX.gum}', 'Test Gum', false), ('${FIX.spray}', 'Test Spray', false),
      ('${FIX.paste}', 'Test Paste', false), ('${FIX.pea}', 'Test Pea Shoots', true);
    insert into package_presets (id, user_id, nickname, length_in, width_in, height_in, tare_weight_oz, max_points) values
      ('${FIX.mailer}', '${FIX.user}', 'Test Mailer', 9, 6, 1, 0.5, 4),
      ('${FIX.small}', '${FIX.user}', 'Test Small', 8, 6, 4, 3, 10),
      ('${FIX.big}', '${FIX.user}', 'Test Big', 12, 10, 6, 6, 25);
  `);
  return { pg, client: pgliteSupabase(pg) };
}

/** Runs an RPC and returns { data, error } like supabase-js (error.message is the raised message). */
export async function rpc(pg: PGlite, fn: string, args: Record<string, unknown>) {
  return pgliteSupabase(pg).rpc(fn, args);
}

export async function createTestBoxes(pg: PGlite, numbers: number[]): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const n of numbers) {
    const r = await pg.query<{ id: string }>(
      `insert into staging_boxes (box_number, is_test) values ($1, true) returning id`,
      [n],
    );
    out[n] = r.rows[0].id;
  }
  return out;
}
