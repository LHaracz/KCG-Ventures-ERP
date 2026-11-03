// Orders cache: at most one Shopify refresh per minute, one refresher at a
// time, stale data served with a note when Shopify fails or throttles.
// Shopify is replaced by fakes at its boundary; invented orders only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createFulfillmentDb } from "./helpers/fulfillmentDb";
import {
  createShopifyOrdersSource,
  loadFulfillmentOrders,
  type CachedOrder,
  type OrdersSource,
} from "@/lib/fulfillmentOrdersLoader";

const order = (n: number, extra: Partial<CachedOrder> = {}): CachedOrder => ({
  orderId: `TEST-${n}`,
  name: `#T${n}`,
  createdAt: `2026-10-0${n}T14:00:00Z`,
  customerName: `Invented Customer ${n}`,
  itemCount: 1,
  totalProductWeightOz: 2,
  totalPrice: 10,
  currencyCode: "USD",
  lineItems: [{ name: "Invented Gum", quantity: 1 }],
  ...extra,
});

function fakeSource(impl: () => Promise<{ live: CachedOrder[]; recentlyFulfilled: CachedOrder[] }>) {
  const fetchOrders = vi.fn(impl);
  return { source: { fetchOrders } as OrdersSource, fetchOrders };
}

const quietLogger = () => ({ warn: vi.fn(), error: vi.fn() });

let pg: PGlite;
let db: any;

beforeEach(async () => {
  ({ pg, client: db } = await createFulfillmentDb());
});

const ageLastAttempt = (seconds: number) =>
  pg.query(`update fulfillment_orders_cache_state set last_attempt_at = now() - make_interval(secs => $1)`, [seconds]);

