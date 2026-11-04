/**
 * Batch allocation engine (pure; no I/O). Decides which finished-goods batch
 * box each unpicked order pulls from, so pickers empty boxes oldest first.
 * Used by the Pick List, Finished Products Inventory (planned / awaiting /
 * available), the order detail page, the out-of-stock flag sync and the
 * Optimization page.
 *
 * Rules:
 *  1. Orders are walked oldest first (created date, then order number), with
 *     a working copy of every batch's remaining quantity.
 *  2. Each batch-tracked component is taken from that product's batches in
 *     order (oldest production first; a batch is used up before the next).
 *     A component may span several batches.
 *  3. All or nothing: if any tracked component of an order can't be fully
 *     covered, the order is 'short' (with shortBy per product) and reserves
 *     nothing; later orders can still be covered.
 *  4. Components whose product isn't batch tracked are ignored. An order
 *     with only ignored components is 'not_tracked'.
 *  5. Batches with 0 remaining (or not active) are skipped. The plan never
 *     depends on how a screen displays the list.
 *  6. Picked orders are not in the input (their units already left the
 *     batches), so picking an order exactly as planned leaves every other
 *     order's plan unchanged.
 * Quantities are whole numbers; a fractional quantity is an error.
 */

export type AllocComponent = { productId: string; productName?: string; qty: number };
export type AllocOrder = { orderId: string; orderName: string; createdAt: string; components: AllocComponent[] };
export type AllocBatch = {
  id: string;
  batchCode: string;
  productId: string;
  submittedAt: string;
  remainingQty: number;
  status?: "active" | "depleted";
};

export type AllocPart = { batchId: string; batchCode: string; qty: number };
export type AllocLine = { productId: string; productName: string; qty: number; parts: AllocPart[]; shortBy: number; availableToOrder: number };
export type OrderPlan = {
  orderId: string;
  orderName: string;
  state: "covered" | "short" | "not_tracked";
  lines: AllocLine[];
  /** Batches this order brings to 0 in the plan. */
  emptiesBatchIds: string[];
};
export type ProductAvailability = { inBoxes: number; awaitingPick: number; available: number };

export type AllocationResult = {
  orders: OrderPlan[];
  byOrderId: Map<string, OrderPlan>;
  plannedQtyByBatchId: Map<string, number>;
  byProductId: Map<string, ProductAvailability>;
  /** Active batches with stock, in pick order, per product. */
  batchOrderByProductId: Map<string, AllocBatch[]>;
};

