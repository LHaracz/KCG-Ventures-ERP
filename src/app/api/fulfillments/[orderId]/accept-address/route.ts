import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { CanonicalAddress } from "@/lib/fulfillmentOrder";
import {
  hasRequiredAddressFields,
  type AddressVerificationDetails,
  type AddressVerificationStatus,
} from "@/lib/addressVerification";

/**
 * Shipping Address Verification & Flagging — commits the address an
 * employee has reviewed as the one to use for this order going forward
 * (label buying reads accepted_address once it's set — see the order
 * detail page's rates wiring). Used both by "Accept suggested address"
 * (address = the last check's suggestedAddress) and by saving a manual
 * edit (address = the edited draft) — in both cases the client already has
 * a verification result in hand (from /verify-address) and passes it along
 * so this route doesn't need a second EasyPost call just to accept it.
 */

type AcceptAddressRequestBody = {
  address: CanonicalAddress;
  verification?: { status: AddressVerificationStatus; details: AddressVerificationDetails };
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");

    const body = (await request.json()) as AcceptAddressRequestBody;
    if (!body?.address) return badRequest("Missing address.");
    if (!hasRequiredAddressFields(body.address)) {
      return badRequest("This address is missing required fields (street, city, ZIP).");
    }

    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Server misconfiguration: Supabase service role client is not available." },
        { status: 500 },
      );
    }

    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      shopify_order_id: orderId,
      accepted_address: body.address,
      updated_at: now,
    };
    if (body.verification) {
      payload.status = body.verification.status;
      payload.address_verification_details = body.verification.details;
      payload.checked_at = now;
    }

    const { error } = await supabaseAdmin
      .from("order_address_verification")
      .upsert(payload, { onConflict: "shopify_order_id" });
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, acceptedAddress: body.address });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