describe("loadFulfillmentOrders", () => {
  it("fills the cache from Shopify and merges live statuses", async () => {
    await pg.query(`insert into order_status (shopify_order_id, status, is_flagged, flagged_reason) values ('TEST-2', 'picked', true, 'Check address')`);
    const { source, fetchOrders } = fakeSource(async () => ({ live: [order(1), order(2)], recentlyFulfilled: [] }));
    const r = await loadFulfillmentOrders(db, source, { logger: quietLogger() });
    expect(fetchOrders).toHaveBeenCalledTimes(1);
    expect(r.meta.refreshedNow).toBe(true);
    expect(r.meta.lastRefreshedAt).not.toBeNull();
    const byId = new Map(r.orders.map((o) => [o.orderId, o]));
    expect(byId.get("TEST-1")).toMatchObject({ status: "preparing_shipment", isFlagged: false, lineItems: [{ name: "Invented Gum", quantity: 1 }] });
    expect(byId.get("TEST-2")).toMatchObject({ status: "picked", isFlagged: true, flaggedReason: "Check address" });
  });

  it("refreshes from Shopify at most once per minute", async () => {
    const { source, fetchOrders } = fakeSource(async () => ({ live: [order(1)], recentlyFulfilled: [] }));
    await loadFulfillmentOrders(db, source, { logger: quietLogger() });
    for (let i = 0; i < 5; i++) {
      const r = await loadFulfillmentOrders(db, source, { logger: quietLogger() });
      expect(r.meta.refreshedNow).toBe(false);
      expect(r.orders).toHaveLength(1);
    }
    expect(fetchOrders).toHaveBeenCalledTimes(1);
    await ageLastAttempt(59);
    await loadFulfillmentOrders(db, source, { logger: quietLogger() });
    expect(fetchOrders).toHaveBeenCalledTimes(1);
    await ageLastAttempt(61);
    await loadFulfillmentOrders(db, source, { logger: quietLogger() });
    expect(fetchOrders).toHaveBeenCalledTimes(2);
  });

  it("allows only one refresher at a time", async () => {
    const { source: first } = fakeSource(async () => ({ live: [order(1)], recentlyFulfilled: [] }));
    await loadFulfillmentOrders(db, first, { logger: quietLogger() });
    await ageLastAttempt(120);
    // Another request claims the refresh and is still working (lock held).
    const claimed = await db.rpc("fulfillment_cache_try_claim", { p_min_interval_seconds: 60, p_lock_seconds: 45 });
    expect(claimed.data).toBe(true);
    await ageLastAttempt(120); // even if the interval has passed, the lock still blocks
    const { source: second, fetchOrders } = fakeSource(async () => ({ live: [order(9)], recentlyFulfilled: [] }));
    const r = await loadFulfillmentOrders(db, second, { logger: quietLogger() });
    expect(fetchOrders).not.toHaveBeenCalled();
    expect(r.orders.map((o) => o.orderId)).toEqual(["TEST-1"]);
    // A second claim attempt while locked also loses.
    expect((await db.rpc("fulfillment_cache_try_claim", { p_min_interval_seconds: 0, p_lock_seconds: 45 })).data).toBe(false);
    // Lock expires -> the next caller may refresh.
    await pg.query(`update fulfillment_orders_cache_state set refresh_lock_until = now() - interval '1 second'`);
    await loadFulfillmentOrders(db, second, { logger: quietLogger() });
    expect(fetchOrders).toHaveBeenCalledTimes(1);
  });

  it("serves stale data with a Last updated note when Shopify fails", async () => {
    const { source } = fakeSource(async () => ({ live: [order(1)], recentlyFulfilled: [] }));
    const ok = await loadFulfillmentOrders(db, source, { logger: quietLogger() });
    await ageLastAttempt(61);
    const logger = quietLogger();
    const { source: failing } = fakeSource(async () => {
      throw new Error("Shopify Admin API request failed (500, tokenSource=env): upstream error");
    });
    const r = await loadFulfillmentOrders(db, failing, { logger });
    expect(r.orders.map((o) => o.orderId)).toEqual(["TEST-1"]);
    expect(r.meta.lastRefreshedAt).toBe(ok.meta.lastRefreshedAt);
    expect(r.meta.error).toMatch(/500/);
    expect(r.meta.throttled).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    // The failure counts as the minute's attempt (no hammering Shopify).
    const { source: next, fetchOrders } = fakeSource(async () => ({ live: [order(2)], recentlyFulfilled: [] }));
    await loadFulfillmentOrders(db, next, { logger: quietLogger() });
    expect(fetchOrders).not.toHaveBeenCalled();
    // A later success clears the note.
    await ageLastAttempt(61);
    const healed = await loadFulfillmentOrders(db, next, { logger: quietLogger() });
    expect(healed.meta.error).toBeNull();
    expect(healed.orders.map((o) => o.orderId)).toEqual(["TEST-2"]);
  });

  it("flags a throttled Shopify error and logs it as a warning", async () => {
    const { source } = fakeSource(async () => ({ live: [order(1)], recentlyFulfilled: [] }));
    await loadFulfillmentOrders(db, source, { logger: quietLogger() });
    await ageLastAttempt(61);
    const logger = quietLogger();
    const { source: throttled } = fakeSource(async () => {
      throw new Error("Shopify GraphQL error: Throttled (THROTTLED)");
    });
    const r = await loadFulfillmentOrders(db, throttled, { logger });
    expect(r.meta.throttled).toBe(true);
    expect(r.orders).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("throws when Shopify fails and nothing was ever cached", async () => {
    const { source } = fakeSource(async () => {
      throw new Error("Shopify Admin API request failed (503)");
    });
    await expect(loadFulfillmentOrders(db, source, { logger: quietLogger() })).rejects.toThrow(/503/);
  });

  it("keeps seeded test orders across refreshes and lets live orders win over recently fulfilled", async () => {
    await pg.query(`insert into fulfillment_orders_cache (shopify_order_id, payload, source) values ('TEST-SEED', $1, 'test')`, [
      JSON.stringify(order(7, { orderId: "TEST-SEED", name: "[TEST] #7" })),
    ]);
    const { source } = fakeSource(async () => ({
      live: [order(1, { customerName: "Live copy" })],
      recentlyFulfilled: [order(1, { customerName: "Old copy" }), order(3)],
    }));
    const r = await loadFulfillmentOrders(db, source, { logger: quietLogger() });
    const byId = new Map(r.orders.map((o) => [o.orderId, o]));
    expect(byId.get("TEST-SEED")?.name).toBe("[TEST] #7");
    expect(byId.get("TEST-1")?.customerName).toBe("Live copy");
    expect(byId.has("TEST-3")).toBe(true);
  });
});

describe("createShopifyOrdersSource (fake GraphQL at the boundary)", () => {
  const node = (id: string, name: string, lineItems: Array<[string, number, number]>) => ({
    __typename: "Order",
    id: `gid://shopify/Order/${id}`,
    name,
    createdAt: "2026-10-01T15:00:00Z",
    customer: { firstName: "Invented", lastName: "Person" },
    totalPriceSet: { shopMoney: { amount: "12.50", currencyCode: "USD" } },
    lineItems: { edges: lineItems.map(([n, q, oz]) => ({ node: { name: n, quantity: q, weight: { value: oz, unit: "OUNCES" } } })) },
  });

  it("maps orders with line item names and weights, plus recently fulfilled orders", async () => {
    await pg.query(`insert into fulfillment_log (shopify_order_id, fulfilled_at) values ('900002', now() - interval '2 days'), ('900003', now() - interval '30 days')`);
    const calls: string[] = [];
    const graphql = async <T,>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      calls.push(query.includes("RecentlyFulfilledOrders") ? `nodes:${JSON.stringify(variables?.ids)}` : "orders");
      if (query.includes("RecentlyFulfilledOrders")) return { nodes: [node("900002", "#T2", [["Invented Rinse", 1, 8]])] } as T;
      return { orders: { edges: [{ node: node("900001", "#T1", [["Invented Gum", 2, 1.5], ["Invented Paste", 1, 4]]) }] } } as T;
    };
    const result = await createShopifyOrdersSource(db, graphql).fetchOrders();
    expect(calls).toEqual(["orders", 'nodes:["gid://shopify/Order/900002"]']);
    expect(result.live[0]).toMatchObject({
      orderId: "900001",
      name: "#T1",
      customerName: "Invented Person",
      itemCount: 3,
      totalProductWeightOz: 7,
      totalPrice: 12.5,
      lineItems: [{ name: "Invented Gum", quantity: 2 }, { name: "Invented Paste", quantity: 1 }],
    });
    expect(result.recentlyFulfilled.map((o) => o.orderId)).toEqual(["900002"]);
  });

  it("propagates a throttled GraphQL error to the loader", async () => {
    const graphql = async <T,>(): Promise<T> => {
      throw new Error("Shopify GraphQL error: Throttled");
    };
    await expect(createShopifyOrdersSource(db, graphql).fetchOrders()).rejects.toThrow(/Throttled/);
  });
});
