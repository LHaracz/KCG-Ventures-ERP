// Database rules for batch-level finished goods: the product-total
// invariant, production batches and codes, manual batches, counts, picking
// with batches, reversal on return to picking, and automatic out-of-stock
// flags. Real migration SQL in PGlite; invented TEST- orders only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestBoxes, FIX, rpc } from "./helpers/fulfillmentDb";
import { BFIX, createBatchDb, invariantViolations, onHand, seedBatch, trackProducts } from "./helpers/batchDb";

let pg: PGlite;

beforeEach(async () => {
  ({ pg } = await createBatchDb());
});

const expectInvariant = async () => expect(await invariantViolations(pg)).toEqual([]);
const batchRow = async (id: string) =>
  (await pg.query<any>(`select * from finished_goods_batches where id = $1`, [id])).rows[0];
const txs = async (productId: string) =>
  (await pg.query<any>(`select type, quantity_delta, resulting_qty, batch_remaining_after, order_ref from inventory_transactions where product_id = $1 order by created_at, type`, [productId])).rows;
const statusOf = async (orderId: string) =>
  (await pg.query<any>(`select * from order_status where shopify_order_id = $1`, [orderId])).rows[0];

describe("migration and the product-total invariant", () => {
  it("leaves existing counts untouched and products untracked", async () => {
    expect(await onHand(pg, FIX.gum)).toBe(34);
    expect(await onHand(pg, BFIX.rinse)).toBe(54);
    const r = await pg.query<any>(`select bool_or(batch_tracked) as any_tracked from finished_products_inventory`);
    expect(r.rows[0].any_tracked).toBe(false);
  });

  it("is safe to run twice", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    await pg.exec(readFileSync(path.resolve(__dirname, "../../supabase-migrations/finished_goods_batches.sql"), "utf8"));
    expect(await onHand(pg, FIX.gum)).toBe(34);
  });

  it("tracked products' count equals their active batches, and direct edits are rejected", async () => {
    await seedBatch(pg, FIX.gum, "000039", 30, "2026-10-31T14:00:00Z");
    await trackProducts(pg, [FIX.gum]);
    expect(await onHand(pg, FIX.gum)).toBe(30);
    await expect(pg.query(`update finished_products_inventory set on_hand_qty = 99 where product_id = '${FIX.gum}'`)).rejects.toThrow(
      /tracked by batch/,
    );
    // An untracked product can still be edited the old way.
    await pg.query(`update finished_products_inventory set on_hand_qty = 50 where product_id = '${BFIX.rinse}'`);
    await expect(pg.query(`update finished_products_inventory set batch_tracked = false where product_id = '${FIX.gum}'`)).rejects.toThrow(
      /cannot be turned off/,
    );
    await expectInvariant();
  });

  it("batches can't be deleted or have their code changed; remaining can't go negative", async () => {
    const id = await seedBatch(pg, FIX.gum, "000039", 5, "2026-10-31T14:00:00Z");
    await expect(pg.query(`delete from finished_goods_batches where id = '${id}'`)).rejects.toThrow(/never deleted/);
    await expect(pg.query(`update finished_goods_batches set batch_code = '999999' where id = '${id}'`)).rejects.toThrow(/cannot be changed/);
    await expect(pg.query(`update finished_goods_batches set remaining_qty = -1 where id = '${id}'`)).rejects.toThrow();
  });
});

