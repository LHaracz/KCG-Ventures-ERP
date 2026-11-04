import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { errorResponse, loadOrders, requireAdmin } from "@/lib/fulfillmentApi";
import { loadPackagingConfig } from "@/lib/warehouse";
import { computeBatchPlan, syncOutOfStockFlags } from "@/lib/batchPlan";

/**
 * Finished goods overview for Finished Products Inventory and the
 * Optimization page: per product In boxes / Awaiting pick / Available, and
 * every batch with its planned quantity and "next to pick" marker. Runs the
 * same allocation as the Pick List (and syncs out-of-stock flags), so a count
 * or a new batch is reflected immediately. No Shopify calls beyond the shared
 * once-a-minute cache refresh.
 */
export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();
    const [{ orders, meta }, config] = await Promise.all([loadOrders(), loadPackagingConfig(db)]);
    const plan = await computeBatchPlan(db, orders, config.resolver);
    await syncOutOfStockFlags(db, plan, orders);

    const nextIds = new Set(Array.from(plan.allocation.batchOrderByProductId.values()).map((list) => list[0]?.id).filter(Boolean));
    const activeCount = new Map<string, number>();
    for (const b of plan.batches) if (b.status === "active") activeCount.set(b.productId, (activeCount.get(b.productId) ?? 0) + 1);

    const products = plan.products.map((p) => {
      const a = plan.allocation.byProductId.get(p.productId);
      return {
        ...p,
        inBoxes: p.onHandQty,
        awaitingPick: p.batchTracked ? a?.awaitingPick ?? 0 : null,
        available: p.batchTracked ? p.onHandQty - (a?.awaitingPick ?? 0) : null,
        activeBatches: p.batchTracked ? activeCount.get(p.productId) ?? 0 : null,
      };
    });
    const batches = plan.batches.map((b) => ({
      ...b,
      plannedQty: plan.allocation.plannedQtyByBatchId.get(b.id) ?? 0,
      nextToPick: nextIds.has(b.id),
    }));
    return NextResponse.json({ ok: true, products, batches, meta });
  } catch (error) {
    return errorResponse(error);
  }
}
