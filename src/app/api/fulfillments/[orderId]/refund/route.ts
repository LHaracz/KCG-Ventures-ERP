import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";
import { requestRefundOutcome, retrieveEasyPostShipment } from "@/lib/easypost";
import { guardApi } from "@/lib/access/api";

/**
 * Refund follow-up for a voided label.
 *  - action "retry": request the refund again, only when the last answer was
 *    rejected or an error (EasyPost may wrongly reject a refund requested very
 *    soon after the label was made). Blocked once submitted or refunded.
 *  - action "check": read the current refund status from EasyPost for a
 *    refund that is submitted.
 */
const KNOWN = new Set(["submitted", "refunded", "rejected", "not_applicable"]);

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const db = requireAdmin();
    const { orderId } = await params;
    const body = (await request.json().catch(() => ({}))) as { logId?: string; action?: string };
    if (!orderId?.trim() || !body.logId) return badRequest("Missing order or label.");

    if (body.action === "retry") {
      const claim = await db.rpc("begin_refund_retry", { p_order_id: orderId, p_log_id: body.logId });
      if (claim.error) return rpcErrorResponse(claim.error);
      const shipmentId = (claim.data as { shipment_id: string | null }).shipment_id;
      if (!shipmentId) return badRequest("No EasyPost shipment is recorded for this label.");
      const outcome = await requestRefundOutcome(shipmentId);
      console.info(`[refund-retry] Order ${orderId} label ${body.logId}: refund ${outcome.status}${outcome.message ? ` (${outcome.message})` : ""}`);
      const patch: Record<string, unknown> = { refund_status: outcome.status, refund_message: outcome.message };
      if (outcome.refundId) patch.easypost_refund_id = outcome.refundId;
      if (outcome.trackerStatus) patch.easypost_tracker_status = outcome.trackerStatus;
      const { error } = await db.from("fulfillment_log").update(patch).eq("id", body.logId).eq("shopify_order_id", orderId);
      if (error) throw new Error(`EasyPost answered (refund ${outcome.status}) but it could not be saved: ${error.message}`);
      return NextResponse.json({ ok: true, refund: { status: outcome.status, message: outcome.message } });
    }

    if (body.action === "check") {
      const { data: row, error } = await db
        .from("fulfillment_log")
        .select("id, easypost_shipment_id, refund_status, voided_at")
        .eq("id", body.logId)
        .eq("shopify_order_id", orderId)
        .maybeSingle();
      if (error || !row) return badRequest("Label not found for this order.");
      if (row.refund_status !== "submitted") {
        return NextResponse.json({ error: "Only a submitted refund can be checked.", code: "not_submitted" }, { status: 409 });
      }
      if (!row.easypost_shipment_id) return badRequest("No EasyPost shipment is recorded for this label.");
      const shipment = await retrieveEasyPostShipment(row.easypost_shipment_id);
      const current = shipment.refund_status && KNOWN.has(shipment.refund_status) ? shipment.refund_status : row.refund_status;
      const patch: Record<string, unknown> = { refund_status: current };
      if (shipment.tracker?.status) patch.easypost_tracker_status = shipment.tracker.status;
      const saved = await db.from("fulfillment_log").update(patch).eq("id", row.id);
      if (saved.error) throw new Error(saved.error.message);
      return NextResponse.json({ ok: true, refund: { status: current, message: null } });
    }

    return badRequest("Unknown action.");
  } catch (error) {
    return errorResponse(error);
  }
}
