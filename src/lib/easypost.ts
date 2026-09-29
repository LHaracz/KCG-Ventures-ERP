/**
 * Hand-rolled EasyPost REST API client for the Fulfillments feature (Part 2).
 * No SDK — matches the same style as src/lib/shopifyAdmin.ts: native fetch,
 * a typed error class, small exported helpers. Test-mode key only; the
 * production key is intentionally not wired up yet (see Part 2 non-goals).
 */

const EASYPOST_BASE_URL = "https://api.easypost.com/v2";

export class EasyPostApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EasyPostApiError";
  }
}

function apiKey(): string {
  const key = process.env.EASYPOST_TEST_API_KEY;
  if (!key) {
    throw new Error("Missing EASYPOST_TEST_API_KEY. Set it in the environment to buy labels.");
  }
  return key;
}

function authHeader(): string {
  // EasyPost uses HTTP Basic Auth with the API key as the username and an
  // empty password.
  const encoded = Buffer.from(`${apiKey()}:`).toString("base64");
  return `Basic ${encoded}`;
}

// 10s bound on every EasyPost call — this client is now also invoked from
// the orders-create webhook (best-effort address verification at order
// creation), where a hung request would otherwise hold up webhook
// execution indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

async function easypostFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${EASYPOST_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new EasyPostApiError(`EasyPost request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw err;
  }

  const bodyText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // Non-JSON error body; fall through with parsed = null.
  }

  if (!response.ok) {
    const message =
      (parsed as { error?: { message?: string } } | null)?.error?.message ||
      bodyText ||
      `EasyPost request failed (${response.status}).`;
    throw new EasyPostApiError(message, response.status);
  }

  return parsed as T;
}

export type EasyPostAddress = {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
};

// EasyPost parcel dimensions are inches and weight is ounces — verified
// against current EasyPost docs, and matches this app's existing units
// (tare_weight_oz, length_in/width_in/height_in) with no conversion needed.
export type EasyPostParcel = {
  length: number;
  width: number;
  height: number;
  weight: number;
};

export type EasyPostRate = {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  delivery_days: number | null;
  shipment_id: string;
};

export type EasyPostShipment = {
  id: string;
  rates: EasyPostRate[];
};

export type EasyPostBuyResult = {
  id: string;
  tracking_code: string;
  selected_rate: { carrier: string; service: string; rate: string; currency: string } | null;
  postage_label: { label_url: string } | null;
  tracker: { id: string } | null;
};

export async function createEasyPostShipment(input: {
  to_address: EasyPostAddress;
  from_address: EasyPostAddress;
  parcel: EasyPostParcel;
}): Promise<EasyPostShipment> {
  return easypostFetch<EasyPostShipment>("/shipments", { shipment: input });
}

export async function buyEasyPostRate(
  shipmentId: string,
  rateId: string,
): Promise<EasyPostBuyResult> {
  return easypostFetch<EasyPostBuyResult>(`/shipments/${shipmentId}/buy`, {
    rate: { id: rateId },
  });
}

export type EasyPostRefundResult = {
  id: string;
  refund_status: string | null;
};

// POST /shipments/:id/refund — no request body. In EasyPost test mode this
// resolves instantly with no financial effect; in production the carrier
// side (refund_status "submitted") can take up to ~30 days, which doesn't
// block buying a fresh label locally.
export async function refundEasyPostShipment(shipmentId: string): Promise<EasyPostRefundResult> {
  return easypostFetch<EasyPostRefundResult>(`/shipments/${shipmentId}/refund`, {});
}

// --- Address verification (Shipping Address Verification & Flagging) ----
//
// EasyPost's address-only endpoint (POST /addresses with verify:
// ["delivery"]) — cheap and fast compared to creating a full shipment, and
// the right tool for "is this address deliverable" rather than "what does
// shipping it cost." A verification "failure" (undeliverable/invalid
// address) is a normal 200 response with verifications.delivery.success =
// false, not an HTTP error — easypostFetch only throws on a genuine
// request failure (bad auth, EasyPost outage, timeout, etc).

type EasyPostRawAddressResponse = EasyPostAddress & {
  verifications?: {
    delivery?: {
      success?: boolean;
      errors?: Array<{ code?: string; message?: string; field?: string }>;
    };
  };
};

export type EasyPostVerifyError = { code: string | null; message: string; field: string | null };

export type EasyPostVerifyResult = {
  success: boolean;
  errors: EasyPostVerifyError[];
  // EasyPost's corrected/standardized address, present whenever it returned
  // one — even alongside success: false, EasyPost sometimes still echoes
  // back a best-effort standardized address; callers decide what to do
  // with it based on `success`.
  correctedAddress: EasyPostAddress | null;
};

export async function verifyEasyPostAddress(address: EasyPostAddress): Promise<EasyPostVerifyResult> {
  const raw = await easypostFetch<EasyPostRawAddressResponse>("/addresses", {
    address: { ...address, verify: ["delivery"] },
  });

  const delivery = raw.verifications?.delivery;
  const success = delivery?.success === true;
  const errors: EasyPostVerifyError[] = (delivery?.errors || []).map((e) => ({
    code: e.code ?? null,
    message: e.message || "Unknown verification error.",
    field: e.field ?? null,
  }));

  const hasAddressFields = !!(raw.street1 && raw.city && raw.zip);
  const correctedAddress: EasyPostAddress | null = hasAddressFields
    ? {
        name: raw.name,
        company: raw.company,
        street1: raw.street1,
        street2: raw.street2,
        city: raw.city,
        state: raw.state,
        zip: raw.zip,
        country: raw.country,
        phone: raw.phone,
      }
    : null;

  return { success, errors, correctedAddress };
}
