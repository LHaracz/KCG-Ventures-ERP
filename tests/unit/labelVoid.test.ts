/* eslint-disable @typescript-eslint/no-explicit-any -- loose types for test fakes and database rows */
// Void Label at any stage, replacement labels after fulfillment, and orders
// staying visible until fulfilled. Real migration SQL in PGlite; EasyPost and
// Shopify are fakes (succeeding, rejecting, failing, throttled, userErrors).
// Invented TEST- orders only; nothing calls a real service.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestBoxes, FIX } from "./helpers/fulfillmentDb";
import { createBatchDb } from "./helpers/batchDb";

type ShopifyMode = "ok" | "userErrors" | "throttled" | "network";
const h = vi.hoisted(() => ({
  db: null as any,
  refunds: [] as string[],
  refundMode: "submitted" as "submitted" | "reject" | "network" | "server",
  retrieveStatus: "refunded",
  shopifyMode: "ok" as ShopifyMode,
  shopifyCalls: [] as Array<{ op: string; vars: any }>,
  buys: 0,
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return h.db;
  },
}));
vi.mock("@/lib/apiAuth", () => ({
  requireApiUserFromBearerToken: async () => ({ id: "00000000-0000-4000-8000-000000000001" }),
}));
vi.mock("@/lib/access/api", () => {
  const user = { id: "00000000-0000-4000-8000-000000000001" };
  const access = {
    userId: user.id, accountId: null, status: "active", email: "packer1@example.test", firstName: "Test", lastName: "Packer",
    roles: ["Admin"], fullName: "Test Packer", active: true, isAdmin: true, features: new Set<string>(),
  };
  return { guardApi: async () => null, callerOf: () => ({ user, access }), userFromRequest: async () => user };
});
vi.mock("@/lib/easypost", async (orig) => {
  const actual = await orig<typeof import("@/lib/easypost")>();
  const fakeRefund = async (id: string) => {
    h.refunds.push(id);
    if (h.refundMode === "reject") throw new actual.EasyPostApiError("Unable to request refund. The parcel has been shipped.", 422);
    if (h.refundMode === "network") throw new Error("fetch failed");
    if (h.refundMode === "server") throw new actual.EasyPostApiError("Internal error", 503);
    return { id, refund_status: "submitted", tracker: { status: "pre_transit" } };
  };
  return {
    ...actual,
    refundEasyPostShipment: fakeRefund,
    requestRefundOutcome: (id: string) => actual.requestRefundOutcome(id, fakeRefund),
    retrieveEasyPostShipment: async (id: string) => ({ id, refund_status: h.retrieveStatus, tracker: { status: "pre_transit" } }),
    buyEasyPostRate: async (shipmentId: string) => {
      h.buys += 1;
      return {
        id: `${shipmentId}-${h.buys}`,
        tracking_code: `TEST-TRK-${h.buys}`,
        postage_label: { label_url: "https://example.invalid/label.pdf" },
        selected_rate: { carrier: "USPS", service: "GroundAdvantage", rate: "4.50", currency: "USD" },
        tracker: { id: `trk_${h.buys}`, public_url: `https://example.invalid/track/${h.buys}` },
      };
    },
  };
});
vi.mock("@/lib/shopifyAdmin", async (orig) => {
  const actual = await orig<typeof import("@/lib/shopifyAdmin")>();
  return {
    ...actual,
    shopifyAdminGraphQL: async (query: string, vars: any) => {
      const op = query.includes("fulfillmentCreate")
        ? "fulfillmentCreate"
        : query.includes("fulfillmentTrackingInfoUpdate")
          ? "trackingUpdate"
          : query.includes("OrderFulfillments")
            ? "orderFulfillments"
            : query.includes("RecentlyFulfilledOrders")
              ? "nodes"
              : query.includes("UnfulfilledOrders")
                ? "orders"
                : "fulfillmentOrders";
      h.shopifyCalls.push({ op, vars });
      if (op === "fulfillmentCreate") return { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/77", status: "SUCCESS" }, userErrors: [] } };
      if (op === "fulfillmentOrders") return { order: { fulfillmentOrders: { edges: [{ node: { id: "gid://shopify/FulfillmentOrder/1" } }] } } };
      if (op === "orderFulfillments") return { order: { fulfillments: [{ id: "gid://shopify/Fulfillment/88", status: "SUCCESS", createdAt: "2026-10-02T00:00:00Z" }] } };
      if (op === "trackingUpdate") {
        if (h.shopifyMode === "throttled") throw new actual.ShopifyAdminGraphQLError("Shopify GraphQL error: Throttled");
        if (h.shopifyMode === "network") throw new Error("fetch failed");
        if (h.shopifyMode === "userErrors") return { fulfillmentTrackingInfoUpdate: { fulfillment: null, userErrors: [{ field: ["number"], message: "Tracking number is invalid" }] } };
        return { fulfillmentTrackingInfoUpdate: { fulfillment: { id: vars.fulfillmentId }, userErrors: [] } };
      }
      return {};
    },
  };
});

import { POST as buyLabel } from "@/app/api/fulfillments/[orderId]/buy-label/route";
import { POST as voidLabel } from "@/app/api/fulfillments/[orderId]/void-label/route";
import { POST as markFulfilled } from "@/app/api/fulfillments/[orderId]/mark-fulfilled/route";
import { POST as printLabel } from "@/app/api/fulfillments/[orderId]/print-label/route";
import { POST as refund } from "@/app/api/fulfillments/[orderId]/refund/route";
import { POST as shopifyRetry } from "@/app/api/fulfillments/[orderId]/shopify-tracking/route";
import { POST as pick } from "@/app/api/fulfillments/[orderId]/pick/route";
import { GET as listOrders } from "@/app/api/fulfillments/route";
import { loadWarehouseSnapshot } from "@/lib/warehouse";
import { createShopifyOrdersSource, loadFulfillmentOrders } from "@/lib/fulfillmentOrdersLoader";

/** Shipping Assignments data, from the cached orders (no Shopify). */
async function snapshot() {
  const { orders } = await loadFulfillmentOrders(h.db, { fetchOrders: async () => ({ live: [], recentlyFulfilled: [] }) }, { logger: { warn: vi.fn(), error: vi.fn() } });
  return loadWarehouseSnapshot(h.db, orders);
}

let pg: PGlite;
let boxes: Record<number, string>;

const req = (body: unknown) =>
  new Request("http://test.local/api", { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify(body) });
const getReq = () => new Request("http://test.local/api", { headers: { Authorization: "Bearer t" } });
const ctx = (orderId: string) => ({ params: Promise.resolve({ orderId }) });
const statusOf = async (orderId: string) =>
  (await pg.query<{ status: string }>(`select status from order_status where shopify_order_id = $1`, [orderId])).rows[0]?.status ?? null;
const openBox = async (orderId: string) =>
  (await pg.query(`select 1 from staging_box_assignments where order_id = $1 and released_at is null`, [orderId])).rows.length > 0;
const labels = async (orderId: string) =>
  (await pg.query<any>(`select * from fulfillment_log where shopify_order_id = $1 order by created_at`, [orderId])).rows;
const activeLabel = async (orderId: string) => (await labels(orderId)).find((l) => !l.voided_at);

async function seedOrder(orderId: string) {
  const payload = {
    orderId, name: `[TEST] ${orderId}`, createdAt: "2026-10-01T15:00:00Z", customerName: "Invented Customer", itemCount: 2,
    totalProductWeightOz: 3, totalPrice: 12, currencyCode: "USD", lineItems: [{ name: "[TEST] Gum", quantity: 2 }],
  };
  await pg.query(`insert into fulfillment_orders_cache (shopify_order_id, payload, source) values ($1, $2, 'test')`, [orderId, JSON.stringify(payload)]);
}

/** Picked into box 901 with a bought label (status label_generated). */
async function labelGenerated(orderId = "TEST-1", box = 901) {
  expect((await pick(req({ boxId: boxes[box] }), ctx(orderId))).status).toBe(200);
  expect((await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx(orderId))).status).toBe(200);
}
async function labelPrinted(orderId = "TEST-1", box = 901) {
  await labelGenerated(orderId, box);
  const r = await printLabel(req({ logId: (await activeLabel(orderId)).id }), ctx(orderId));
  expect(await r.json()).toMatchObject({ status: "label_printed" });
}
async function fulfilled(orderId = "TEST-1", box = 901) {
  await labelPrinted(orderId, box);
  expect((await markFulfilled(req({}), ctx(orderId))).status).toBe(200);
}
const ageRefundRequest = (orderId: string) =>
  pg.query(`update fulfillment_log set refund_requested_at = now() - interval '10 minutes' where shopify_order_id = $1`, [orderId]);

