/**
 * The Fulfillments list's order-loading function, shared by the Fulfillments
 * list, Pick List and Shipping Assignments (one fetch path).
 *
 * Orders are read from fulfillment_orders_cache (an ERP-side copy). The cache
 * is refreshed from Shopify at most once per minute, by one refresher at a
 * time (fulfillment_cache_try_claim). If Shopify fails or throttles, the last
 * good copy is served with a "Last updated" note. Order statuses always come
 * live from order_status, never from the cache.
 *
 * The Shopify queries are the same ones the list route used before this
 * build (moved here unchanged, plus each line item's `name`, which the pick
 * screens need to resolve components). No new Shopify queries are added.
 */
import { orderGidToNumericId, shopifyAdminGraphQL, toOrderGid, weightToOz } from "@/lib/shopifyAdmin";
import type { FulfillmentStatus } from "@/lib/fulfillmentStatus";

// --- Types -----------------------------------------------------------------

export type CachedOrderLineItem = { name: string; quantity: number };

/** What the cache stores per order (Shopify-derived fields only). */
export type CachedOrder = {
  orderId: string;
  name: string;
  createdAt: string;
  customerName: string;
  itemCount: number;
  totalProductWeightOz: number;
  totalPrice: number;
  currencyCode: string;
  lineItems: CachedOrderLineItem[];
};

export type FlagDetailLine = { product_id: string; product: string; needed: number; available: number; short_by: number };

export type FulfillmentListRow = CachedOrder & {
  status: FulfillmentStatus;
  isFlagged: boolean;
  flaggedReason: string | null;
  /** 'manual' | 'auto_out_of_stock' (null when not flagged). */
  flagSource: string | null;
  flagDetail: FlagDetailLine[] | null;
  flaggedAt: string | null;
};

export type OrdersSourceResult = { live: CachedOrder[]; recentlyFulfilled: CachedOrder[] };

/** The boundary to Shopify. Production uses createShopifyOrdersSource(); tests use a fake. */
export type OrdersSource = { fetchOrders(): Promise<OrdersSourceResult> };

export type LoaderMeta = {
  lastRefreshedAt: string | null;
  refreshedNow: boolean;
  /** Set when the most recent Shopify refresh failed; data may be stale. */
  error: string | null;
  throttled: boolean;
};

export type LoadResult = { orders: FulfillmentListRow[]; meta: LoaderMeta };

// Minimal slice of the supabase-js client used here (works with the PGlite test double).
type Db = {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>;
};

export const REFRESH_MIN_INTERVAL_SECONDS = 60;
export const REFRESH_LOCK_SECONDS = 45;

// --- Shopify source (queries moved from src/app/api/fulfillments/route.ts) -

type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  customer: { firstName: string | null; lastName: string | null } | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  lineItems: {
    edges: Array<{
      node: {
        name: string;
        quantity: number;
        weight: { value: number; unit: string } | null;
      };
    }>;
  };
};

type OrdersQueryResponse = { orders: { edges: Array<{ node: OrderNode }> } };
type NodesQueryResponse = { nodes: Array<(OrderNode & { __typename?: string }) | null> };

const ORDER_FIELDS = `
  id
  name
  createdAt
  customer {
    firstName
    lastName
  }
  totalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }
  lineItems(first: 50) {
    edges {
      node {
        name
        quantity
        weight {
          value
          unit
        }
      }
    }
  }
`;

const ORDERS_QUERY = `
  query UnfulfilledOrders($first: Int!) {
    orders(first: $first, query: "status:open fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: false) {
      edges {
        node {
          ${ORDER_FIELDS}
        }
      }
    }
  }
`;

const NODES_QUERY = `
  query RecentlyFulfilledOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Order {
        ${ORDER_FIELDS}
      }
    }
  }
`;

export function mapOrderNode(node: OrderNode): CachedOrder {
  const lineItems = node.lineItems.edges.map((e) => e.node);
  const itemCount = lineItems.reduce((sum, li) => sum + (li.quantity || 0), 0);
  const totalProductWeightOz = lineItems.reduce(
    (sum, li) => sum + weightToOz(li.weight) * (li.quantity || 0),
    0,
  );
  const customerName = node.customer
    ? [node.customer.firstName, node.customer.lastName].filter(Boolean).join(" ")
    : "Guest";
  return {
    orderId: orderGidToNumericId(node.id),
    name: node.name,
    createdAt: node.createdAt,
    customerName: customerName || "Guest",
    itemCount,
    totalProductWeightOz,
    totalPrice: Number(node.totalPriceSet?.shopMoney.amount ?? 0),
    currencyCode: node.totalPriceSet?.shopMoney.currencyCode ?? "USD",
    lineItems: lineItems.map((li) => ({ name: li.name, quantity: li.quantity || 0 })),
  };
}

