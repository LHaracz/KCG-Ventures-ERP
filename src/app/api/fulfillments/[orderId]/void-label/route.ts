import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requestRefundOutcome, type RefundOutcome } from "@/lib/easypost";

/**
 * Voids the order's active label, at any stage (Label Generated, Label
 * Printed or Fulfilled).
 *
 *  1. Claim the label (begin_label_void): refuses a second void in flight and
 *     says whether a refund was already requested for it.
 *  2. Ask EasyPost for a refund, once per label. Every answer (submitted,
 *     refunded, rejected, not applicable, error) is recorded.
 *  3. Void the label here whatever EasyPost said (complete_label_void): not
 *     fulfilled -> Picked (holds a box) or Preparing Shipment; fulfilled ->
 *     stays fulfilled, nothing in Shopify, boxes, batches or inventory changes.
 *
 * Label rows are never deleted.
 */

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");

    if (!supabaseAdmin) {
      return NextResponse.json({ error: "Server is not configured." }, { status: 500 });
    }

    let note: string | null = null;
    try {
      const body = (await request.json()) as { note?: unknown } | null;
      note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    } catch {
      /* no body */
    }

    const { data: logRow, error: logError } = await supabaseAdmin
      .from("fulfillment_log")
      .select("id, easypost_shipment_id, tracking_number")
      .eq("shopify_order_id", orderId)
      .is("voided_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (logError || !logRow) {
      return badRequest("No active label found for this order to void.");
    }

    const claim = await supabaseAdmin.rpc("begin_label_void", { p_order_id: orderId, p_log_id: logRow.id });
    if (claim.error) {
      const code = claim.error.hint || null;
      return NextResponse.json({ error: claim.error.message, code }, { status: code ? 409 : 500 });
    }
    const claimed = claim.data as { shipment_id: string | null; refund_already_requested: boolean; refund_status: string | null; refund_message: string | null };

    let outcome: RefundOutcome;
    if (claimed.refund_already_requested) {
      // A refund was already requested for this label (an earlier void that
      // didn't finish). Never request it twice.
      outcome = {
        status: (claimed.refund_status as RefundOutcome["status"]) ?? "error",
        message: claimed.refund_message ?? "A refund was already requested for this label earlier. Use Check status to see its result.",
        refundId: null,
        trackerStatus: null,
      };
    } else if (!claimed.shipment_id) {
      outcome = { status: "not_applicable", message: "No EasyPost shipment is recorded for this label.", refundId: null, trackerStatus: null };
    } else {
      outcome = await requestRefundOutcome(claimed.shipment_id);
      console.info(
        `[void-label] Order ${orderId} label ${logRow.id}: refund ${outcome.status}${outcome.message ? ` (${outcome.message})` : ""}`,
      );
    }

    const finished = await supabaseAdmin.rpc("complete_label_void", {
      p_order_id: orderId,
      p_log_id: logRow.id,
      p_refund: { status: outcome.status, message: outcome.message, refund_id: outcome.refundId, tracker_status: outcome.trackerStatus },
      p_note: note,
    });
    if (finished.error) {
      return NextResponse.json(
        { error: `EasyPost answered (refund ${outcome.status}) but the ERP could not void the label: ${finished.error.message}. Try Void Label again; the refund will not be requested twice.` },
        { status: 500 },
      );
    }
    const result = finished.data as { status: string; fulfilled: boolean };

    return NextResponse.json({
      voided: true,
      status: result.status,
      fulfilled: result.fulfilled,
      trackingNumber: logRow.tracking_number,
      refund: { status: outcome.status, message: outcome.message },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
