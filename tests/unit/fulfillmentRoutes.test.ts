// API routes for picking, label purchase gating, void and Mark Fulfilled,
// run against the real migration SQL (PGlite). Auth, EasyPost and Shopify
// are replaced by fakes; invented TEST- orders only. No real orders, labels,
// formulas or inventory are touched.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestBoxes, FIX } from "./helpers/fulfillmentDb";
import { createBatchDb as createFulfillmentDb, seedBatch, trackProducts } from "./helpers/batchDb";

const h = vi.hoisted(() => ({
  db: null as any,
  easypostBuys: 0,
  easypostRefunds: 0,
  shopifyCalls: [] as string[],
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return h.db;
  },
}));
vi.mock("@/lib/apiAuth", () => ({
  requireApiUserFromBearerToken: async () => ({ id: "00000000-0000-4000-8000-000000000001" }),
}));
vi.mock("@/lib/easypost", () => ({
  buyEasyPostRate: async (shipmentId: string) => {
    h.easypostBuys += 1;
    return {
      id: shipmentId,
      tracking_code: `TEST-TRK-${h.easypostBuys}`,
      postage_label: { label_url: "https://example.invalid/label.pdf" },
      selected_rate: { carrier: "USPS", service: "GroundAdvantage", rate: "4.50", currency: "USD" },
    };
  },
  refundEasyPostShipment: async () => {
    h.easypostRefunds += 1;
    return {};
  },
}));
vi.mock("@/lib/shopifyAdmin", async (orig) => {
  const actual = await orig<typeof import("@/lib/shopifyAdmin")>();
  return {
    ...actual,
    shopifyAdminGraphQL: async (query: string) => {
      h.shopifyCalls.push(query.includes("fulfillmentCreate") ? "fulfillmentCreate" : "fulfillmentOrders");
      if (query.includes("fulfillmentCreate")) return { fulfillmentCreate: { fulfillment: { id: "f1", status: "SUCCESS" }, userErrors: [] } };
      return { order: { fulfillmentOrders: { edges: [{ node: { id: "gid://shopify/FulfillmentOrder/1" } }] } } };
    },
  };
});

import { POST as buyLabel } from "@/app/api/fulfillments/[orderId]/buy-label/route";
import { POST as voidLabel } from "@/app/api/fulfillments/[orderId]/void-label/route";
import { POST as markFulfilled } from "@/app/api/fulfillments/[orderId]/mark-fulfilled/route";
import { POST as pick } from "@/app/api/fulfillments/[orderId]/pick/route";
import { POST as setPackaging } from "@/app/api/fulfillments/[orderId]/packaging/route";
import { GET as warehouse } from "@/app/api/fulfillments/warehouse/route";
import { loadWarehouseSnapshot } from "@/lib/warehouse";
import { loadFulfillmentOrders } from "@/lib/fulfillmentOrdersLoader";

let pg: PGlite;
let boxes: Record<number, string>;