export function createShopifyOrdersSource(
  db: Db,
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T> = shopifyAdminGraphQL,
): OrdersSource {
  return {
    async fetchOrders() {
      const recentlyFulfilledIds = async (): Promise<string[]> => {
        // Orders fulfilled in the last 14 days, so they stay visible for a bit
        // after Shopify stops returning them as unfulfilled.
        const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await db
          .from("fulfillment_log")
          .select("shopify_order_id, fulfilled_at")
          .not("fulfilled_at", "is", null)
          .gte("fulfilled_at", fourteenDaysAgo)
          .order("fulfilled_at", { ascending: false });
        if (error || !data) return [];
        return Array.from(new Set((data as any[]).map((row) => String(row.shopify_order_id))));
      };

      // Orders the ERP is still working on (picked, label made or printed, or
      // holding a staging box). They must stay visible until the ERP marks
      // them fulfilled, even when Shopify no longer lists them as unfulfilled
      // (fulfilled or closed in Shopify directly, or beyond the first 50).
      const inProgressIds = async (): Promise<string[]> => {
        const [st, open] = await Promise.all([
          db.from("order_status").select("shopify_order_id").in("status", ["picked", "label_generated", "label_printed"]),
          db.from("staging_box_assignments").select("order_id").is("released_at", null),
        ]);
        const all = [
          ...((st.data ?? []) as Array<{ shopify_order_id: string }>).map((r) => String(r.shopify_order_id)),
          ...((open.data ?? []) as Array<{ order_id: string }>).map((r) => String(r.order_id)),
        ];
        // Invented test orders live in the cache already and are not Shopify ids.
        return all.filter((id) => !id.startsWith("TEST-"));
      };

      const [liveData, fulfilledIds, workingIds] = await Promise.all([
        graphql<OrdersQueryResponse>(ORDERS_QUERY, { first: 50 }),
        recentlyFulfilledIds(),
        inProgressIds(),
      ]);
      const liveIds = new Set(liveData.orders.edges.map(({ node }) => orderGidToNumericId(node.id)));
      const ids = Array.from(new Set([...fulfilledIds, ...workingIds])).filter((id) => !liveIds.has(id)).slice(0, 250);
      let recentlyFulfilled: CachedOrder[] = [];
      if (ids.length > 0) {
        const nodesData = await graphql<NodesQueryResponse>(NODES_QUERY, { ids: ids.map((id) => toOrderGid(id)) });
        recentlyFulfilled = nodesData.nodes
          .filter((n): n is OrderNode & { __typename?: string } => !!n && n.__typename === "Order")
          .map(mapOrderNode);
      }
      return { live: liveData.orders.edges.map(({ node }) => mapOrderNode(node)), recentlyFulfilled };
    },
  };
}

// --- Cache logic -----------------------------------------------------------

export function isThrottledError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /THROTTLED|\b429\b|throttl|rate limit/i.test(message);
}

type Logger = Pick<Console, "warn" | "error">;

/**
 * Refreshes the cache from Shopify if this caller wins the once-a-minute
 * claim. Never throws for Shopify failures: they are recorded on the cache
 * state (and logged) so the last good copy keeps being served.
 */
export async function refreshCacheIfDue(
  db: Db,
  source: OrdersSource,
  opts: { minIntervalSeconds?: number; lockSeconds?: number; logger?: Logger } = {},
): Promise<{ attempted: boolean; ok: boolean; error: string | null; throttled: boolean }> {
  const logger = opts.logger ?? console;
  const claim = await db.rpc("fulfillment_cache_try_claim", {
    p_min_interval_seconds: opts.minIntervalSeconds ?? REFRESH_MIN_INTERVAL_SECONDS,
    p_lock_seconds: opts.lockSeconds ?? REFRESH_LOCK_SECONDS,
  });
  if (claim.error) throw new Error(`Could not check the orders cache: ${claim.error.message}`);
  if (claim.data !== true) return { attempted: false, ok: false, error: null, throttled: false };

  let fetched: OrdersSourceResult;
  try {
    fetched = await source.fetchOrders();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const throttled = isThrottledError(err);
    if (throttled) logger.warn(`[fulfillment-orders-cache] Shopify throttled the refresh: ${message}`);
    else logger.error(`[fulfillment-orders-cache] Shopify refresh failed: ${message}`);
    await db.rpc("fulfillment_cache_record_error", { p_message: message, p_throttled: throttled });
    return { attempted: true, ok: false, error: message, throttled };
  }

  // Live orders take precedence over recently fulfilled on overlap.
  const merged = new Map<string, { order: CachedOrder; source: "live" | "recently_fulfilled" }>();
  for (const o of fetched.recentlyFulfilled) merged.set(o.orderId, { order: o, source: "recently_fulfilled" });
  for (const o of fetched.live) merged.set(o.orderId, { order: o, source: "live" });
  const rows = Array.from(merged.values()).map(({ order, source }) => ({
    shopify_order_id: order.orderId,
    payload: order,
    source,
  }));
  const replaced = await db.rpc("fulfillment_cache_replace", { p_rows: rows });
  if (replaced.error) {
    await db.rpc("fulfillment_cache_record_error", { p_message: replaced.error.message, p_throttled: false });
    logger.error(`[fulfillment-orders-cache] Saving the refresh failed: ${replaced.error.message}`);
    return { attempted: true, ok: false, error: replaced.error.message, throttled: false };
  }
  return { attempted: true, ok: true, error: null, throttled: false };
}