describe("production batches", () => {
  const complete = (cycleId: string, actuals: Record<string, number>, snapshot: object = { lines: [], total_cost: 12.5 }) =>
    rpc(pg, "complete_botaniqals_production", { p_cycle_id: cycleId, p_actuals: actuals, p_snapshot: snapshot, p_completed_at: "2026-11-03T15:00:00Z" });

  it("refuses products that aren't batch tracked yet (counts are never replaced)", async () => {
    const r = await complete(BFIX.cycle1, { [FIX.gum]: 40 });
    expect(r.error?.message).toMatch(/not batch tracked yet/);
    expect(await onHand(pg, FIX.gum)).toBe(34);
    expect((await pg.query(`select status from production_cycles where id = '${BFIX.cycle1}'`)).rows[0]).toMatchObject({ status: "planned" });
  });

  it("creates one batch per product with actual > 0, with a code above every existing code and above the Cup's opening code", async () => {
    // Opening seed: the Cup gets a code below the lowest existing one.
    await seedBatch(pg, BFIX.cup, "000033", 90, "2026-09-13T16:00:00Z");
    await trackProducts(pg, [FIX.gum, FIX.spray, BFIX.cup]);
    const r = await complete(BFIX.cycle1, { [FIX.gum]: 40, [FIX.spray]: 0 }, { lines: [{ ingredient: "Invented gum base", unit: "g", qty_used: 400, cost_per_unit: 0.01, line_cost: 4 }], total_cost: 4, sale_price_per_unit: 6 });
    expect(r.error).toBeNull();
    const batches = (r.data as any).batches;
    expect(batches).toHaveLength(1);
    expect(batches[0].batch_code).toBe("000041");
    const all = await pg.query<{ code: string }>(`select batch_id as code from botaniqals_production_batches where batch_id <> '000041' union select batch_code from finished_goods_batches where batch_code <> '000041'`);
    for (const row of all.rows) expect(Number(batches[0].batch_code)).toBeGreaterThan(Number(row.code));
    expect(batches[0].batch_code).not.toBe("000033");
    expect(await onHand(pg, FIX.gum)).toBe(40);
    expect(await txs(FIX.gum)).toEqual([{ type: "batch_receipt", quantity_delta: 40, resulting_qty: 40, batch_remaining_after: 40, order_ref: null }]);
    const cycle = (await pg.query<any>(`select status, completed_at, finished_goods_applied_at from production_cycles where id = '${BFIX.cycle1}'`)).rows[0];
    expect(cycle.status).toBe("completed");
    expect(cycle.finished_goods_applied_at).not.toBeNull();
    const snap = (await pg.query<any>(`select total_cost, sale_price_per_unit, actual_quantities from cycle_completion_snapshots where production_cycle_id = '${BFIX.cycle1}'`)).rows[0];
    expect(Number(snap.total_cost)).toBe(4);
    expect(snap.actual_quantities).toEqual({ [FIX.gum]: 40, [FIX.spray]: 0 });
    // Completing again changes nothing.
    const again = await complete(BFIX.cycle1, { [FIX.gum]: 40 });
    expect((again.data as any).already_completed).toBe(true);
    expect(await onHand(pg, FIX.gum)).toBe(40);
    await expectInvariant();
  });

  it("refuses MiniLeaf cycles and fractional quantities", async () => {
    await trackProducts(pg, [FIX.gum]);
    expect((await complete(BFIX.cycleMini, { [FIX.gum]: 1 })).error?.message).toMatch(/BotanIQals cycles only/);
    expect((await complete(BFIX.cycle1, { [FIX.gum]: 1.5 })).error?.message).toMatch(/whole numbers/);
  });

  it("manual batches take a code from the same sequence and noon New York on the production date", async () => {
    await trackProducts(pg, [BFIX.rinse]);
    const r = await rpc(pg, "add_manual_batch", { p_product_id: BFIX.rinse, p_qty: 54, p_produced_date: "2026-11-01", p_note: "Found box", p_name: "Test Person" });
    expect(r.error).toBeNull();
    expect((r.data as any).batch_code).toBe("000041");
    const b = await batchRow((r.data as any).batch_id);
    expect(new Date(b.submitted_at).toISOString()).toBe("2026-11-01T17:00:00.000Z") // 1 Nov 2026: DST has ended, noon EST;
    expect(b.source).toBe("manual");
    expect(await onHand(pg, BFIX.rinse)).toBe(54);
    expect((await rpc(pg, "add_manual_batch", { p_product_id: BFIX.rinse, p_qty: 0, p_produced_date: "2026-11-01", p_note: null, p_name: "X" })).error?.message).toMatch(/greater than 0/);
    await expectInvariant();
  });
});

