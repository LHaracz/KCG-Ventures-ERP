import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { errorResponse, requireAdmin } from "@/lib/fulfillmentApi";
import { guardApi } from "@/lib/access/api";

/**
 * Every flagged order for the Dashboard's Flagged Orders card (fulfilled
 * ones only with ?includeFulfilled=1), oldest order first. Order number,
 * date and customer come from the ERP-side order cache, falling back to the
 * imported Sales Data orders; no Shopify calls.
 */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();
    const includeFulfilled = new URL(request.url).searchParams.get("includeFulfilled") === "1";
    let q = db
      .from("order_status")
      .select("shopify_order_id, status, flagged_reason, flagged_at, flagged_by, flag_source, flag_detail")
      .eq("is_flagged", true);
    if (!includeFulfilled) q = q.neq("status", "fulfilled");
    const { data: flagged, error } = await q;
    if (error) throw new Error(error.message);
    const ids = (flagged ?? []).map((r: any) => String(r.shopify_order_id));
    const cacheById = new Map<string, any>();
    const importedById = new Map<string, any>();
    if (ids.length) {
      const [cacheRes, importedRes] = await Promise.all([
        db.from("fulfillment_orders_cache").select("shopify_order_id, payload").in("shopify_order_id", ids),
        db.from("orders").select("shopify_order_id, order_name, created_at, customer_name").in("shopify_order_id", ids),
      ]);
      for (const r of (cacheRes.data ?? []) as any[]) cacheById.set(String(r.shopify_order_id), r.payload);
      for (const r of (importedRes.data ?? []) as any[]) importedById.set(String(r.shopify_order_id), r);
    }
    const rows = ((flagged ?? []) as any[]).map((r) => {
      const id = String(r.shopify_order_id);
      const c = cacheById.get(id);
      const imp = importedById.get(id);
      return {
        orderId: id,
        orderName: c?.name ?? imp?.order_name ?? `#${id}`,
        orderDate: c?.createdAt ?? (imp?.created_at ? new Date(imp.created_at).toISOString() : null),
        customerName: c?.customerName ?? imp?.customer_name ?? "—",
        status: r.status,
        reason: r.flagged_reason,
        flagSource: r.flag_source ?? "manual",
        flagDetail: r.flag_detail ?? null,
        flaggedAt: r.flagged_at ? new Date(r.flagged_at).toISOString() : null,
        flaggedBy: r.flagged_by ?? null,
      };
    });
    rows.sort((a, b) => {
      const ta = new Date(a.orderDate ?? a.flaggedAt ?? 0).getTime();
      const tb = new Date(b.orderDate ?? b.flaggedAt ?? 0).getTime();
      return ta - tb || a.orderName.localeCompare(b.orderName);
    });
    return NextResponse.json({ ok: true, orders: rows });
  } catch (error) {
    return errorResponse(error);
  }
}
