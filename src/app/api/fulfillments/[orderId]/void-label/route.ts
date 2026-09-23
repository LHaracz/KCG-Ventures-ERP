import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { refundEasyPostShipment } from "@/lib/easypost";

/**
 * Fulfillments Part 2b — voids the most recent (not-yet-voided) label for an
 * order via EasyPost's refund endpoint, reverts local status back to
 * preparing_shipment, and stamps voided_at on the fulfillment_log row. The
 * row itself is never deleted — it stays as a record.
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

    const nowIso = new Date().toISOString();

    await supabaseAdmin.from("fulfillment_log").update({ voided_at: nowIso }).eq("id", logRow.id);

    await supabaseAdmin
      .from("order_status")
      .upsert(
        { shopify_order_id: orderId, status: "preparing_shipment", updated_at: nowIso },
        { onConflict: "shopify_order_id" },
      );

    return NextResponse.json({ voided: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