describe("count_batches", () => {
  let b1: string;
  let b2: string;
  beforeEach(async () => {
    b1 = await seedBatch(pg, FIX.gum, "000038", 5, "2026-10-18T20:00:00Z");
    b2 = await seedBatch(pg, FIX.gum, "000039", 10, "2026-10-31T14:00:00Z");
    await pg.query(`update finished_goods_batches set needs_count = true`);
    await trackProducts(pg, [FIX.gum]);
  });

  it("sets counts, writes transactions, depletes at 0 and clears needs_count", async () => {
    const r = await rpc(pg, "count_batches", {
      p_counts: [
        { batch_id: b1, expected_remaining: 5, counted_qty: 0, reason: "Sold at market" },
        { batch_id: b2, expected_remaining: 10, counted_qty: 10, reason: null },
      ],
      p_name: "Test Person",
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ changed: 1, counted: 2 });
    expect(await batchRow(b1)).toMatchObject({ remaining_qty: 0, status: "depleted", needs_count: false });
    expect((await batchRow(b1)).depleted_at).not.toBeNull();
    expect(await batchRow(b2)).toMatchObject({ remaining_qty: 10, status: "active", needs_count: false });
    expect(await onHand(pg, FIX.gum)).toBe(10);
    expect((await txs(FIX.gum)).filter((t) => t.type === "batch_cycle_count")).toEqual([
      { type: "batch_cycle_count", quantity_delta: -5, resulting_qty: 10, batch_remaining_after: 0, order_ref: null },
    ]);
    // A depleted batch counted above 0 comes back.
    await rpc(pg, "count_batches", { p_counts: [{ batch_id: b1, expected_remaining: 0, counted_qty: 2, reason: "Recount" }] });
    expect(await batchRow(b1)).toMatchObject({ remaining_qty: 2, status: "active", depleted_at: null });
    await expectInvariant();
  });

  it("rejects the whole call if any batch changed since the count was opened", async () => {
    const r = await rpc(pg, "count_batches", {
      p_counts: [
        { batch_id: b1, expected_remaining: 5, counted_qty: 4, reason: "Damaged" },
        { batch_id: b2, expected_remaining: 9, counted_qty: 8, reason: "Recount" },
      ],
    });
    expect(r.error?.message).toBe("Batch 000039 changed since you opened the count. Re-enter it.");
    expect((r.error as any).hint).toBe("count_stale");
    expect((await batchRow(b1)).remaining_qty).toBe(5);
  });

  it("requires a reason when the count differs", async () => {
    const r = await rpc(pg, "count_batches", { p_counts: [{ batch_id: b1, expected_remaining: 5, counted_qty: 3, reason: " " }] });
    expect(r.error?.message).toBe("A reason is required for batch 000038.");
  });
});

