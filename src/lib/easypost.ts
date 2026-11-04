/**
 * Hand-rolled EasyPost REST API client for the Fulfillments feature (Part 2).
 * No SDK — matches the same style as src/lib/shopifyAdmin.ts: native fetch,
 * a typed error class, small exported helpers. Test-mode key only; the
 * production key is intentionally not wired up yet (see Part 2 non-goals).
 */

import { isFakeShipment } from "@/lib/e2eFakes";

const EASYPOST_BASE_URL = "https://api.easypost.com/v2";

export class EasyPostApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
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

// 10s bound on every EasyPost call, so a hung request can't hold up label
// buying/printing indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

// Never logs the Authorization header or the key.
function logRaw(method: string, path: string, status: number | string, bodyText: string) {
  console.info(`[easypost] ${method} ${path} -> ${status}: ${bodyText.slice(0, 4000)}`);
}

async function easypostFetch<T>(path: string, body: Record<string, unknown> | null, opts: { method?: "GET" | "POST"; logBody?: boolean } = {}): Promise<T> {
  const method = opts.method ?? "POST";
  let response: Response;
  try {
    response = await fetch(`${EASYPOST_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      logRaw(method, path, "timeout", "");
      throw new EasyPostApiError(`EasyPost request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    logRaw(method, path, "network-error", err instanceof Error ? err.message : String(err));
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
    // Raw error body, so the exact EasyPost answer can be seen in the logs.
    logRaw(method, path, response.status, bodyText);
    const message =
      (parsed as { error?: { message?: string } } | null)?.error?.message ||
      bodyText ||
      `EasyPost request failed (${response.status}).`;
    throw new EasyPostApiError(message, response.status, parsed);
  }
  if (opts.logBody) {
    // Success bodies are whole shipments (with addresses): log only the parts
    // that explain a refund.
    const p = (parsed ?? {}) as { id?: string; refund_status?: string; tracker?: { status?: string } | null };
    logRaw(method, path, response.status, JSON.stringify({ id: p.id, refund_status: p.refund_status, tracker_status: p.tracker?.status ?? null }));
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
  tracker: { id: string; public_url?: string | null } | null;
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
  if (isFakeShipment(shipmentId)) {
    const n = Math.floor(Math.random() * 1e9);
    return {
      id: shipmentId,
      tracking_code: `E2E-TRK-${n}`,
      selected_rate: { carrier: "USPS", service: "GroundAdvantage", rate: "4.50", currency: "USD" },
      postage_label: { label_url: "about:blank" },
      tracker: { id: `trk_e2e_${n}`, public_url: `https://example.invalid/track/${n}` },
    };
  }
  return easypostFetch<EasyPostBuyResult>(`/shipments/${shipmentId}/buy`, {
    rate: { id: rateId },
  });
}

export type EasyPostRefundResult = {
  id: string;
  refund_status: string | null;
  tracker?: { status?: string | null } | null;
};

// POST /shipments/:id/refund — no request body. Returns the shipment with
// refund_status ("submitted" first, "refunded" once the carrier processes
// it, which can take ~30 days). Carriers refuse refunds for parcels already
// scanned. In test mode test trackers advance by themselves, so refunds only
// work within about a minute of buying the label.
export async function refundEasyPostShipment(shipmentId: string): Promise<EasyPostRefundResult> {
  if (isFakeShipment(shipmentId)) {
    if (shipmentId.startsWith("shp_e2e_reject")) {
      throw new EasyPostApiError("Unable to request refund. The parcel has been shipped.", 422);
    }
    return { id: shipmentId, refund_status: "submitted", tracker: { status: "pre_transit" } };
  }
  return easypostFetch<EasyPostRefundResult>(`/shipments/${shipmentId}/refund`, {}, { logBody: true });
}

export type EasyPostShipmentStatus = {
  id: string;
  refund_status: string | null;
  tracking_code?: string | null;
  tracker?: { status?: string | null; public_url?: string | null } | null;
};

/** GET /shipments/:id — the current refund_status and tracker status. */
export async function retrieveEasyPostShipment(shipmentId: string): Promise<EasyPostShipmentStatus> {
  if (isFakeShipment(shipmentId)) return { id: shipmentId, refund_status: "refunded", tracker: { status: "pre_transit" } };
  return easypostFetch<EasyPostShipmentStatus>(`/shipments/${shipmentId}`, null, { method: "GET", logBody: true });
}

export type RefundOutcome = {
  status: "submitted" | "refunded" | "rejected" | "not_applicable" | "error";
  message: string | null;
  refundId: string | null;
  trackerStatus: string | null;
};

const REFUND_STATUSES = new Set(["submitted", "refunded", "rejected", "not_applicable"]);

/**
 * Ask EasyPost for a refund and turn every possible answer into one outcome.
 * Never throws: a carrier refusal is "rejected" (with EasyPost's message), a
 * timeout, network problem or server error is "error".
 */
export async function requestRefundOutcome(
  shipmentId: string,
  refund: (id: string) => Promise<EasyPostRefundResult> = refundEasyPostShipment,
): Promise<RefundOutcome> {
  try {
    const r = await refund(shipmentId);
    const status = r?.refund_status && REFUND_STATUSES.has(r.refund_status) ? (r.refund_status as RefundOutcome["status"]) : "submitted";
    return { status, message: null, refundId: r?.id ?? null, trackerStatus: r?.tracker?.status ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = err instanceof EasyPostApiError ? err.status : undefined;
    // 4xx: EasyPost or the carrier refused the request. Anything else: we don't know.
    const rejected = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 401 && httpStatus !== 429;
    return { status: rejected ? "rejected" : "error", message, refundId: null, trackerStatus: null };
  }
}
