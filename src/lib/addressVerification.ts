import type { CanonicalAddress } from "@/lib/fulfillmentOrder";
import { verifyEasyPostAddress, type EasyPostAddress, type EasyPostVerifyError, type EasyPostVerifyResult } from "@/lib/easypost";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Shared helpers for Shipping Address Verification & Flagging — the badge
 * (mirrors src/lib/fulfillmentStatus.ts's fulfillmentStatusBadge shape/
 * style exactly), address-shape conversion between this app's canonical
 * shape and EasyPost's, and the status-derivation logic shared by the
 * verify-address API route and the orders-create webhook's best-effort
 * verify-at-creation block.
 */

export const ADDRESS_VERIFICATION_STATUSES = [
  "unchecked",
  "verified",
  "needs_review",
  "failed",
] as const;

export type AddressVerificationStatus = (typeof ADDRESS_VERIFICATION_STATUSES)[number];

const LABELS: Record<AddressVerificationStatus, string> = {
  unchecked: "Not Checked",
  verified: "Verified",
  needs_review: "Needs Review",
  failed: "Address Issue",
};

const COLORS: Record<AddressVerificationStatus, string> = {
  unchecked: "bg-zinc-400 text-white",
  verified: "bg-emerald-600 text-white",
  needs_review: "bg-amber-500 text-white",
  failed: "bg-red-600 text-white",
};

export function addressVerificationLabel(status: AddressVerificationStatus | null | undefined): string {
  return LABELS[status ?? "unchecked"];
}

export function addressVerificationBadge(status: AddressVerificationStatus | null | undefined): {
  label: string;
  className: string;
} {
  const s = status ?? "unchecked";
  return {
    label: LABELS[s],
    className: `inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${COLORS[s]}`,
  };
}

// Case/whitespace-insensitive compare of the fields EasyPost actually
// verifies. name/phone are deliberately excluded — EasyPost doesn't check
// those, and cosmetic name formatting shouldn't flip verified/needs_review
// or trigger a false staleness banner.
export function addressesEqual(a: CanonicalAddress | null, b: CanonicalAddress | null): boolean {
  if (!a || !b) return a === b;
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const fields: Array<keyof CanonicalAddress> = ["address1", "address2", "city", "province", "zip", "country"];
  return fields.every((f) => norm(a[f]) === norm(b[f]));
}

export function hasRequiredAddressFields(address: CanonicalAddress | null): address is CanonicalAddress {
  return !!(address && address.address1?.trim() && address.city?.trim() && address.zip?.trim());
}

export function canonicalToEasyPostAddress(address: CanonicalAddress): EasyPostAddress {
  return {
    name: address.name || "Customer",
    street1: address.address1 || "",
    street2: address.address2 || undefined,
    city: address.city || "",
    state: address.province || "",
    zip: address.zip || "",
    country: address.country || "US",
    phone: address.phone || undefined,
  };
}

export function easyPostAddressToCanonical(address: EasyPostAddress, fallbackName?: string): CanonicalAddress {
  return {
    name: address.name || fallbackName || "",
    address1: address.street1 ?? null,
    address2: address.street2 ?? null,
    city: address.city ?? null,
    province: address.state ?? null,
    zip: address.zip ?? null,
    country: address.country ?? null,
    phone: address.phone ?? null,
  };
}

export type AddressVerificationDetails = {
  originalAddress: CanonicalAddress;
  suggestedAddress: CanonicalAddress | null;
  messages: EasyPostVerifyError[];
};

// Shared by the verify-address route (persisted checks + draft previews)
// and the orders-create webhook's best-effort verify-at-creation block, so
// "what status does this EasyPost result imply" is decided in exactly one
// place.
export function deriveVerificationStatus(
  result: EasyPostVerifyResult,
  submitted: CanonicalAddress,
): { status: AddressVerificationStatus; details: AddressVerificationDetails } {
  const suggestedAddress = result.correctedAddress
    ? easyPostAddressToCanonical(result.correctedAddress, submitted.name)
    : null;

  let status: AddressVerificationStatus;
  if (!result.success) {
    status = "failed";
  } else if (suggestedAddress && !addressesEqual(submitted, suggestedAddress)) {
    status = "needs_review";
  } else {
    status = "verified";
  }

  return {
    status,
    details: { originalAddress: submitted, suggestedAddress, messages: result.errors },
  };
}

// Calls EasyPost, derives the status, and upserts order_address_verification
// — the single implementation shared by /api/fulfillments/[orderId]/
// verify-address's persisted-check branch and the orders-create webhook's
// best-effort verify-at-creation block, so "what happens when an address
// gets checked and saved" only lives in one place. Does NOT touch
// accepted_address — see /accept-address for that.
export async function verifyAndPersistAddress(
  admin: NonNullable<typeof supabaseAdmin>,
  shopifyOrderId: string,
  address: CanonicalAddress,
): Promise<{ status: AddressVerificationStatus; details: AddressVerificationDetails }> {
  const result = await verifyEasyPostAddress(canonicalToEasyPostAddress(address));
  const { status, details } = deriveVerificationStatus(result, address);
  const now = new Date().toISOString();

  const { error } = await admin.from("order_address_verification").upsert(
    {
      shopify_order_id: shopifyOrderId,
      status,
      address_verification_details: details,
      checked_at: now,
      updated_at: now,
    },
    { onConflict: "shopify_order_id" },
  );
  if (error) throw new Error(error.message);

  return { status, details };
}