describe("picking with batches", () => {
  let boxes: Record<number, string>;
  let bOld: string;
  let bNew: string;
  beforeEach(async () => {
    boxes = await createTestBoxes(pg, [901, 902, 903]);
    bOld = await seedBatch(pg, FIX.gum, "000038", 2, "2026-10-18T20:00:00Z");
    bNew = await seedBatch(pg, FIX.gum, "000039", 10, "2026-10-31T14:00:00Z");
    await trackProducts(pg, [FIX.gum]);
  });
  const pick = (orderId: string, box: number, allocations: unknown, required: unknown, override?: string) =>
    rpc(pg, "mark_order_picked", {
      p_order_id: orderId, p_box_id: boxes[box], p_order_name: `#${orderId}`,
      p_allocations: allocations, p_required: required, ...(override ? { p_override_reason: override } : {}),
    });

  it("decrements batches, records picks and transactions with the box assignment", async () => {
    const r = await pick("TEST-1", 901, [
      { product_id: FIX.gum, batch_id: bOld, qty: 2 },
      { product_id: FIX.gum, batch_id: bNew, qty: 1 },
    ], { [FIX.gum]: 3, [FIX.pea]: 1 });
    expect(r.error).toBeNull();
    expect(await batchRow(bOld)).toMatchObject({ remaining_qty: 0, status: "depleted" });
    expect((await batchRow(bNew)).remaining_qty).toBe(9);
    expect(await onHand(pg, FIX.gum)).toBe(9);
    const picks = await pg.query<any>(`select batch_id, qty, is_override from order_batch_picks where order_id = 'TEST-1' order by qty desc`);
    expect(picks.rows).toEqual([{ batch_id: bOld, qty: 2, is_override: false }, { batch_id: bNew, qty: 1, is_override: false }]);
    expect((await txs(FIX.gum)).filter((t) => t.type === "batch_pick").map((t) => t.order_ref)).toEqual(["TEST-1", "TEST-1"]);
    expect((await statusOf("TEST-1")).status).toBe("picked");
    await expectInvariant();
  });

  it("rolls back everything when quantities don't match, a batch is short, or the batch holds another product", async () => {
    const before = await onHand(pg, FIX.gum);
    const cases = [
      [[{ product_id: FIX.gum, batch_id: bNew, qty: 2 }], { [FIX.gum]: 3 }, /must add up to 3/],
      [[{ product_id: FIX.gum, batch_id: bOld, qty: 3 }], { [FIX.gum]: 3 }, /Batch 000038 shows 2 units. Count the box first./],
      [[{ product_id: FIX.spray, batch_id: bNew, qty: 1 }], { [FIX.gum]: 0, [FIX.spray]: 1 }, /does not hold that product/],
      [[], { [FIX.gum]: 1 }, /must add up to 1/],
    ] as const;
    for (const [alloc, required, msg] of cases) {
      const r = await pick("TEST-2", 901, alloc, required);
      expect(r.error?.message).toMatch(msg);
    }
    expect(await onHand(pg, FIX.gum)).toBe(before);
    expect(await statusOf("TEST-2")).toBeUndefined();
    expect((await pg.query(`select 1 from staging_box_assignments where order_id = 'TEST-2'`)).rows).toHaveLength(0);
  });

  it("ignores untracked products and records overrides with their reason", async () => {
    expect((await pick("TEST-3", 901, [], { [FIX.pea]: 2 })).error).toBeNull();
    const r = await pick("TEST-4", 902, [{ product_id: FIX.gum, batch_id: bNew, qty: 1 }], { [FIX.gum]: 1 }, "Mislabeled box");
    expect(r.error).toBeNull();
    const p = (await pg.query<any>(`select is_override, override_reason from order_batch_picks where order_id = 'TEST-4'`)).rows[0];
    expect(p).toEqual({ is_override: true, override_reason: "Mislabeled box" });
  });

  it("return to picking and box release put units back into the same batches (reactivating emptied ones)", async () => {
    await pick("TEST-1", 901, [{ product_id: FIX.gum, batch_id: bOld, qty: 2 }], { [FIX.gum]: 2 });
    expect((await batchRow(bOld)).status).toBe("depleted");
    const r = await rpc(pg, "return_order_to_picking", { p_order_id: "TEST-1" });
    expect(r.error).toBeNull();
    expect(await batchRow(bOld)).toMatchObject({ remaining_qty: 2, status: "active", depleted_at: null });
    expect((await pg.query<any>(`select reversed_at is not null as rev from order_batch_picks where order_id = 'TEST-1'`)).rows[0].rev).toBe(true);
    expect((await txs(FIX.gum)).map((t) => t.type)).toContain("batch_pick_reversal");

    await pick("TEST-1", 902, [{ product_id: FIX.gum, batch_id: bNew, qty: 5 }], { [FIX.gum]: 5 });
    expect((await batchRow(bNew)).remaining_qty).toBe(5);
    await rpc(pg, "release_staging_box", { p_box_id: boxes[902], p_reason: "Box crushed" });
    expect((await batchRow(bNew)).remaining_qty).toBe(10);
    expect(await onHand(pg, FIX.gum)).toBe(12);
    await expectInvariant();
  });

  it("picks are append-only except reversal", async () => {
    await pick("TEST-1", 901, [{ product_id: FIX.gum, batch_id: bNew, qty: 1 }], { [FIX.gum]: 1 });
    await expect(pg.query(`delete from order_batch_picks`)).rejects.toThrow(/never deleted/);
    await expect(pg.query(`update order_batch_picks set qty = 5`)).rejects.toThrow(/only be reversed/);
  });

  it("orders already picked before batches existed are not affected", async () => {
    // In-flight orders from the earlier build keep working (exempt).
    expect((await statusOf("TEST-INFLIGHT-GEN")).status).toBe("label_generated");
    expect((await pg.query(`select 1 from order_batch_picks where order_id like 'TEST-INFLIGHT%'`)).rows).toHaveLength(0);
  });
});