beforeEach(async () => {
  const created = await createBatchDb();
  pg = created.pg;
  h.db = created.client;
  h.refunds = [];
  h.refundMode = "submitted";
  h.retrieveStatus = "refunded";
  h.shopifyMode = "ok";
  h.shopifyCalls = [];
  h.buys = 0;
  boxes = await createTestBoxes(pg, [901, 902, 903]);
  await pg.exec(`
    insert into variant_component_map (lineitem_name, business, components) values
      ('[TEST] Gum', 'botaniqals', '[{"product_id":"${FIX.gum}","qty_per_unit":1}]');
    insert into product_packaging_rules (product_id, points, min_package_id) values ('${FIX.gum}', 1, null);
  `);
  for (const id of ["TEST-1", "TEST-2", "TEST-3", "TEST-4"]) await seedOrder(id);
  await pg.query(`update fulfillment_orders_cache_state set last_refreshed_at = now(), last_attempt_at = now() + interval '1 hour'`);
});

describe("Void Label at every stage", () => {
  it("label_generated: refund requested, label voided, back to Picked in its box", async () => {
    await labelGenerated();
    const r = await voidLabel(req({ note: "wrong address" }), ctx("TEST-1"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ voided: true, status: "picked", fulfilled: false, refund: { status: "submitted" } });
    expect(await statusOf("TEST-1")).toBe("picked");
    expect(await openBox("TEST-1")).toBe(true);
    const [l] = await labels("TEST-1");
    expect(l).toMatchObject({ refund_status: "submitted", void_note: "wrong address", easypost_tracker_status: "pre_transit" });
    expect(l.voided_at).not.toBeNull();
    expect(h.refunds).toHaveLength(1);
  });

  it("label_printed: an EasyPost rejection still voids the label and records why", async () => {
    await labelPrinted();
    h.refundMode = "reject";
    const errors = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await voidLabel(req({}), ctx("TEST-1"));
    errors.mockRestore();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      status: "picked",
      refund: { status: "rejected", message: "Unable to request refund. The parcel has been shipped." },
    });
    const [l] = await labels("TEST-1");
    expect(l).toMatchObject({ refund_status: "rejected", refund_message: "Unable to request refund. The parcel has been shipped." });
    expect(l.voided_at).not.toBeNull();
    expect(await openBox("TEST-1")).toBe(true);
  });

  it("an order with a label but no box goes back to Preparing Shipment", async () => {
    await pg.exec(`
      insert into order_status (shopify_order_id, status) values ('TEST-2', 'label_generated');
      insert into fulfillment_log (shopify_order_id, tracking_number, easypost_shipment_id) values ('TEST-2', 'TEST-TRK-X', 'shp_x');
    `);
    const r = await voidLabel(req({}), ctx("TEST-2"));
    expect(await r.json()).toMatchObject({ status: "preparing_shipment" });
  });

  it("network and server errors still void, as refund_status error", async () => {
    await labelGenerated();
    h.refundMode = "network";
    expect(await (await voidLabel(req({}), ctx("TEST-1"))).json()).toMatchObject({ refund: { status: "error", message: "fetch failed" } });
    await labelGenerated("TEST-2", 902);
    h.refundMode = "server";
    expect(await (await voidLabel(req({}), ctx("TEST-2"))).json()).toMatchObject({ refund: { status: "error" } });
  });

  it("fulfilled: stays fulfilled, box stays free, no batches or inventory touched, Needs new label", async () => {
    await fulfilled();
    expect(await openBox("TEST-1")).toBe(false);
    const before = await pg.query(`select
      (select count(*) from inventory_transactions)::int as tx,
      (select count(*) from order_batch_picks)::int as picks,
      (select coalesce(sum(remaining_qty), 0)::int from finished_goods_batches) as remaining,
      (select coalesce(sum(on_hand_qty), 0)::int from finished_products_inventory) as on_hand,
      (select count(*) from staging_box_assignments)::int as assignments`);
    h.shopifyCalls = [];
    h.refundMode = "reject";
    const r = await voidLabel(req({}), ctx("TEST-1"));
    expect(await r.json()).toMatchObject({ voided: true, status: "fulfilled", fulfilled: true, refund: { status: "rejected" } });
    expect(await statusOf("TEST-1")).toBe("fulfilled");
    expect(await openBox("TEST-1")).toBe(false);
    expect(h.shopifyCalls).toEqual([]);
    const after = await pg.query(`select
      (select count(*) from inventory_transactions)::int as tx,
      (select count(*) from order_batch_picks)::int as picks,
      (select coalesce(sum(remaining_qty), 0)::int from finished_goods_batches) as remaining,
      (select coalesce(sum(on_hand_qty), 0)::int from finished_products_inventory) as on_hand,
      (select count(*) from staging_box_assignments)::int as assignments`);
    expect(after.rows).toEqual(before.rows);

    const list = await (await listOrders(getReq())).json();
    expect(list.orders.find((o: any) => o.orderId === "TEST-1")).toMatchObject({ status: "fulfilled", needsNewLabel: true });
    expect(list.orders.find((o: any) => o.orderId === "TEST-2")).toMatchObject({ needsNewLabel: false });
  });

  it("never requests the refund twice for the same label", async () => {
    await labelGenerated();
    const realRpc = h.db.rpc.bind(h.db);
    let failOnce = true;
    h.db = {
      ...h.db,
      from: h.db.from.bind(h.db),
      rpc: (fn: string, args: any) => {
        if (fn === "complete_label_void" && failOnce) {
          failOnce = false;
          return Promise.resolve({ data: null, error: { message: "simulated outage" } });
        }
        return realRpc(fn, args);
      },
    };
    expect((await voidLabel(req({}), ctx("TEST-1"))).status).toBe(500);
    expect(h.refunds).toHaveLength(1);
    // A second click right away: the first void is still "in flight".
    expect((await voidLabel(req({}), ctx("TEST-1"))).status).toBe(409);
    await ageRefundRequest("TEST-1");
    const r = await voidLabel(req({}), ctx("TEST-1"));
    expect(r.status).toBe(200);
    expect(h.refunds).toHaveLength(1);
    expect((await labels("TEST-1"))[0].voided_at).not.toBeNull();
  });

  it("there is nothing to void without an active label", async () => {
    await labelGenerated();
    await voidLabel(req({}), ctx("TEST-1"));
    expect((await voidLabel(req({}), ctx("TEST-1"))).status).toBe(400);
  });
});

