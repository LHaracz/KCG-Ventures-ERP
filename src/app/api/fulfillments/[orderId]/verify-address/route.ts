import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchLiveShippingAddress, type CanonicalAddress } from "@/lib/fulfillmentOrder";
import { verifyEasyPostAddress } from "@/lib/easypost";
import {
  canonicalToEasyPostAddress,
  deriveVerificationStatus,
  hasRequiredAddressFields,
  verifyAndPersistAddress,
} from "@/lib/addressVerification";

/**
 * Shipping Address Verification & Flagging — verify-only route.
 *
 * Two modes, selected by whether an `address` is present in the body:
 *  - No body / `{}`: verifies the order's current EFFECTIVE address (its
 *    already-accepted override if one exists, else the live Shopify
 *    address) and PERSISTS the result to order_address_verification. Never
 *    trusts a client-sent address for this — always re-fetches server-side,
 *    matching this feature's stricter convention (see the plan).
 *  - `{ address }`: verifies an unsaved manual-edit DRAFT. Nothing is
 *    persisted here — this is only a preview so the employee can see what
 *    an edit would verify as before deciding to save it via
 *    /accept-address.
 */

type VerifyAddressRequestBody = { address?: CanonicalAddress };

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");

    let body: VerifyAddressRequestBody = {};
    const rawBody = await request.text();
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody) as VerifyAddressRequestBody;
      } catch {
        return badRequest("Invalid JSON body.");
      }
    }

    // Draft-preview mode.
    if (body.address) {
      if (!hasRequiredAddressFields(body.address)) {
        return badRequest("This address is missing required fields (street, city, ZIP).");
      }
      const result = await verifyEasyPostAddress(canonicalToEasyPostAddress(body.address));
      const { status, details } = deriveVerificationStatus(result, body.address);
      return NextResponse.json({ status, details, persisted: false });
    }

    // Persisted mode — verify this order's current effective address.
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Server misconfiguration: Supabase service role client is not available." },
        { status: 500 },
      );
    }

    const { data: existing } = await supabaseAdmin
      .from("order_address_verification")
      .select("accepted_address")
      .eq("shopify_order_id", orderId)
      .maybeSingle();

    const acceptedAddress = (existing?.accepted_address as CanonicalAddress | null) ?? null;
    const effectiveAddress: CanonicalAddress | null = acceptedAddress ?? (await fetchLiveShippingAddress(orderId));

    if (!effectiveAddress) return badRequest("This order has no shipping address.");
    if (!hasRequiredAddressFields(effectiveAddress)) {
      return badRequest("This order's shipping address is missing required fields.");
    }

    const { status, details } = await verifyAndPersistAddress(supabaseAdmin, orderId, effectiveAddress);
    return NextResponse.json({ status, details, persisted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
