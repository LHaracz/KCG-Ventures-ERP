// Opening-batch SQL (supabase-opening-batches/), against the real migrations
// in PGlite with invented data shaped like production (batch codes 000034 to
// 000040 already used).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { FIX } from "./helpers/fulfillmentDb";
import { BFIX, createBatchDb, invariantViolations, onHand } from "./helpers/batchDb";

const dir = path.resolve(__dirname, "../../supabase-opening-batches");
const file = (f: string) => readFileSync(path.join(dir, f), "utf8");

async function setup(mutate?: (pg: PGlite) => Promise<void>) {
  const { pg } = await createBatchDb();
  await pg.exec(`
    update products set name = 'BotanIQals Cup' where id = '${BFIX.cup}';
    update finished_products_inventory set on_hand_qty = 96 where product_id = '${BFIX.cup}';
  `);
  if (mutate) await mutate(pg);
  return pg;
}
const batchesOf = async (pg: PGlite, productId: string) =>
  (await pg.query<any>(`select batch_code, initial_qty, remaining_qty, status, needs_count, source, submitted_at from finished_goods_batches where product_id = $1`, [productId])).rows;

describe("opening batches", () => {
  it("preview is read-only and matches what apply does", async () => {
    const pg = await setup();
    const before = (await pg.query(`select count(*)::int as n from finished_goods_batches`)).rows[0] as any;
    const res = await pg.exec(file("01-preview.sql"));
    const rows = res[0].rows as any[];
    expect((await pg.query(`select count(*)::int as n from finished_goods_batches`)).rows[0]).toEqual(before);
    const byName = Object.fromEntries(rows.map((r) => [r.product, r]));
    expect(byName["BotanIQals Cup"]).toMatchObject({ starting_quantity: 90, resulting_count: 90 });
    expect(byName["BotanIQals Cup"].plan).toContain("000033");
    expect(byName["Test Gum"]).toMatchObject({ latest_completed_batch: "000040", starting_quantity: 10 });
    expect(byName["Test Rinse"]).toMatchObject({ starting_quantity: 54 });
    expect(byName["Test Spray"].plan).toBe("No batch, starts at 0");
    expect(res[1].rows[0]).toMatchObject({ botaniqals_cup_products: 1 });
  });

  it("apply seeds batches, replaces counts, and a second run creates nothing", async () => {
    const pg = await setup();
    await pg.exec(file("00-backup.sql"));
    const backups = await pg.query<any>(`select tablename from pg_tables where tablename like '%_backup_%' order by tablename`);
    expect(backups.rows).toHaveLength(2);

    await pg.exec(file("02-apply.sql"));
    // Gum: latest completed batch 000040 produced 10; count was 34 -> 10.
    expect(await batchesOf(pg, FIX.gum)).toMatchObject([{ batch_code: "000040", initial_qty: 10, remaining_qty: 10, needs_count: true, source: "opening_seed", status: "active" }]);
    expect(await onHand(pg, FIX.gum)).toBe(10);
    // Rinse: no production, 54 on hand -> one batch of 54 with the next code.
    expect(await batchesOf(pg, BFIX.rinse)).toMatchObject([{ batch_code: "000041", remaining_qty: 54, needs_count: true }]);
    // Cup: 90 in a code below the lowest, a day before the earliest batch at noon New York.
    const cup = (await batchesOf(pg, BFIX.cup))[0];
    expect(cup).toMatchObject({ batch_code: "000033", initial_qty: 90, remaining_qty: 90, needs_count: true });
    const earliest = (await pg.query<any>(`select min(coalesce(completed_at, created_at)) as t from botaniqals_production_batches`)).rows[0].t;
    expect(new Date(cup.submitted_at).getTime()).toBeLessThan(new Date(earliest).getTime());
    const nyHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(cup.submitted_at));
    expect(nyHour).toBe("12");
    expect(await onHand(pg, BFIX.cup)).toBe(90);
    // Spray: no production, 0 -> tracked with no batch.
    expect(await batchesOf(pg, FIX.spray)).toEqual([]);
    const tracked = await pg.query<any>(`select bool_and(batch_tracked) as all_tracked from finished_products_inventory f join products p on p.id = f.product_id where not p.is_microgreen`);
    expect(tracked.rows[0].all_tracked).toBe(true);
    // Transactions record the replaced counts.
    const tx = await pg.query<any>(`select product_id, quantity_delta, resulting_qty from inventory_transactions where type = 'batch_opening_seed' order by product_id`);
    expect(tx.rows.find((t) => t.product_id === BFIX.cup)).toMatchObject({ quantity_delta: -6, resulting_qty: 90 });
    expect(tx.rows.find((t) => t.product_id === FIX.gum)).toMatchObject({ quantity_delta: -24, resulting_qty: 10 });
    // New products are tracked from the start.
    await pg.query(`insert into products (id, name) values ('50000000-0000-4000-8000-000000000001', 'New Accessory')`);
    await pg.query(`insert into finished_products_inventory (product_id) values ('50000000-0000-4000-8000-000000000001')`);
    expect((await pg.query<any>(`select batch_tracked from finished_products_inventory where product_id = '50000000-0000-4000-8000-000000000001'`)).rows[0].batch_tracked).toBe(true);
    expect(await invariantViolations(pg)).toEqual([]);

    const countBefore = (await pg.query<any>(`select count(*)::int as n from finished_goods_batches`)).rows[0].n;
    const txBefore = (await pg.query<any>(`select count(*)::int as n from inventory_transactions`)).rows[0].n;
    await pg.exec(file("02-apply.sql"));
    expect((await pg.query<any>(`select count(*)::int as n from finished_goods_batches`)).rows[0].n).toBe(countBefore);
    expect((await pg.query<any>(`select count(*)::int as n from inventory_transactions`)).rows[0].n).toBe(txBefore);

    // The next production code is above every existing code and not the Cup's.
    const next = (await pg.query<any>(`select fg_next_batch_code() as c`)).rows[0].c;
    expect(next).toBe("000042");
  });

  it("changes nothing when there is no free code below the lowest", async () => {
    const pg = await setup(async (p) => {
      await p.query(`insert into finished_goods_batches (batch_code, product_id, submitted_at, initial_qty, remaining_qty, source)
                     values ('000001', '${FIX.paste}', '2026-01-01T00:00:00Z', 1, 1, 'manual')`);
    });
    await expect(pg.exec(file("02-apply.sql"))).rejects.toThrow(/No unused batch code exists below the lowest existing code \(000001\)/);
    expect(await onHand(pg, FIX.gum)).toBe(34);
    expect((await pg.query<any>(`select count(*)::int as n from finished_goods_batches`)).rows[0].n).toBe(1);
    expect((await pg.query<any>(`select bool_or(batch_tracked) as t from finished_products_inventory`)).rows[0].t).toBe(false);
  });

  it("changes nothing when the Cup is missing", async () => {
    const pg = await setup(async (p) => {
      await p.query(`update products set name = 'Cup (renamed)' where id = '${BFIX.cup}'`);
    });
    await expect(pg.exec(file("02-apply.sql"))).rejects.toThrow(/Expected exactly one active product named "BotanIQals Cup", found 0/);
    expect(await onHand(pg, BFIX.rinse)).toBe(54);
  });
});
