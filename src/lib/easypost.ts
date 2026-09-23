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

async function easypostFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${EASYPOST_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify(body),
  });

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
