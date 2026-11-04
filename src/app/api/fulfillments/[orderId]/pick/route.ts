import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, loadOrders, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";
import { loadPackagingConfig } from "@/lib/warehouse";
import { resolveOrderComponents } from "@/lib/orderComponents";
import { computeBatchPlan, requiredFor, allocOrderFor, flagDetailFor } from "@/lib/batchPlan";
import { planAllocations, sameAllocation } from "@/lib/batchAllocation";

/**
 * Mark as Picked: assigns a staging box and takes the order's units out of
 * finished-goods batches, in one database transaction (mark_order_picked).
 *
 * Body: { boxId, allocations: [{product_id, batch_id, qty}], override?: { reason } }
 *  - Normal pick: `allocations` must be the batch instructions the picker saw.
 *    The plan is recomputed here; if this order's instructions changed (a new
 *    order, another pick, a count), the pick is rejected with code
 *    plan_changed and the new instructions.
 *  - "Picked from a different batch": `override.reason` is required; the plan
 *    comparison is skipped and the database still checks stock under locks.
 * Orders with an unmapped line item are refused (only the app knows line items).
 */
type Allocation = { product_id: string; batch_id: string; qty: number };

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");
    const body = (await request.json().catch(() => ({}))) as {
      boxId?: string;
      allocations?: Allocation[];
      override?: { reason?: string } | null;
    };
    if (!body.boxId) return badRequest("Choose a staging box first.");
    const sent = Array.isArray(body.allocations) ? body.allocations : [];
    const overrideReason = body.override ? (body.override.reason ?? "").trim() : null;
    if (body.override && !overrideReason) return badRequest("Choose a reason for picking from a different batch.");

    const db = requireAdmin();
    const { orders } = await loadOrders();
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) {
      return NextResponse.json({ error: "This order isn't in the current order list. Refresh and try again." }, { status: 404 });
    }
    const config = await loadPackagingConfig(db);
    const resolved = resolveOrderComponents(order.lineItems ?? [], config.resolver);
    if (resolved.unmappedLineItems.length > 0) {
      return NextResponse.json(
        { error: "Map the line item before picking.", code: "unmapped_line_item", unmapped: resolved.unmappedLineItems },
        { status: 409 },
      );
    }

    const allocOrder = allocOrderFor(order, config.resolver);
    let allocations: Allocation[] = sent;
    if (order.status === "preparing_shipment") {
      const plan = await computeBatchPlan(db, orders, config.resolver);
      const mine = plan.allocation.byOrderId.get(orderId);
      if (mine?.state === "short") {
        return NextResponse.json(
          { error: "Item(s) out of stock.", code: "out_of_stock", detail: flagDetailFor(mine) },
          { status: 409 },
        );
      }
      const planned = mine ? planAllocations(mine) : [];
      if (!overrideReason && !sameAllocation(planned, sent)) {
        return NextResponse.json(
          { error: "Batch instructions changed. Reloaded.", code: "plan_changed", plan: mine ?? null },
          { status: 409 },
        );
      }
      if (!overrideReason) allocations = planned;
    }

    const { data, error } = await db.rpc("mark_order_picked", {
      p_order_id: orderId,
      p_box_id: body.boxId,
      p_order_name: order.name,
      p_allocations: allocations,
      p_required: requiredFor(allocOrder),
      ...(overrideReason ? { p_override_reason: overrideReason } : {}),
    });
    if (error) return rpcErrorResponse(error);
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
