import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { errorResponse, loadOrders, requireAdmin } from "@/lib/fulfillmentApi";
import type { FulfillmentListRow as LoaderRow } from "@/lib/fulfillmentOrdersLoader";

/**
 * Fulfillments list. Orders come from the shared order loader
 * (src/lib/fulfillmentOrdersLoader.ts), which reads the ERP-side cache and
 * refreshes it from Shopify at most once a minute. Statuses are always live
 * from order_status. Each row also carries the staging box (STG-n) while an
 * assignment is open.
 */

export type FulfillmentListRow = LoaderRow & { boxLabel: string | null };

export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();
    const { orders, meta } = await loadOrders();

    const { data: open } = await db
      .from("staging_box_assignments")
      .select("order_id, staging_boxes(label)")
      .is("released_at", null);
    const boxByOrder = new Map(
      ((open ?? []) as any[]).map((a) => [String(a.order_id), (a.staging_boxes?.label as string | undefined) ?? null]),
    );

    const rows: FulfillmentListRow[] = orders.map((o) => ({ ...o, boxLabel: boxByOrder.get(o.orderId) ?? null }));
    return NextResponse.json({ ok: true, orders: rows, meta });
  } catch (error) {
    return errorResponse(error);
  }
}
