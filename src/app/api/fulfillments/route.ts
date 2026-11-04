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

export type FulfillmentListRow = LoaderRow & { boxLabel: string | null; needsNewLabel: boolean };

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

    // "Needs new label": fulfilled, had a label, and every label is voided.
    const fulfilledIds = orders.filter((o) => o.status === "fulfilled").map((o) => o.orderId);
    const labelState = new Map<string, { any: boolean; active: boolean }>();
    if (fulfilledIds.length > 0) {
      const { data: labels } = await db.from("fulfillment_log").select("shopify_order_id, voided_at").in("shopify_order_id", fulfilledIds);
      for (const l of (labels ?? []) as Array<{ shopify_order_id: string; voided_at: string | null }>) {
        const cur = labelState.get(String(l.shopify_order_id)) ?? { any: false, active: false };
        cur.any = true;
        if (!l.voided_at) cur.active = true;
        labelState.set(String(l.shopify_order_id), cur);
      }
    }

    const rows: FulfillmentListRow[] = orders.map((o) => {
      const ls = labelState.get(o.orderId);
      return { ...o, boxLabel: boxByOrder.get(o.orderId) ?? null, needsNewLabel: o.status === "fulfilled" && !!ls?.any && !ls.active };
    });
    return NextResponse.json({ ok: true, orders: rows, meta });
  } catch (error) {
    return errorResponse(error);
  }
}