describe("sync_out_of_stock_flags", () => {
  const detail = [{ product_id: FIX.gum, product: "Test Gum", needed: 3, available: 1, short_by: 2 }];
  const sync = (short: unknown, covered: string[]) => rpc(pg, "sync_out_of_stock_flags", { p_short: short, p_covered: covered });

  it("flags short orders once, updates the detail, and clears only automatic flags", async () => {
    let r = await sync([{ order_id: "TEST-S", detail }], []);
    expect(r.data).toMatchObject({ flagged: 1 });
    expect(await statusOf("TEST-S")).toMatchObject({
      is_flagged: true, flagged_reason: "Item(s) out of stock", flagged_by: "System", flag_source: "auto_out_of_stock",
    });
    r = await sync([{ order_id: "TEST-S", detail }], []);
    expect(r.data).toEqual({ flagged: 0, updated: 0, cleared: 0 });
    r = await sync([{ order_id: "TEST-S", detail: [{ ...detail[0], available: 0, short_by: 3 }] }], []);
    expect(r.data).toMatchObject({ updated: 1 });

    // A manual flag is never touched.
    await pg.query(`insert into order_status (shopify_order_id, is_flagged, flagged_reason) values ('TEST-M', true, 'Address check')`);
    r = await sync([{ order_id: "TEST-M", detail }], ["TEST-M"]);
    expect(r.data).toEqual({ flagged: 0, updated: 0, cleared: 0 });
    expect(await statusOf("TEST-M")).toMatchObject({ flag_source: "manual", flagged_reason: "Address check" });

    r = await sync([], ["TEST-S"]);
    expect(r.data).toMatchObject({ cleared: 1 });
    expect(await statusOf("TEST-S")).toMatchObject({ is_flagged: false, flag_source: null, flag_detail: null });
    const ev = await pg.query<any>(`select event_type from order_events where order_id = 'TEST-S' order by created_at`);
    expect(ev.rows.map((e) => e.event_type)).toEqual(["auto_flagged_out_of_stock", "auto_unflagged"]);
  });

  it("only flags orders waiting to be picked", async () => {
    const r = await sync([{ order_id: "TEST-INFLIGHT-GEN", detail }], []);
    expect(r.data).toMatchObject({ flagged: 0 });
    expect((await statusOf("TEST-INFLIGHT-GEN")).is_flagged).toBe(false);
  });

  it("an automatic flag can't be cleared by hand; editing its reason makes it manual", async () => {
    await sync([{ order_id: "TEST-S", detail }], []);
    await expect(pg.query(`update order_status set is_flagged = false, flagged_reason = null where shopify_order_id = 'TEST-S'`)).rejects.toThrow(
      /Still out of stock. Count a batch or add stock first./,
    );
    await pg.query(`update order_status set flagged_reason = 'Customer asked to wait' where shopify_order_id = 'TEST-S'`);
    expect((await statusOf("TEST-S")).flag_source).toBe("manual");
    // Now manual: the sync no longer clears it, and it can be unflagged by hand.
    expect((await sync([], ["TEST-S"])).data).toMatchObject({ cleared: 0 });
    await pg.query(`update order_status set is_flagged = false, flagged_reason = null where shopify_order_id = 'TEST-S'`);
  });

  it("existing flags became manual flags in the migration", async () => {
    const { pg: pg2 } = await createBatchDb({
      beforeMigration: async (p) => {
        await p.query(`insert into order_status (shopify_order_id, is_flagged, flagged_reason) values ('TEST-OLD-FLAG', true, 'Old')`);
      },
    });
    const r = await pg2.query<any>(`select flag_source from order_status where shopify_order_id = 'TEST-OLD-FLAG'`);
    expect(r.rows[0].flag_source).toBe("manual");
  });
});

describe("test cleanup", () => {
  it("removes only [TEST] products' batches and TEST- orders' picks", async () => {
    await pg.query(`insert into products (id, name) values ('40000000-0000-4000-8000-000000000001', '[TEST] Paste')`);
    await pg.query(`insert into finished_products_inventory (product_id, batch_tracked) values ('40000000-0000-4000-8000-000000000001', true)`);
    await seedBatch(pg, "40000000-0000-4000-8000-000000000001", "900001", 3, "2026-01-01T00:00:00Z");
    const real = await seedBatch(pg, FIX.gum, "000039", 3, "2026-01-01T00:00:00Z");
    await rpc(pg, "fg_test_cleanup", { p_product_ids: ["40000000-0000-4000-8000-000000000001", FIX.gum], p_order_ids: [] });
    expect((await pg.query(`select 1 from finished_goods_batches where batch_code = '900001'`)).rows).toHaveLength(0);
    expect(await batchRow(real)).toBeDefined();
  });
});
