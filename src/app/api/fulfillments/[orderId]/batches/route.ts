import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, loadOrders, requireAdmin } from "@/lib/fulfillmentApi";
import { loadPackagingConfig } from "@/lib/warehouse";
import { computeBatchPlan } from "@/lib/batchPlan";

/**
 * Batches for one order (order detail page): the planned batch per
 * component while the order waits to be picked, and the batches actually
 * picked afterwards (including "Picked from a different batch").
 */
export async function GET(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");
    const db = requireAdmin();
    const { data: pickRows, error } = await db
      .from("order_batch_picks")
      .select("id, product_id, batch_id, qty, is_override, override_reason, picked_at, reversed_at, reversed_reason, finished_goods_batches(batch_code), products(name)")
      .eq("order_id", orderId)
      .order("picked_at", { ascending: true });
    if (error) throw new Error(error.message);
    const picks = ((pickRows ?? []) as any[]).map((p) => ({
      id: p.id,
      productId: p.product_id,
      productName: p.products?.name ?? "Unknown product",
      batchId: p.batch_id,
      batchCode: p.finished_goods_batches?.batch_code ?? "",
      qty: p.qty,
      isOverride: !!p.is_override,
      overrideReason: p.override_reason,
      pickedAt: p.picked_at ? new Date(p.picked_at).toISOString() : null,
      reversedAt: p.reversed_at ? new Date(p.reversed_at).toISOString() : null,
    }));

    let plan = null;
    const { orders } = await loadOrders();
    const order = orders.find((o) => o.orderId === orderId);
    if (order && order.status === "preparing_shipment") {
      const config = await loadPackagingConfig(db);
      const result = await computeBatchPlan(db, orders, config.resolver);
      plan = result.allocation.byOrderId.get(orderId) ?? null;
    }
    return NextResponse.json({ ok: true, picks, plan });
  } catch (error) {
    return errorResponse(error);
  }
}