type CacheState = {
  last_refreshed_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_error_throttled: boolean;
};

async function readCacheState(db: Db): Promise<CacheState | null> {
  const { data } = await db
    .from("fulfillment_orders_cache_state")
    .select("last_refreshed_at, last_error, last_error_at, last_error_throttled")
    .eq("id", 1)
    .maybeSingle();
  return (data as CacheState | null) ?? null;
}

export async function loadFulfillmentOrders(
  db: Db,
  source: OrdersSource,
  opts: {
    minIntervalSeconds?: number;
    lockSeconds?: number;
    logger?: Logger;
    /** First-ever load while another request is filling the cache: how long to wait. */
    waitForFirstFillMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<LoadResult> {
  const refresh = await refreshCacheIfDue(db, source, opts);
  let state = await readCacheState(db);

  // Nothing cached yet and someone else is filling it: wait briefly.
  if (!state?.last_refreshed_at && !refresh.attempted) {
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (opts.waitForFirstFillMs ?? 8000);
    while (Date.now() < deadline && !state?.last_refreshed_at) {
      await sleep(500);
      state = await readCacheState(db);
    }
  }

  const { data: cacheRows, error: cacheError } = await db
    .from("fulfillment_orders_cache")
    .select("shopify_order_id, payload, source");
  if (cacheError) throw new Error(`Could not read the orders cache: ${cacheError.message}`);
  const rows = (cacheRows ?? []) as Array<{ shopify_order_id: string; payload: CachedOrder; source: string }>;

  if (!state?.last_refreshed_at && rows.length === 0 && (refresh.error || state?.last_error)) {
    // Never loaded successfully: surface the Shopify error like the list did before.
    throw new Error(refresh.error ?? state?.last_error ?? "Failed to load unfulfilled orders.");
  }

  const orderIds = rows.map((r) => r.shopify_order_id);
  const statusMap = new Map<
    string,
    { status: FulfillmentStatus; isFlagged: boolean; flaggedReason: string | null; flagSource: string | null; flagDetail: FlagDetailLine[] | null; flaggedAt: string | null }
  >();
  if (orderIds.length > 0) {
    const { data, error } = await db
      .from("order_status")
      .select("shopify_order_id, status, is_flagged, flagged_reason, flag_source, flag_detail, flagged_at")
      .in("shopify_order_id", orderIds);
    if (!error && data) {
      for (const row of data as any[]) {
        statusMap.set(String(row.shopify_order_id), {
          status: row.status as FulfillmentStatus,
          isFlagged: !!row.is_flagged,
          flaggedReason: (row.flagged_reason as string | null) ?? null,
          flagSource: (row.flag_source as string | null) ?? null,
          flagDetail: (row.flag_detail as FlagDetailLine[] | null) ?? null,
          flaggedAt: row.flagged_at ? new Date(row.flagged_at).toISOString() : null,
        });
      }
    }
  }

  const orders: FulfillmentListRow[] = rows.map((r) => {
    const payload = r.payload;
    const s = statusMap.get(r.shopify_order_id);
    return {
      ...payload,
      orderId: r.shopify_order_id,
      lineItems: payload.lineItems ?? [],
      status: s?.status ?? "preparing_shipment",
      isFlagged: s?.isFlagged ?? false,
      flaggedReason: s?.flaggedReason ?? null,
      flagSource: s?.flagSource ?? null,
      flagDetail: s?.flagDetail ?? null,
      flaggedAt: s?.flaggedAt ?? null,
    };
  });

  const ms = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
  const refreshedMs = ms(state?.last_refreshed_at);
  const errorMs = ms(state?.last_error_at);
  const errorIsCurrent =
    !!state?.last_error && (refreshedMs === null || errorMs === null || errorMs >= refreshedMs);

  return {
    orders,
    meta: {
      lastRefreshedAt: refreshedMs === null ? null : new Date(refreshedMs).toISOString(),
      refreshedNow: refresh.ok,
      error: errorIsCurrent ? state!.last_error : null,
      throttled: errorIsCurrent ? !!state!.last_error_throttled : false,
    },
  };
}
