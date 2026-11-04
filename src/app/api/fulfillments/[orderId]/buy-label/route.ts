import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buyEasyPostRate } from "@/lib/easypost";
import { syncReplacementTracking } from "@/lib/shopifyTracking";

/**
 * Fulfillments Part 2b — purchase-only route. The rates quote (shipment
 * creation + pre-selection suggestion) now happens in the sibling /rates
 * route, called from the Generate Label popup. This route only ever buys
 * the rate the employee confirmed in that popup.
 *
 * Picking build: purchases are refused while the order is still Preparing
 * Shipment (not picked), and a second purchase is refused while an active
 * (non-voided) label exists or another purchase is in flight.
 *
 * Replacement labels: a fulfilled order whose labels are all voided may buy
 * one new label. Its status stays fulfilled, and the new tracking number is
 * put on the existing Shopify fulfillment (never a second fulfillment, never
 * Mark Fulfilled). If Shopify fails, the label is kept and the error is
 * recorded so the order page can offer "Retry Shopify update".
 */

type BuyLabelRequestBody = {
  easypostShipmentId: string;
  rateId: string;
  notifyCustomer?: boolean;
};

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

    const body = (await request.json()) as BuyLabelRequestBody;
    if (!body?.easypostShipmentId || !body?.rateId) {
      return badRequest("Missing shipment or rate selection.");
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: "Server is not configured." }, { status: 500 });
    }

    // Gate before any money is spent: the order must be picked, must not be
    // fulfilled, must not already have an active label, and no other
    // purchase for it may be in flight (begin_label_purchase, one transaction).
    const gate = await supabaseAdmin.rpc("begin_label_purchase", { p_order_id: orderId });
    if (gate.error) {
      const code = gate.error.hint || null;
      return NextResponse.json({ error: gate.error.message, code }, { status: code ? 409 : 500 });
    }

    let bought: Awaited<ReturnType<typeof buyEasyPostRate>>;
    try {
      bought = await buyEasyPostRate(body.easypostShipmentId, body.rateId);
    } catch (err) {
      await supabaseAdmin.rpc("cancel_label_purchase", { p_order_id: orderId });
      throw err;
    }
    if (!bought.postage_label?.label_url || !bought.selected_rate) {
      await supabaseAdmin.rpc("cancel_label_purchase", { p_order_id: orderId });
      return NextResponse.json({ error: "EasyPost did not return a label." }, { status: 500 });
    }

    // Log row + status label_generated in one transaction.
    const recorded = await supabaseAdmin.rpc("complete_label_purchase", {
      p_order_id: orderId,
      p_log: {
        tracking_number: bought.tracking_code,
        carrier: bought.selected_rate.carrier,
        service: bought.selected_rate.service,
        label_url: bought.postage_label.label_url,
        easypost_shipment_id: bought.id,
        rate_amount: bought.selected_rate.rate ? String(Number(bought.selected_rate.rate)) : null,
        rate_currency: bought.selected_rate.currency ?? null,
        tracking_url: bought.tracker?.public_url ?? null,
        notify_customer: body.notifyCustomer !== false,
      },
    });
    if (recorded.error) {
      // The label was bought but couldn't be recorded. Surface it loudly with
      // the tracking number so it can be voided in EasyPost by hand.
      console.error(
        `[buy-label] Label bought for order ${orderId} (shipment ${bought.id}, tracking ${bought.tracking_code}) but recording failed: ${recorded.error.message}`,
      );
      return NextResponse.json(
        {
          error: `The label was bought (tracking ${bought.tracking_code}) but could not be saved: ${recorded.error.message}. Void it in EasyPost before trying again.`,
        },
        { status: 500 },
      );
    }

    const rec = recorded.data as { log_id: string; replacement: boolean };
    let shopify: { ok: boolean; error?: string } | null = null;
    if (rec.replacement) {
      // Never fails the purchase: the result is recorded on the label row.
      const synced = await syncReplacementTracking(supabaseAdmin, orderId, rec.log_id);
      shopify = synced.ok ? { ok: true } : { ok: false, error: synced.error };
    }

    return NextResponse.json({
      bought: true,
      logId: rec.log_id,
      replacement: rec.replacement,
      shopify,
      trackingNumber: bought.tracking_code,
      carrier: bought.selected_rate.carrier,
      service: bought.selected_rate.service,
      labelUrl: bought.postage_label.label_url,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
