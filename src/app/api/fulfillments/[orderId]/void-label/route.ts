import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { refundEasyPostShipment } from "@/lib/easypost";

/**
 * Fulfillments Part 2b — voids the most recent (not-yet-voided) label for an
 * order via EasyPost's refund endpoint, stamps voided_at on the
 * fulfillment_log row, and sets the local status to 'picked' when the order
 * still holds a staging box (otherwise preparing_shipment). The row itself
 * is never deleted — it stays as a record.
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

    const { data: statusRow } = await supabaseAdmin
      .from("order_status")
      .select("status")
      .eq("shopify_order_id", orderId)
      .maybeSingle();

    if (statusRow?.status === "fulfilled") {
      return badRequest(
        "This order is already marked fulfilled in Shopify. Voiding its label here would not undo that — this is out of scope for this UI.",
      );
    }

    const { data: logRow, error: logError } = await supabaseAdmin
      .from("fulfillment_log")
      .select("id, easypost_shipment_id, voided_at")
      .eq("shopify_order_id", orderId)
      .is("voided_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (logError || !logRow || !logRow.easypost_shipment_id) {
      return badRequest("No active label found for this order to void.");
    }

    await refundEasyPostShipment(logRow.easypost_shipment_id);

    // Stamp voided_at and set the status in one transaction: back to Picked
    // if the order still holds a staging box, otherwise Preparing Shipment.
    const finished = await supabaseAdmin.rpc("finish_label_void", {
      p_order_id: orderId,
      p_log_id: logRow.id,
    });
    if (finished.error) {
      return NextResponse.json(
        { error: `The label was voided in EasyPost but the ERP could not be updated: ${finished.error.message}` },
        { status: 500 },
      );
    }
    const newStatus = (finished.data as { status?: string } | null)?.status ?? "preparing_shipment";

    return NextResponse.json({ voided: true, status: newStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