describe("Retry refund and Check status", () => {
  it("retries once after a rejection, then is blocked once submitted", async () => {
    await labelPrinted();
    h.refundMode = "reject";
    await voidLabel(req({}), ctx("TEST-1"));
    const logId = (await labels("TEST-1"))[0].id;
    // A double click right after is refused.
    expect((await refund(req({ logId, action: "retry" }), ctx("TEST-1"))).status).toBe(409);
    await ageRefundRequest("TEST-1");
    h.refundMode = "submitted";
    const r = await refund(req({ logId, action: "retry" }), ctx("TEST-1"));
    expect(await r.json()).toMatchObject({ ok: true, refund: { status: "submitted" } });
    expect(h.refunds).toHaveLength(2);
    await ageRefundRequest("TEST-1");
    const again = await refund(req({ logId, action: "retry" }), ctx("TEST-1"));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "refund_not_retryable" });
    expect(h.refunds).toHaveLength(2);

    // Check status reads EasyPost and stores the answer; then nothing to retry.
    const checked = await refund(req({ logId, action: "check" }), ctx("TEST-1"));
    expect(await checked.json()).toMatchObject({ refund: { status: "refunded" } });
    expect((await labels("TEST-1"))[0].refund_status).toBe("refunded");
    await ageRefundRequest("TEST-1");
    expect((await refund(req({ logId, action: "retry" }), ctx("TEST-1"))).status).toBe(409);
    expect((await refund(req({ logId, action: "check" }), ctx("TEST-1"))).status).toBe(409);
  });

  it("a refund cannot be retried on a label that is not voided", async () => {
    await labelGenerated();
    const logId = (await labels("TEST-1"))[0].id;
    expect(await (await refund(req({ logId, action: "retry" }), ctx("TEST-1"))).json()).toMatchObject({ code: "not_voided" });
  });
});

