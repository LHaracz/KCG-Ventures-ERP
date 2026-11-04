/**
 * PGlite with the picking schema plus the finished goods / production batch
 * migrations and finished_goods_batches.sql applied. Invented data only.
 * (botaniqals_batch_traceability_per_cycle.sql is skipped: it is UTF-16 and
 * its effect is superseded by the two fix_botaniqals_batches_* files.)
 */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createFulfillmentDb, FIX } from "./fulfillmentDb";

const root = path.resolve(__dirname, "../../..");
const sql = (f: string) => readFileSync(path.join(root, "supabase-migrations", f), "utf8");

export const BFIX = {
  ...FIX,
  rinse: "10000000-0000-4000-8000-000000000005",
  cup: "10000000-0000-4000-8000-000000000006",
  cycle1: "30000000-0000-4000-8000-000000000001",
  cycleMini: "30000000-0000-4000-8000-000000000002",
};

export async function createBatchDb(opts: { beforeMigration?: (pg: PGlite) => Promise<void> } = {}) {
  const { pg, client } = await createFulfillmentDb();
  await pg.exec(`
    create table production_cycles (
      id uuid primary key default gen_random_uuid(), user_id uuid, status text default 'planned',
      start_date date, end_date date, harvest_date date, business_type text, brand text,
      raw_materials_deducted_at timestamptz, finished_goods_applied_at timestamptz);
    create table product_variants (id uuid primary key default gen_random_uuid());
    create table orders (id uuid primary key default gen_random_uuid());
    insert into products (id, name) values ('${BFIX.rinse}', 'Test Rinse'), ('${BFIX.cup}', 'Test Cup');
  `);
  await pg.exec(sql("botaniqals_batch_traceability.sql"));
  await pg.exec(sql("fix_botaniqals_batches_unique_null_safe.sql"));
  await pg.exec(sql("fix_botaniqals_batches_upsert_conflict.sql"));
  await pg.exec(sql("finished_products_inventory.sql"));
  await pg.exec(sql("production_cycles_manual_actions.sql"));
  await pg.exec(`
    insert into production_cycles (id, user_id, status, start_date, end_date, business_type)
    values ('${BFIX.cycle1}', '${FIX.user}', 'planned', '2026-10-01', '2026-10-03', 'BotanIQals'),
           ('${BFIX.cycleMini}', '${FIX.user}', 'planned', '2026-10-01', '2026-10-03', 'MiniLeaf');
    -- Existing history: batch codes 000034..000040 already used.
    select setval('botaniqals_batch_seq', 33);
  `);
  for (let i = 0; i < 7; i++) {
    const cyc = await pg.query<{ id: string }>(
      `insert into production_cycles (user_id, status, business_type) values ('${FIX.user}', 'completed', 'BotanIQals') returning id`,
    );
    await pg.query(
      `insert into botaniqals_production_batches (user_id, production_cycle_id, product_id, quantity_produced, completed_at)
       values ('${FIX.user}', $1, '${FIX.gum}', 10, now() - interval '30 days')`,
      [cyc.rows[0].id],
    );
  }
  // Counts that exist before the batch migration (must be left untouched).
  await pg.exec(`
    update finished_products_inventory set on_hand_qty = 34 where product_id = '${FIX.gum}';
    update finished_products_inventory set on_hand_qty = 54 where product_id = '${BFIX.rinse}';
  `);
  if (opts.beforeMigration) await opts.beforeMigration(pg);
  await pg.exec(sql("finished_goods_batches.sql"));
  await pg.exec(sql("label_void_any_stage.sql"));
  return { pg, client };
}

/** Marks products as batch tracked (what the opening-batch script does), syncing their total. */
export async function trackProducts(pg: PGlite, productIds: string[]) {
  for (const id of productIds) {
    await pg.query(`update finished_products_inventory set batch_tracked = true where product_id = $1`, [id]);
    await pg.query(`select fg_sync_product($1)`, [id]);
  }
}

/** Inserts an active batch directly (test setup only). */
export async function seedBatch(pg: PGlite, productId: string, code: string, qty: number, submittedAt: string) {
  const r = await pg.query<{ id: string }>(
    `insert into finished_goods_batches (batch_code, product_id, submitted_at, initial_qty, remaining_qty, source)
     values ($1, $2, $3, $4, $4, 'opening_seed') returning id`,
    [code, productId, submittedAt, qty],
  );
  return r.rows[0].id;
}

export async function onHand(pg: PGlite, productId: string): Promise<number> {
  const r = await pg.query<{ on_hand_qty: number }>(`select on_hand_qty from finished_products_inventory where product_id = $1`, [productId]);
  return Number(r.rows[0]?.on_hand_qty ?? NaN);
}

/** The invariant: tracked on_hand_qty == sum of active batches, for every tracked product. */
export async function invariantViolations(pg: PGlite): Promise<unknown[]> {
  const r = await pg.query(`
    select f.product_id, f.on_hand_qty,
           coalesce((select sum(remaining_qty) from finished_goods_batches b where b.product_id = f.product_id and b.status = 'active'), 0) as batches
    from finished_products_inventory f
    where f.batch_tracked
      and f.on_hand_qty <> coalesce((select sum(remaining_qty) from finished_goods_batches b where b.product_id = f.product_id and b.status = 'active'), 0)`);
  return r.rows;
}
