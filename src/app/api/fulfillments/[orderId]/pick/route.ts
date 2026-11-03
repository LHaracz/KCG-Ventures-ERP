import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, cachedOrder, errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";
import { loadPackagingConfig } from "@/lib/warehouse";
import { resolveOrderComponents } from "@/lib/orderComponents";

/**
 * Mark as Picked: assigns a staging box via mark_order_picked (one
 * transaction; the database enforces one order per box and one box per
 * order). Orders with an unmapped line item are refused here, server side,
 * because only the app knows the order's line items.
 */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");
    const body = (await request.json().catch(() => ({}))) as { boxId?: string };
    if (!body.boxId) return badRequest("Choose a staging box first.");

    const db = requireAdmin();
    const order = await cachedOrder(orderId);
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

    const { data, error } = await db.rpc("mark_order_picked", {
      p_order_id: orderId,
      p_box_id: body.boxId,
      p_order_name: order.name,
    });
    if (error) return rpcErrorResponse(error);
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