function assertWhole(n: number, what: string): number {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${what} must be a whole number, 0 or more (got ${n}).`);
  }
  return n;
}

const orderNumber = (name: string) => {
  const digits = name.replace(/[^0-9]/g, "");
  return digits ? Number(digits) : Number.POSITIVE_INFINITY;
};

export function compareOrders(a: Pick<AllocOrder, "createdAt" | "orderName" | "orderId">, b: Pick<AllocOrder, "createdAt" | "orderName" | "orderId">): number {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta - tb;
  const na = orderNumber(a.orderName);
  const nb = orderNumber(b.orderName);
  if (na !== nb) return na - nb;
  return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
}

const codeNumber = (code: string) => (/^\d+$/.test(code) ? Number(code) : Number.POSITIVE_INFINITY);

/** Oldest production first: submitted_at, then batch code (numeric), then id. */
export function compareBatches(a: AllocBatch, b: AllocBatch): number {
  const ta = new Date(a.submittedAt).getTime();
  const tb = new Date(b.submittedAt).getTime();
  if (ta !== tb) return ta - tb;
  const ca = codeNumber(a.batchCode);
  const cb = codeNumber(b.batchCode);
  if (ca !== cb) return ca - cb;
  if (a.batchCode !== b.batchCode) return a.batchCode < b.batchCode ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function allocateBatches(input: {
  orders: AllocOrder[];
  trackedProductIds: Set<string>;
  batches: AllocBatch[];
  productNames?: Map<string, string>;
}): AllocationResult {
  const names = input.productNames ?? new Map<string, string>();
  const batchOrderByProductId = new Map<string, AllocBatch[]>();
  const working = new Map<string, number>();
  const inBoxes = new Map<string, number>();
  for (const b of input.batches) {
    if (b.status && b.status !== "active") continue;
    const remaining = assertWhole(b.remainingQty, `Batch ${b.batchCode} remaining quantity`);
    inBoxes.set(b.productId, (inBoxes.get(b.productId) ?? 0) + remaining);
    if (remaining === 0) continue;
    working.set(b.id, remaining);
    const list = batchOrderByProductId.get(b.productId) ?? [];
    list.push(b);
    batchOrderByProductId.set(b.productId, list);
  }
  for (const list of batchOrderByProductId.values()) list.sort(compareBatches);

  const plannedQtyByBatchId = new Map<string, number>();
  const awaiting = new Map<string, number>();
  const plans: OrderPlan[] = [];

  for (const order of [...input.orders].sort(compareOrders)) {
    // Combine repeated products; ignore untracked ones.
    const needed = new Map<string, number>();
    for (const c of order.components) {
      if (!input.trackedProductIds.has(c.productId)) continue;
      const q = assertWhole(c.qty, `Quantity of ${c.productName ?? c.productId} on order ${order.orderName}`);
      if (q === 0) continue;
      needed.set(c.productId, (needed.get(c.productId) ?? 0) + q);
      if (c.productName && !names.has(c.productId)) names.set(c.productId, c.productName);
    }
    if (needed.size === 0) {
      plans.push({ orderId: order.orderId, orderName: order.orderName, state: "not_tracked", lines: [], emptiesBatchIds: [] });
      continue;
    }
    for (const [pid, q] of needed) awaiting.set(pid, (awaiting.get(pid) ?? 0) + q);

    // Tentative allocation on a scratch copy; committed only if every line is covered.
    const scratch = new Map<string, number>();
    const lines: AllocLine[] = [];
    let short = false;
    for (const [productId, qty] of [...needed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const batches = batchOrderByProductId.get(productId) ?? [];
      const availableToOrder = batches.reduce((s, b) => s + (working.get(b.id) ?? 0), 0);
      let left = qty;
      const parts: AllocPart[] = [];
      for (const b of batches) {
        if (left === 0) break;
        const have = working.get(b.id) ?? 0;
        if (have === 0) continue;
        const take = Math.min(have, left);
        parts.push({ batchId: b.id, batchCode: b.batchCode, qty: take });
        scratch.set(b.id, have - take);
        left -= take;
      }
      if (left > 0) short = true;
      lines.push({
        productId,
        productName: names.get(productId) ?? "Unknown product",
        qty,
        parts: left > 0 ? [] : parts,
        shortBy: left,
        availableToOrder,
      });
    }

    if (short) {
      // Nothing is reserved for a short order, so no line gets batch parts.
      plans.push({
        orderId: order.orderId,
        orderName: order.orderName,
        state: "short",
        lines: lines.map((l) => ({ ...l, parts: [] })),
        emptiesBatchIds: [],
      });
      continue;
    }
    const empties: string[] = [];
    for (const [batchId, after] of scratch) {
      const before = working.get(batchId) ?? 0;
      working.set(batchId, after);
      plannedQtyByBatchId.set(batchId, (plannedQtyByBatchId.get(batchId) ?? 0) + (before - after));
      if (after === 0) empties.push(batchId);
    }
    plans.push({ orderId: order.orderId, orderName: order.orderName, state: "covered", lines, emptiesBatchIds: empties.sort() });
  }

  const byProductId = new Map<string, ProductAvailability>();
  for (const pid of new Set([...input.trackedProductIds, ...inBoxes.keys(), ...awaiting.keys()])) {
    if (!input.trackedProductIds.has(pid)) continue;
    const boxes = inBoxes.get(pid) ?? 0;
    const wait = awaiting.get(pid) ?? 0;
    byProductId.set(pid, { inBoxes: boxes, awaitingPick: wait, available: boxes - wait });
  }

  return {
    orders: plans,
    byOrderId: new Map(plans.map((p) => [p.orderId, p])),
    plannedQtyByBatchId,
    byProductId,
    batchOrderByProductId,
  };
}

/** The allocation a pick sends to the database: [{product_id, batch_id, qty}]. */
export function planAllocations(plan: OrderPlan): Array<{ product_id: string; batch_id: string; qty: number }> {
  return plan.lines.flatMap((l) => l.parts.map((p) => ({ product_id: l.productId, batch_id: p.batchId, qty: p.qty })));
}

/** True when two allocations are the same set of (product, batch, qty). */
export function sameAllocation(
  a: Array<{ product_id: string; batch_id: string; qty: number }>,
  b: Array<{ product_id: string; batch_id: string; qty: number }>,
): boolean {
  const key = (x: { product_id: string; batch_id: string; qty: number }) => `${x.product_id}|${x.batch_id}|${x.qty}`;
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** "2x Spearmint Gum: pull from Batch 000039" / "Batch 000039 x2, Batch 000040 x1". */
export function batchInstruction(line: AllocLine): string {
  if (line.parts.length === 0) return `${line.qty}x ${line.productName}: short by ${line.shortBy}`;
  if (line.parts.length === 1) return `${line.qty}x ${line.productName}: pull from Batch ${line.parts[0].batchCode}`;
  return `${line.qty}x ${line.productName}: ${line.parts.map((p) => `Batch ${p.batchCode} x${p.qty}`).join(", ")}`;
}
