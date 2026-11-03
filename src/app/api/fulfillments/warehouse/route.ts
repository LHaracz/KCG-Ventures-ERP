import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { errorResponse, loadOrders, requireAdmin } from "@/lib/fulfillmentApi";
import { loadWarehouseSnapshot } from "@/lib/warehouse";

/**
 * Data for the Pick List and Shipping Assignments pages (polled about every
 * 15 seconds). Runs the box reconcile first, then reads orders through the
 * Fulfillments list's shared loader (Shopify at most once a minute) and joins
 * boxes, assignments, rules and overrides.
 */
export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();

    const reconcile = await db.rpc("reconcile_staging_assignments");
    if (reconcile.error) console.error(`[warehouse] reconcile failed: ${reconcile.error.message}`);

    const { orders, meta } = await loadOrders();
    const snapshot = await loadWarehouseSnapshot(db, orders);
    return NextResponse.json({ ok: true, ...snapshot, meta, serverTime: new Date().toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
}