const req = (body: unknown) =>
  new Request("http://test.local/api", { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ctx = (orderId: string) => ({ params: Promise.resolve({ orderId }) });
const status = async (orderId: string) =>
  (await pg.query<{ status: string }>(`select status from order_status where shopify_order_id = $1`, [orderId])).rows[0]?.status ?? null;
const openBox = async (orderId: string) =>
  (await pg.query(`select 1 from staging_box_assignments where order_id = $1 and released_at is null`, [orderId])).rows.length > 0;

async function seedOrder(orderId: string, name: string, lineItems: Array<{ name: string; quantity: number }>) {
  const payload = {
    orderId, name, createdAt: "2026-10-01T15:00:00Z", customerName: "Invented Customer", itemCount: 1,
    totalProductWeightOz: 3, totalPrice: 12, currencyCode: "USD", lineItems,
  };
  await pg.query(`insert into fulfillment_orders_cache (shopify_order_id, payload, source) values ($1, $2, 'test')`, [orderId, JSON.stringify(payload)]);
}

beforeEach(async () => {
  const created = await createFulfillmentDb();
  pg = created.pg;
  h.db = created.client;
  h.easypostBuys = 0;
  h.easypostRefunds = 0;
  h.shopifyCalls = [];
  boxes = await createTestBoxes(pg, [901, 902]);
  await pg.exec(`
    insert into variant_component_map (lineitem_name, business, components) values
      ('[TEST] Gum', 'botaniqals', '[{"product_id":"${FIX.gum}","qty_per_unit":1}]'),
      ('[TEST] Spray', 'botaniqals', '[{"product_id":"${FIX.spray}","qty_per_unit":1}]');
    insert into product_packaging_rules (product_id, points, min_package_id) values
      ('${FIX.gum}', 1, null), ('${FIX.spray}', 1, '${FIX.small}');
  `);
  await seedOrder("TEST-1", "[TEST] #1", [{ name: "[TEST] Gum", quantity: 2 }]);
  await seedOrder("TEST-2", "[TEST] #2", [{ name: "[TEST] Gum", quantity: 2 }, { name: "[TEST] Spray", quantity: 1 }]);
  await seedOrder("TEST-U", "[TEST] #U", [{ name: "[TEST] Unmapped Thing", quantity: 1 }]);
  // The order list comes from the cache; keep the loader from refreshing.
  await pg.query(`update fulfillment_orders_cache_state set last_refreshed_at = now(), last_attempt_at = now() + interval '1 hour'`);
});

describe("pick route", () => {
  it("refuses unmapped orders server side and picks mapped ones", async () => {
    const u = await pick(req({ boxId: boxes[901] }), ctx("TEST-U"));
    expect(u.status).toBe(409);
    expect((await u.json()).error).toBe("Map the line item before picking.");
    const r = await pick(req({ boxId: boxes[901] }), ctx("TEST-1"));
    expect(r.status).toBe(200);
    expect(await status("TEST-1")).toBe("picked");
  });

  it("box race: the loser gets the specific message and a 409", async () => {
    const [a, b] = await Promise.all([pick(req({ boxId: boxes[901] }), ctx("TEST-1")), pick(req({ boxId: boxes[901] }), ctx("TEST-2"))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await loser.json())).toMatchObject({ code: "box_in_use", error: expect.stringMatching(/^STG-901 is already holding order \[TEST\] #\d\.$/) });
  });
});

describe("Generate Label gating (server side)", () => {
  it("rejects preparing_shipment orders before EasyPost is called", async () => {
    const r = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("Pick this order first: assign a staging box on the Pick List.");
    expect(h.easypostBuys).toBe(0);
  });

  it("allows picked orders once, rejects a second purchase while a label is active", async () => {
    await pick(req({ boxId: boxes[901] }), ctx("TEST-1"));
    const first = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    expect(first.status).toBe(200);
    expect(await status("TEST-1")).toBe("label_generated");
    const second = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    expect(second.status).toBe(409);
    expect(h.easypostBuys).toBe(1);
  });

  it("does not block orders already past picking when this shipped (in-flight)", async () => {
    // TEST-INFLIGHT-GEN is label_generated with no log row (its label was
    // bought before this build); it is blocked only by the active-label rule.
    const r = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-INFLIGHT-GEN"));
    expect((await r.json()).code).toBe("label_exists");
  });
});

describe("Void Label and Mark Fulfilled routes", () => {
  it("void returns the order to Picked when it holds a box", async () => {
    await pick(req({ boxId: boxes[901] }), ctx("TEST-1"));
    await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    const v = await voidLabel(req({}), ctx("TEST-1"));
    expect(v.status).toBe(200);
    expect(await v.json()).toMatchObject({ voided: true, status: "picked" });
    expect(await status("TEST-1")).toBe("picked");
    expect(await openBox("TEST-1")).toBe(true);
  });

  it("Mark Fulfilled releases the box after Shopify and the ERP succeed", async () => {
    await pick(req({ boxId: boxes[901] }), ctx("TEST-1"));
    await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    await pg.query(`update order_status set status = 'label_printed' where shopify_order_id = 'TEST-1'`);
    const r = await markFulfilled(req({}), ctx("TEST-1"));
    expect(r.status).toBe(200);
    expect(h.shopifyCalls).toEqual(["fulfillmentOrders", "fulfillmentCreate"]);
    expect(await status("TEST-1")).toBe("fulfilled");
    expect(await openBox("TEST-1")).toBe(false);
    const a = await pg.query<any>(`select release_reason from staging_box_assignments where order_id = 'TEST-1'`);
    expect(a.rows[0].release_reason).toBe("fulfilled");
  });

  it("a failed box release does not fail Mark Fulfilled; reconcile frees the box later", async () => {
    await pick(req({ boxId: boxes[901] }), ctx("TEST-1"));
    await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    await pg.query(`update order_status set status = 'label_printed' where shopify_order_id = 'TEST-1'`);
    const realRpc = h.db.rpc.bind(h.db);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    h.db = { ...h.db, from: h.db.from.bind(h.db), rpc: (fn: string, args: any) => (fn === "release_assignment_on_fulfilled" ? Promise.resolve({ data: null, error: { message: "simulated outage" } }) : realRpc(fn, args)) };
    const r = await markFulfilled(req({}), ctx("TEST-1"));
    expect(r.status).toBe(200);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    expect(await openBox("TEST-1")).toBe(true);
    expect((await realRpc("reconcile_staging_assignments", {})).data).toBe(1);
    expect(await openBox("TEST-1")).toBe(false);
  });
});

describe("Shipping Assignments tabs and overrides", () => {
  const snapshot = async () => {
    const noShopify = { fetchOrders: async () => ({ live: [], recentlyFulfilled: [] }) };
    // The cache has only seeded test rows; mark it fresh so nothing refreshes.
    await pg.query(`update fulfillment_orders_cache_state set last_refreshed_at = now(), last_attempt_at = now()`);
    const { orders } = await loadFulfillmentOrders(h.db, noShopify);
    return loadWarehouseSnapshot(h.db, orders);
  };
  const tabOf = (snap: Awaited<ReturnType<typeof snapshot>>, id: string) => snap.orders.find((o) => o.orderId === id)!.packaging;

  it("places picked orders on their suggested tab, moves them on override (including Needs Review), and clearing restores", async () => {
    await pick(req({ boxId: boxes[901] }), ctx("TEST-1"));
    await pick(req({ boxId: boxes[902] }), ctx("TEST-2"));
    let snap = await snapshot();
    expect(snap.tabs.map((t) => t.nickname)).toEqual(["Test Mailer", "Test Small", "Test Big"]);
    expect(tabOf(snap, "TEST-1")).toMatchObject({ key: FIX.mailer, overridden: false });
    expect(tabOf(snap, "TEST-2")).toMatchObject({ key: FIX.small, reason: "Test Small: contains Test Spray (needs Test Small or larger)" });
    expect(tabOf(snap, "TEST-U")).toMatchObject({ key: "needs_review", reason: "Unmapped line item: [TEST] Unmapped Thing" });
    expect(snap.orders.find((o) => o.orderId === "TEST-1")!.boxLabel).toBe("STG-901");

    expect((await setPackaging(req({ action: "set", target: "preset", presetId: FIX.big }), ctx("TEST-1"))).status).toBe(200);
    snap = await snapshot();
    expect(tabOf(snap, "TEST-1")).toMatchObject({ key: FIX.big, overridden: true, suggestionLabel: "Test Mailer" });

    await setPackaging(req({ action: "set", target: "needs_review" }), ctx("TEST-1"));
    snap = await snapshot();
    expect(tabOf(snap, "TEST-1")).toMatchObject({ key: "needs_review", overridden: true });

    await setPackaging(req({ action: "clear" }), ctx("TEST-1"));
    snap = await snapshot();
    expect(tabOf(snap, "TEST-1")).toMatchObject({ key: FIX.mailer, overridden: false });

    const ev = await pg.query<any>(`select event_type, detail from order_events where order_id = 'TEST-1' and event_type like 'packaging%' order by created_at`);
    expect(ev.rows.map((e) => e.event_type)).toEqual(["packaging_override", "packaging_override", "packaging_override_cleared"]);
    expect(ev.rows[0].detail).toMatchObject({ previous: "Test Mailer", new: "Test Big" });
  });

  it("refuses overrides before the order is picked", async () => {
    const r = await setPackaging(req({ action: "set", target: "needs_review" }), ctx("TEST-1"));
    expect(r.status).toBe(409);
  });
});

describe("pick route with finished-goods batches", () => {
  let bOld: string;
  let bNew: string;
  beforeEach(async () => {
    bOld = await seedBatch(pg, FIX.gum, "000038", 3, "2026-10-18T20:00:00Z");
    bNew = await seedBatch(pg, FIX.gum, "000039", 10, "2026-10-31T14:00:00Z");
    await trackProducts(pg, [FIX.gum]);
  });
  const getWarehouse = async () => {
    const res = await (await warehouse(new Request("http://test.local/api", { headers: { Authorization: "Bearer t" } }))).json();
    if (!res.orders) throw new Error(`warehouse: ${JSON.stringify(res)}`);
    return res;
  };

  it("the Pick List shows the planned batches, and picking with them decrements the boxes", async () => {
    const w = await getWarehouse();
    const o1 = w.orders.find((o: any) => o.orderId === "TEST-1");
    const o2 = w.orders.find((o: any) => o.orderId === "TEST-2");
    // TEST-1 (2 Gum) is older: 2 from 000038. TEST-2 (2 Gum): 1 from 000038 + 1 from 000039.
    expect(o1.batchPlan.lines[0].parts).toEqual([{ batchId: bOld, batchCode: "000038", qty: 2 }]);
    expect(o2.batchPlan.lines[0].parts).toEqual([
      { batchId: bOld, batchCode: "000038", qty: 1 },
      { batchId: bNew, batchCode: "000039", qty: 1 },
    ]);
    expect(o2.batchPlan.emptiesBatchIds).toEqual([bOld]);
    const r = await pick(req({ boxId: boxes[901], allocations: [{ product_id: FIX.gum, batch_id: bOld, qty: 2 }] }), ctx("TEST-1"));
    expect(r.status).toBe(200);
    expect((await pg.query<any>(`select remaining_qty from finished_goods_batches where id = '${bOld}'`)).rows[0].remaining_qty).toBe(1);
  });

  it("rejects stale instructions with the new plan, then accepts the new ones", async () => {
    // The picker saw "2 from 000038" for TEST-2, but TEST-1 (older) was picked first.
    await pick(req({ boxId: boxes[901], allocations: [{ product_id: FIX.gum, batch_id: bOld, qty: 2 }] }), ctx("TEST-1"));
    const stale = await pick(req({ boxId: boxes[902], allocations: [{ product_id: FIX.gum, batch_id: bOld, qty: 2 }] }), ctx("TEST-2"));
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body).toMatchObject({ code: "plan_changed", error: "Batch instructions changed. Reloaded." });
    expect(body.plan.lines[0].parts.map((p: any) => [p.batchCode, p.qty])).toEqual([["000038", 1], ["000039", 1]]);
    const ok = await pick(req({ boxId: boxes[902], allocations: body.plan.lines[0].parts.map((p: any) => ({ product_id: FIX.gum, batch_id: p.batchId, qty: p.qty })) }), ctx("TEST-2"));
    expect(ok.status).toBe(200);
  });

  it("Picked from a different batch skips the plan comparison, needs a reason, and still checks stock", async () => {
    const noReason = await pick(req({ boxId: boxes[901], allocations: [{ product_id: FIX.gum, batch_id: bNew, qty: 2 }], override: { reason: " " } }), ctx("TEST-1"));
    expect(noReason.status).toBe(400);
    const tooMuch = await pick(req({ boxId: boxes[901], allocations: [{ product_id: FIX.gum, batch_id: bOld, qty: 2 }, { product_id: FIX.gum, batch_id: bOld, qty: 2 }] , override: { reason: "Grabbed wrong box" } }), ctx("TEST-1"));
    expect(tooMuch.status).toBe(409);
    const ok = await pick(req({ boxId: boxes[901], allocations: [{ product_id: FIX.gum, batch_id: bNew, qty: 2 }], override: { reason: "Mislabeled box" } }), ctx("TEST-1"));
    expect(ok.status).toBe(200);
    const p = (await pg.query<any>(`select batch_id, is_override, override_reason from order_batch_picks where order_id = 'TEST-1'`)).rows[0];
    expect(p).toEqual({ batch_id: bNew, is_override: true, override_reason: "Mislabeled box" });
  });

  it("out-of-stock orders are auto-flagged on refresh, refused at pick, and auto-cleared after a count", async () => {
    // 13 in boxes; TEST-1 (2) and TEST-2 (2+spray) fit; an order for 20 does not.
    await seedOrder("TEST-BIG", "[TEST] #BIG", [{ name: "[TEST] Gum", quantity: 20 }]);
    let w = await getWarehouse();
    const big = w.orders.find((o: any) => o.orderId === "TEST-BIG");
    expect(big).toMatchObject({ isFlagged: true, flagSource: "auto_out_of_stock", flaggedReason: "Item(s) out of stock" });
    expect(big.flagDetail).toEqual([{ product_id: FIX.gum, product: "Test Gum", needed: 20, available: 9, short_by: 11 }]);
    const r = await pick(req({ boxId: boxes[902], allocations: [] }), ctx("TEST-BIG"));
    expect(r.status).toBe(409);
    // Count the 000039 box at 30: the order is covered and the flag clears.
    await pg.query(`select count_batches('[{"batch_id":"${bNew}","expected_remaining":10,"counted_qty":30,"reason":"Recount"}]'::jsonb, 'Test')`);
    w = await getWarehouse();
    expect(w.orders.find((o: any) => o.orderId === "TEST-BIG")).toMatchObject({ isFlagged: false, flagSource: null });
  });
});
