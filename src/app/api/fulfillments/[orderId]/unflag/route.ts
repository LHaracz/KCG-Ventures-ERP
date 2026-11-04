import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, loadOrders, requireAdmin } from "@/lib/fulfillmentApi";
import { loadPackagingConfig } from "@/lib/warehouse";
import { computeBatchPlan, syncOutOfStockFlags } from "@/lib/batchPlan";

/**
 * Unflag an automatic "Item(s) out of stock" flag. Recomputes the batch plan:
 * still short -> 409 "Still out of stock. Count a batch or add stock first.";
 * otherwise the flag sync clears it. (Manual flags are unflagged directly
 * from the order page, as before.)
 */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");
    const db = requireAdmin();
    const { orders } = await loadOrders();
    const config = await loadPackagingConfig(db);
    const plan = await computeBatchPlan(db, orders, config.resolver);
    const mine = plan.allocation.byOrderId.get(orderId);
    if (mine?.state === "short") {
      return NextResponse.json({ error: "Still out of stock. Count a batch or add stock first.", code: "still_short" }, { status: 409 });
    }
    await syncOutOfStockFlags(db, plan, orders);
    if (!mine) {
      // Not waiting to be picked any more: clear the automatic flag directly.
      const { error } = await db.rpc("sync_out_of_stock_flags", { p_short: [], p_covered: [orderId] });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
