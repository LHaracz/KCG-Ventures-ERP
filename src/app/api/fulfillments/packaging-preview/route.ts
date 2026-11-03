import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { errorResponse, requireAdmin } from "@/lib/fulfillmentApi";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadPackagingConfig } from "@/lib/warehouse";
import { buildPackagingPreview, type PreviewOrder } from "@/lib/packagingPreview";

/**
 * Read-only "Last 90 days" packaging preview. Uses the ERP's imported
 * orders (orders / order_line_items, the Sales Data tables), every channel
 * except POS, and the same component resolution as every other screen. One
 * server-side pass; no Shopify calls; nothing is written.
 */
export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const ordersRes = await fetchAllRows<{ id: string; channel: string | null }>((from, to) =>
      db.from("orders").select("id, channel").gte("created_at", since).order("created_at", { ascending: true }).range(from, to),
    );
    if (ordersRes.error) throw new Error(`Could not load orders: ${ordersRes.error.message}`);
    const orders = ordersRes.data.filter((o) => (o.channel ?? "").toLowerCase() !== "pos");
    const ids = orders.map((o) => o.id);

    const lineItems: Array<{ order_id: string; lineitem_name: string; quantity: number }> = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const res = await fetchAllRows<{ order_id: string; lineitem_name: string; quantity: number }>((from, to) =>
        db.from("order_line_items").select("order_id, lineitem_name, quantity").in("order_id", chunk).range(from, to),
      );
      if (res.error) throw new Error(`Could not load order line items: ${res.error.message}`);
      lineItems.push(...res.data);
    }

    const byOrder = new Map<string, PreviewOrder>(ids.map((id) => [id, { id, lineItems: [] }]));
    for (const li of lineItems) {
      byOrder.get(li.order_id)?.lineItems.push({ name: li.lineitem_name, quantity: Number(li.quantity) || 0 });
    }

    const config = await loadPackagingConfig(db);
    const preview = buildPackagingPreview(Array.from(byOrder.values()), config.resolver, config.rules, config.presetInputs);
    return NextResponse.json({ ok: true, since, ...preview });
  } catch (error) {
    return errorResponse(error);
  }
}
