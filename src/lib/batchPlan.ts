/**
 * Server-side batch plan: loads batch-tracked products and active batches,
 * runs the allocation engine over the unpicked orders (from the shared
 * order loader, i.e. fulfillment_orders_cache) and syncs the automatic
 * "Item(s) out of stock" flags. No Shopify calls of its own.
 */
import { allocateBatches, type AllocationResult, type AllocBatch, type AllocOrder, type OrderPlan } from "@/lib/batchAllocation";
import type { FlagDetailLine, FulfillmentListRow } from "@/lib/fulfillmentOrdersLoader";
import { resolveOrderComponents, type ComponentResolver } from "@/lib/orderComponents";

type Db = {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string; hint?: string | null } | null }>;
};

export type BatchRow = {
  id: string;
  batchCode: string;
  productId: string;
  productName: string;
  productionCycleId: string | null;
  submittedAt: string;
  initialQty: number;
  remainingQty: number;
  status: "active" | "depleted";
  needsCount: boolean;
  source: "production" | "opening_seed" | "manual";
  depletedAt: string | null;
  note: string | null;
};

export type TrackedProduct = { productId: string; name: string; onHandQty: number; batchTracked: boolean; updatedAt: string | null };

export type BatchPlan = {
  allocation: AllocationResult;
  batches: BatchRow[];
  products: TrackedProduct[];
  trackedProductIds: Set<string>;
};

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export async function loadBatchState(db: Db, opts: { includeDepleted?: boolean } = {}) {
  let batchQuery = db
    .from("finished_goods_batches")
    .select("id, batch_code, product_id, production_cycle_id, submitted_at, initial_qty, remaining_qty, status, needs_count, source, depleted_at, note");
  if (!opts.includeDepleted) batchQuery = batchQuery.eq("status", "active");
  const [batchesRes, fpiRes, productsRes] = await Promise.all([
    batchQuery,
    db.from("finished_products_inventory").select("product_id, on_hand_qty, batch_tracked, updated_at"),
    db.from("products").select("id, name, is_microgreen, deleted_at"),
  ]);
  for (const [r, what] of [[batchesRes, "batches"], [fpiRes, "finished goods"], [productsRes, "products"]] as const) {
    if (r.error) throw new Error(`Could not load ${what}: ${r.error.message}`);
  }
  const productRows = (productsRes.data ?? []) as Array<{ id: string; name: string; is_microgreen: boolean; deleted_at: string | null }>;
  const nameById = new Map(productRows.map((p) => [p.id, p.name]));
  const activeBotaniqals = new Set(productRows.filter((p) => !p.is_microgreen && !p.deleted_at).map((p) => p.id));
  const fpi = (fpiRes.data ?? []) as Array<{ product_id: string; on_hand_qty: number; batch_tracked: boolean; updated_at: string | null }>;
  const products: TrackedProduct[] = fpi
    .filter((r) => activeBotaniqals.has(r.product_id))
    .map((r) => ({
      productId: r.product_id,
      name: nameById.get(r.product_id) ?? "Unknown product",
      onHandQty: Number(r.on_hand_qty) || 0,
      batchTracked: !!r.batch_tracked,
      updatedAt: iso(r.updated_at),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const trackedProductIds = new Set(fpi.filter((r) => r.batch_tracked).map((r) => r.product_id));
  const batches: BatchRow[] = ((batchesRes.data ?? []) as any[]).map((b) => ({
    id: b.id,
    batchCode: b.batch_code,
    productId: b.product_id,
    productName: nameById.get(b.product_id) ?? "Unknown product",
    productionCycleId: b.production_cycle_id ?? null,
    submittedAt: iso(b.submitted_at)!,
    initialQty: Number(b.initial_qty),
    remainingQty: Number(b.remaining_qty),
    status: b.status,
    needsCount: !!b.needs_count,
    source: b.source,
    depletedAt: iso(b.depleted_at),
    note: b.note ?? null,
  }));
  return { batches, products, trackedProductIds, nameById };
}

/** Allocation input for one order: every resolved component (untracked ones are ignored by the engine). */
export function allocOrderFor(order: Pick<FulfillmentListRow, "orderId" | "name" | "createdAt" | "lineItems">, resolver: ComponentResolver): AllocOrder {
  const resolved = resolveOrderComponents(order.lineItems ?? [], resolver);
  return {
    orderId: order.orderId,
    orderName: order.name,
    createdAt: order.createdAt,
    components: resolved.components.map((c) => ({ productId: c.productId, productName: c.productName, qty: c.qty })),
  };
}

/** Required quantity per product for an order (all components), for mark_order_picked. */
export function requiredFor(order: AllocOrder): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of order.components) out[c.productId] = (out[c.productId] ?? 0) + c.qty;
  return out;
}

export async function computeBatchPlan(db: Db, orders: FulfillmentListRow[], resolver: ComponentResolver): Promise<BatchPlan> {
  const state = await loadBatchState(db, { includeDepleted: true });
  const unpicked = orders.filter((o) => o.status === "preparing_shipment").map((o) => allocOrderFor(o, resolver));
  const active: AllocBatch[] = state.batches
    .filter((b) => b.status === "active" && state.trackedProductIds.has(b.productId))
    .map((b) => ({ id: b.id, batchCode: b.batchCode, productId: b.productId, submittedAt: b.submittedAt, remainingQty: b.remainingQty, status: "active" }));
  const allocation = allocateBatches({ orders: unpicked, trackedProductIds: state.trackedProductIds, batches: active, productNames: state.nameById });
  return { allocation, batches: state.batches, products: state.products, trackedProductIds: state.trackedProductIds };
}

export function flagDetailFor(plan: OrderPlan): FlagDetailLine[] {
  return plan.lines
    .filter((l) => l.shortBy > 0)
    .map((l) => ({ product_id: l.productId, product: l.productName, needed: l.qty, available: l.availableToOrder, short_by: l.shortBy }));
}

/**
 * Flags short orders "Item(s) out of stock" and clears automatic flags on
 * covered orders (manual flags are never touched; only orders waiting to be
 * picked). Patches the given rows in memory so the response is current.
 */
export async function syncOutOfStockFlags(db: Db, plan: BatchPlan, orders: FulfillmentListRow[]) {
  const short = plan.allocation.orders.filter((p) => p.state === "short").map((p) => ({ order_id: p.orderId, detail: flagDetailFor(p) }));
  const covered = plan.allocation.orders.filter((p) => p.state !== "short").map((p) => p.orderId);
  const { data, error } = await db.rpc("sync_out_of_stock_flags", { p_short: short, p_covered: covered });
  if (error) {
    console.error(`[batch-plan] sync_out_of_stock_flags failed: ${error.message}`);
    return null;
  }
  const byId = new Map(orders.map((o) => [o.orderId, o]));
  for (const s of short) {
    const o = byId.get(s.order_id);
    if (!o || o.status !== "preparing_shipment") continue;
    if (!o.isFlagged) {
      Object.assign(o, { isFlagged: true, flaggedReason: "Item(s) out of stock", flagSource: "auto_out_of_stock", flagDetail: s.detail, flaggedAt: new Date().toISOString() });
    } else if (o.flagSource === "auto_out_of_stock") {
      o.flagDetail = s.detail;
    }
  }
  for (const id of covered) {
    const o = byId.get(id);
    if (o && o.isFlagged && o.flagSource === "auto_out_of_stock") {
      Object.assign(o, { isFlagged: false, flaggedReason: null, flagSource: null, flagDetail: null, flaggedAt: null });
    }
  }
  return data as { flagged: number; updated: number; cleared: number };
}
