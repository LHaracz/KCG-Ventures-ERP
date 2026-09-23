import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buyEasyPostRate } from "@/lib/easypost";

/**
 * Fulfillments Part 2b — purchase-only route. The rates quote (shipment
 * creation + pre-selection suggestion) now happens in the sibling /rates
 * route, called from the Generate Label popup. This route only ever buys
 * the rate the employee confirmed in that popup.
 */

type BuyLabelRequestBody = {
  easypostShipmentId: string;
  rateId: string;
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

    const bought = await buyEasyPostRate(body.easypostShipmentId, body.rateId);
    if (!bought.postage_label?.label_url || !bought.selected_rate) {
      return NextResponse.json({ error: "EasyPost did not return a label." }, { status: 500 });
    }

    if (supabaseAdmin) {
      await supabaseAdmin.from("fulfillment_log").insert({
        shopify_order_id: orderId,
        tracking_number: bought.tracking_code,
        carrier: bought.selected_rate.carrier,
        service: bought.selected_rate.service,
        label_url: bought.postage_label.label_url,
        easypost_shipment_id: bought.id,
        rate_amount: bought.selected_rate.rate ? Number(bought.selected_rate.rate) : null,
        rate_currency: bought.selected_rate.currency ?? null,
      });

      await supabaseAdmin
        .from("order_status")
        .upsert(
          { shopify_order_id: orderId, status: "label_generated", updated_at: new Date().toISOString() },
          { onConflict: "shopify_order_id" },
        );
    }

    return NextResponse.json({
      bought: true,
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