describe("Replacement label after fulfillment", () => {
  it("only a fulfilled order with no active label may buy one; Shopify gets the new tracking number", async () => {
    await fulfilled();
    // Active label on a fulfilled order: refused.
    const refused = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "label_exists" });
    expect(h.buys).toBe(1);

    await voidLabel(req({}), ctx("TEST-1"));
    h.shopifyCalls = [];
    const r = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test", notifyCustomer: false }), ctx("TEST-1"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ bought: true, replacement: true, trackingNumber: "TEST-TRK-2", shopify: { ok: true } });
    expect(await statusOf("TEST-1")).toBe("fulfilled");
    // The stored fulfillment id from Mark Fulfilled is used: no lookup, no new fulfillment.
    expect(h.shopifyCalls.map((c) => c.op)).toEqual(["trackingUpdate"]);
    expect(h.shopifyCalls[0].vars).toMatchObject({
      fulfillmentId: "gid://shopify/Fulfillment/77",
      trackingInfoInput: { company: "USPS", number: "TEST-TRK-2", url: "https://example.invalid/track/2" },
      notifyCustomer: false,
    });
    const l = await activeLabel("TEST-1");
    expect(l).toMatchObject({ is_replacement: true, notify_customer: false, shopify_fulfillment_id: "gid://shopify/Fulfillment/77", shopify_sync_error: null });
    expect(l.shopify_tracking_synced_at).not.toBeNull();
    expect(await openBox("TEST-1")).toBe(false);

    // Print Label on the replacement: printed_at only, order stays fulfilled.
    const printed = await printLabel(req({ logId: l.id }), ctx("TEST-1"));
    expect(await printed.json()).toMatchObject({ status: "fulfilled" });
    expect((await activeLabel("TEST-1")).printed_at).not.toBeNull();
    expect(await statusOf("TEST-1")).toBe("fulfilled");

    // A second replacement while this one is active: refused.
    expect((await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"))).status).toBe(409);
    // Mark Fulfilled is never part of this path.
    expect(h.shopifyCalls.filter((c) => c.op === "fulfillmentCreate")).toEqual([]);

    const list = await (await listOrders(getReq())).json();
    expect(list.orders.find((o: any) => o.orderId === "TEST-1")).toMatchObject({ needsNewLabel: false });
  });

  it("looks up the fulfillment id when none is stored, notifying by default", async () => {
    await fulfilled();
    await pg.query(`update fulfillment_log set shopify_fulfillment_id = null where shopify_order_id = 'TEST-1'`);
    await voidLabel(req({}), ctx("TEST-1"));
    h.shopifyCalls = [];
    await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
    expect(h.shopifyCalls.map((c) => c.op)).toEqual(["orderFulfillments", "trackingUpdate"]);
    expect(h.shopifyCalls[1].vars).toMatchObject({ fulfillmentId: "gid://shopify/Fulfillment/88", notifyCustomer: true });
    expect((await activeLabel("TEST-1")).shopify_fulfillment_id).toBe("gid://shopify/Fulfillment/88");
  });

  for (const mode of ["userErrors", "throttled", "network"] as const) {
    it(`a Shopify failure (${mode}) keeps the label and records the error; Retry Shopify update fixes it`, async () => {
      await fulfilled();
      await voidLabel(req({}), ctx("TEST-1"));
      h.shopifyMode = mode;
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-1"));
      quiet.mockRestore();
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ bought: true, replacement: true, shopify: { ok: false } });
      const l = await activeLabel("TEST-1");
      expect(l.voided_at).toBeNull();
      expect(l.shopify_sync_error).toBeTruthy();
      expect(l.shopify_tracking_synced_at).toBeNull();
      expect(await statusOf("TEST-1")).toBe("fulfilled");

      h.shopifyMode = "ok";
      const retry = await shopifyRetry(req({ logId: l.id }), ctx("TEST-1"));
      expect(retry.status).toBe(200);
      const fixed = await activeLabel("TEST-1");
      expect(fixed.shopify_sync_error).toBeNull();
      expect(fixed.shopify_tracking_synced_at).not.toBeNull();
    });
  }

  it("a fulfilled order with no label at all cannot buy one (fulfilled outside the ERP)", async () => {
    await pg.query(`insert into order_status (shopify_order_id, status) values ('TEST-3', 'fulfilled')`);
    const r = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-3"));
    expect(await r.json()).toMatchObject({ code: "already_fulfilled" });
  });

  it("preparing_shipment orders still cannot buy a label", async () => {
    const r = await buyLabel(req({ easypostShipmentId: "shp_test", rateId: "rate_test" }), ctx("TEST-4"));
    expect(await r.json()).toMatchObject({ code: "not_picked" });
    expect(h.buys).toBe(0);
  });
});

