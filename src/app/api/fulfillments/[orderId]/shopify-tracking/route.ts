import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, requireAdmin } from "@/lib/fulfillmentApi";
import { syncReplacementTracking } from "@/lib/shopifyTracking";
import { guardApi } from "@/lib/access/api";

/** "Retry Shopify update": send a replacement label's tracking number to Shopify again. */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();
    const { orderId } = await params;
    const body = (await request.json().catch(() => ({}))) as { logId?: string };
    if (!orderId?.trim() || !body.logId) return badRequest("Missing order or label.");
    const { data: row } = await db
      .from("fulfillment_log")
      .select("id, is_replacement, voided_at")
      .eq("id", body.logId)
      .eq("shopify_order_id", orderId)
      .maybeSingle();
    if (!row) return badRequest("Label not found for this order.");
    if (!row.is_replacement || row.voided_at) {
      return NextResponse.json({ error: "Only an active replacement label is sent to Shopify.", code: "not_replacement" }, { status: 409 });
    }
    const result = await syncReplacementTracking(db, orderId, body.logId);
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
