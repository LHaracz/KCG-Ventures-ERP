import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";

/**
 * Print Label: stamps printed_at on the active label. Label Generated becomes
 * Label Printed; any other status, including Fulfilled (a replacement label),
 * is left as it is.
 */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();
    const { orderId } = await params;
    const body = (await request.json().catch(() => ({}))) as { logId?: string };
    if (!orderId?.trim() || !body.logId) return badRequest("Missing order or label.");
    const r = await db.rpc("mark_label_printed", { p_order_id: orderId, p_log_id: body.logId });
    if (r.error) return rpcErrorResponse(r.error);
    return NextResponse.json({ ok: true, status: (r.data as { status: string }).status });
  } catch (error) {
    return errorResponse(error);
  }
}