describe("Orders stay visible until fulfilled", () => {
  it("every unfulfilled status is on the list, and picked..label_printed are on Shipping Assignments with their box", async () => {
    await pick(req({ boxId: boxes[901] }), ctx("TEST-1")); // picked
    await labelGenerated("TEST-2", 902); // label_generated
    await labelPrinted("TEST-3", 903); // label_printed
    // TEST-4 stays preparing_shipment.
    await pg.query(`select reconcile_staging_assignments()`);
    const list = await (await listOrders(getReq())).json();
    const byId = new Map(list.orders.map((o: any) => [o.orderId, o]));
    expect(byId.get("TEST-4")).toMatchObject({ status: "preparing_shipment" });
    expect(byId.get("TEST-1")).toMatchObject({ status: "picked" });
    expect(byId.get("TEST-2")).toMatchObject({ status: "label_generated" });
    expect(byId.get("TEST-3")).toMatchObject({ status: "label_printed" });

    const snap = await snapshot();
    const SHIP = ["picked", "label_generated", "label_printed"];
    const ship = snap.orders.filter((o) => SHIP.includes(o.status));
    expect(ship.map((o) => [o.orderId, o.status, o.boxLabel]).sort()).toEqual([
      ["TEST-1", "picked", "STG-901"],
      ["TEST-2", "label_generated", "STG-902"],
      ["TEST-3", "label_printed", "STG-903"],
    ]);
    expect(ship.every((o) => o.packaging.key)).toBe(true);

    // Fulfilled: drops off Shipping Assignments and the box frees.
    expect((await markFulfilled(req({}), ctx("TEST-3"))).status).toBe(200);
    expect(await openBox("TEST-3")).toBe(false);
    const snap2 = await snapshot();
    expect(snap2.orders.filter((o) => SHIP.includes(o.status)).map((o) => o.orderId).sort()).toEqual(["TEST-1", "TEST-2"]);
    const list2 = await (await listOrders(getReq())).json();
    expect(list2.orders.find((o: any) => o.orderId === "TEST-3")).toMatchObject({ status: "fulfilled" });
  });

  it("nothing releases a box at label_printed (print, reconcile, list loads)", async () => {
    await labelPrinted();
    await pg.query(`select reconcile_staging_assignments()`);
    await listOrders(getReq());
    await snapshot();
    expect(await statusOf("TEST-1")).toBe("label_printed");
    expect(await openBox("TEST-1")).toBe(true);
  });

  it("an order Shopify no longer lists as unfulfilled stays on the list while the ERP has it at label_printed", async () => {
    await pg.exec(`
      insert into order_status (shopify_order_id, status) values ('900010', 'label_printed'), ('900011', 'fulfilled');
      insert into staging_box_assignments (order_id, order_name, staging_box_id) values ('900010', '#T10', '${boxes[901]}');
    `);
    const node = (id: string, name: string) => ({
      __typename: "Order", id: `gid://shopify/Order/${id}`, name, createdAt: "2026-10-01T15:00:00Z",
      customer: { firstName: "Invented", lastName: "Person" }, totalPriceSet: { shopMoney: { amount: "9.00", currencyCode: "USD" } },
      lineItems: { edges: [{ node: { name: "[TEST] Gum", quantity: 1, weight: { value: 1, unit: "OUNCES" } } }] },
    });
    const seen: any[] = [];
    const graphql = async <T,>(query: string, vars?: any): Promise<T> => {
      if (query.includes("RecentlyFulfilledOrders")) {
        seen.push(vars.ids);
        return { nodes: vars.ids.map((gid: string) => (gid.endsWith("/900010") ? node("900010", "#T10") : null)) } as T;
      }
      // Shopify's unfulfilled list no longer has #T10 (fulfilled or closed there).
      return { orders: { edges: [{ node: node("900020", "#T20") }] } } as T;
    };
    await pg.query(`update fulfillment_orders_cache_state set last_attempt_at = null`);
    const r = await loadFulfillmentOrders(h.db, createShopifyOrdersSource(h.db, graphql), { logger: { warn: vi.fn(), error: vi.fn() } });
    expect(seen).toEqual([["gid://shopify/Order/900010"]]);
    const byId = new Map(r.orders.map((o) => [o.orderId, o]));
    expect(byId.get("900010")).toMatchObject({ name: "#T10", status: "label_printed" });
    expect(byId.get("900020")).toMatchObject({ status: "preparing_shipment" });
    // A fulfilled order the ERP did not fulfill recently is not pulled back in.
    expect(byId.has("900011")).toBe(false);
  });
});
