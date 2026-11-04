// Batch allocation engine, with invented fixtures only.
import { describe, expect, it } from "vitest";
import { allocateBatches, batchInstruction, planAllocations, type AllocBatch, type AllocOrder } from "@/lib/batchAllocation";

const PASTE = "p-paste";
const GUM = "p-gum";
const SEEDS = "p-minileaf";
const tracked = new Set([PASTE, GUM]);
const names = new Map([
  [PASTE, "Paste"],
  [GUM, "Gum"],
]);

const batch = (id: string, code: string, productId: string, remaining: number, submittedAt = "2026-01-01T12:00:00Z"): AllocBatch => ({
  id,
  batchCode: code,
  productId,
  submittedAt,
  remainingQty: remaining,
  status: "active",
});
const order = (n: number, components: Array<[string, number]>): AllocOrder => ({
  orderId: `o${n}`,
  orderName: `#${1000 + n}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  components: components.map(([productId, qty]) => ({ productId, qty })),
});
const run = (orders: AllocOrder[], batches: AllocBatch[]) => allocateBatches({ orders, trackedProductIds: tracked, batches, productNames: names });

const A = batch("bA", "000020", PASTE, 20, "2026-01-01T12:00:00Z");
const B = batch("bB", "000021", PASTE, 30, "2026-02-01T12:00:00Z");
const fifty = Array.from({ length: 50 }, (_, i) => order(i + 1, [[PASTE, 1]]));

describe("allocateBatches", () => {
  it("50 orders of 1 Paste, batch A = 20, batch B = 30: orders 1-20 from A, 21-50 from B", () => {
    const r = run(fifty, [B, A]);
    r.orders.forEach((p, i) => {
      expect(p.state).toBe("covered");
      expect(p.lines[0].parts).toEqual([{ batchId: i < 20 ? "bA" : "bB", batchCode: i < 20 ? "000020" : "000021", qty: 1 }]);
    });
    expect(r.byOrderId.get("o20")!.emptiesBatchIds).toEqual(["bA"]);
    expect(r.byOrderId.get("o50")!.emptiesBatchIds).toEqual(["bB"]);
    expect(r.plannedQtyByBatchId.get("bA")).toBe(20);
    expect(r.byProductId.get(PASTE)).toEqual({ inBoxes: 50, awaitingPick: 50, available: 0 });
  });

  it("an order needing 3 with 2 left in A takes A x2 and B x1", () => {
    const r = run([order(1, [[PASTE, 3]])], [batch("bA", "000020", PASTE, 2), batch("bB", "000021", PASTE, 30, "2026-03-01T00:00:00Z")]);
    expect(r.orders[0].lines[0].parts).toEqual([
      { batchId: "bA", batchCode: "000020", qty: 2 },
      { batchId: "bB", batchCode: "000021", qty: 1 },
    ]);
    expect(batchInstruction(r.orders[0].lines[0])).toBe("3x Paste: Batch 000020 x2, Batch 000021 x1");
  });

  it("picking order 50 first (from B) leaves the other 49 with the same split", () => {
    const before = run(fifty, [A, B]);
    // Order 50 is picked out of B: it leaves the input and B loses 1.
    const after = run(fifty.slice(0, 49), [A, { ...B, remainingQty: 29 }]);
    for (const p of after.orders) {
      expect(p.lines[0].parts).toEqual(before.byOrderId.get(p.orderId)!.lines[0].parts);
    }
    expect(planAllocations(before.byOrderId.get("o50")!)).toEqual([{ product_id: PASTE, batch_id: "bB", qty: 1 }]);
  });

  it("a short order reserves nothing; a later order needing 1 takes the last unit", () => {
    const r = run([order(1, [[PASTE, 5]]), order(2, [[PASTE, 1]])], [batch("bA", "000020", PASTE, 1)]);
    expect(r.orders[0]).toMatchObject({ state: "short" });
    expect(r.orders[0].lines[0]).toMatchObject({ shortBy: 4, availableToOrder: 1, parts: [] });
    expect(r.orders[1]).toMatchObject({ state: "covered", emptiesBatchIds: ["bA"] });
  });

  it("multi-component order with one short component: whole order short, covered component not reserved", () => {
    const r = run(
      [order(1, [[PASTE, 1], [GUM, 3]]), order(2, [[PASTE, 1]])],
      [batch("bA", "000020", PASTE, 1), batch("bG", "000030", GUM, 2)],
    );
    expect(r.orders[0].state).toBe("short");
    expect(r.orders[0].lines.find((l) => l.productId === GUM)).toMatchObject({ shortBy: 1 });
    expect(r.orders[0].lines.find((l) => l.productId === PASTE)).toMatchObject({ shortBy: 0, parts: [] });
    // The Paste unit stays free for order 2.
    expect(r.orders[1].lines[0].parts).toEqual([{ batchId: "bA", batchCode: "000020", qty: 1 }]);
  });

  it("a tie on submitted_at resolves by batch code (numeric)", () => {
    const same = "2026-05-05T12:00:00Z";
    const r = run([order(1, [[PASTE, 1]])], [batch("z", "000100", PASTE, 5, same), batch("y", "000099", PASTE, 5, same)]);
    expect(r.orders[0].lines[0].parts[0].batchCode).toBe("000099");
  });

  it("ignores untracked products and skips zero-remaining batches", () => {
    const r = run(
      [order(1, [[SEEDS, 4]]), order(2, [[SEEDS, 1], [PASTE, 1]])],
      [batch("b0", "000010", PASTE, 0), batch("bA", "000020", PASTE, 3)],
    );
    expect(r.orders[0].state).toBe("not_tracked");
    expect(r.orders[1].lines).toHaveLength(1);
    expect(r.orders[1].lines[0].parts[0].batchId).toBe("bA");
    expect(r.byProductId.has(SEEDS)).toBe(false);
  });

  it("never plans a negative remaining quantity, and available may go negative", () => {
    const orders = Array.from({ length: 7 }, (_, i) => order(i + 1, [[GUM, 2]]));
    const r = run(orders, [batch("g1", "000031", GUM, 3), batch("g2", "000032", GUM, 4, "2026-09-01T00:00:00Z")]);
    const planned = (id: string) => r.plannedQtyByBatchId.get(id) ?? 0;
    expect(planned("g1")).toBeLessThanOrEqual(3);
    expect(planned("g2")).toBeLessThanOrEqual(4);
    expect(r.orders.filter((o) => o.state === "covered")).toHaveLength(3);
    expect(r.byProductId.get(GUM)).toEqual({ inBoxes: 7, awaitingPick: 14, available: -7 });
  });

  it("display order never changes the plan (input order is irrelevant)", () => {
    const reversed = run([...fifty].reverse(), [A, B]);
    const forward = run(fifty, [A, B]);
    for (const p of forward.orders) expect(reversed.byOrderId.get(p.orderId)!.lines).toEqual(p.lines);
  });

  it("rejects fractional quantities", () => {
    expect(() => run([order(1, [[PASTE, 1.5]])], [A])).toThrow(/whole number/);
  });
});
