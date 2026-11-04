/**
 * Replacement labels on fulfilled orders: put the new tracking number on the
 * order's existing Shopify fulfillment (fulfillmentTrackingInfoUpdate). It
 * never creates a fulfillment and never calls Mark Fulfilled.
 *
 * Needs one of the write_*_fulfillment_orders scopes (the same family
 * fulfillmentCreate already uses for Mark Fulfilled).
 */
import { shopifyAdminGraphQL, toOrderGid } from "@/lib/shopifyAdmin";
import { isFakeOrder } from "@/lib/e2eFakes";

type GraphQL = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const ORDER_FULFILLMENTS_QUERY = `
  query OrderFulfillments($id: ID!) {
    order(id: $id) {
      fulfillments(first: 20) {
        id
        status
        createdAt
      }
    }
  }
`;

const TRACKING_UPDATE_MUTATION = `
  mutation UpdateFulfillmentTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
      fulfillment { id }
      userErrors { field message }
    }
  }
`;

/** The order's latest fulfillment that isn't cancelled, from Shopify. */
export async function lookupFulfillmentId(orderId: string, graphql: GraphQL = shopifyAdminGraphQL): Promise<string | null> {
  const data = await graphql<{ order: { fulfillments: Array<{ id: string; status: string; createdAt: string }> } | null }>(
    ORDER_FULFILLMENTS_QUERY,
    { id: toOrderGid(orderId) },
  );
  const list = (data.order?.fulfillments ?? []).filter((f) => f.status !== "CANCELLED" && f.status !== "ERROR" && f.status !== "FAILURE");
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return list[0]?.id ?? null;
}

/** Browser tests only (E2E_MODE): succeeds, or fails when the order id contains "SHOPIFYFAIL". */
const fakeGraphQL = (orderId: string): GraphQL =>
  (async (query: string) => {
    if (query.includes("OrderFulfillments")) return { order: { fulfillments: [{ id: "gid://shopify/Fulfillment/e2e", status: "SUCCESS", createdAt: "2026-01-01T00:00:00Z" }] } };
    if (orderId.includes("SHOPIFYFAIL")) return { fulfillmentTrackingInfoUpdate: { fulfillment: null, userErrors: [{ field: null, message: "Simulated Shopify error" }] } };
    return { fulfillmentTrackingInfoUpdate: { fulfillment: { id: "gid://shopify/Fulfillment/e2e" }, userErrors: [] } };
  }) as GraphQL;

export type TrackingSyncResult = { ok: true; fulfillmentId: string } | { ok: false; error: string };

/**
 * Sends the label's tracking number to Shopify and records the result on the
 * label row (shopify_tracking_synced_at or shopify_sync_error). Never throws.
 */
export async function syncReplacementTracking(
  db: Db,
  orderId: string,
  logId: string,
  graphqlArg?: GraphQL,
): Promise<TrackingSyncResult> {
  const graphql: GraphQL = graphqlArg ?? (isFakeOrder(orderId) ? fakeGraphQL(orderId) : shopifyAdminGraphQL);
  const record = async (patch: Record<string, unknown>) => {
    const { error } = await db.from("fulfillment_log").update(patch).eq("id", logId);
    if (error) console.error(`[shopify-tracking] Could not record the sync result for order ${orderId}: ${error.message}`);
  };
  try {
    const { data: row, error } = await db
      .from("fulfillment_log")
      .select("id, tracking_number, carrier, tracking_url, notify_customer, shopify_fulfillment_id, voided_at")
      .eq("id", logId)
      .eq("shopify_order_id", orderId)
      .maybeSingle();
    if (error || !row) return { ok: false, error: error?.message ?? "Label not found." };
    if (row.voided_at) return { ok: false, error: "This label is voided." };

    let fulfillmentId: string | null = row.shopify_fulfillment_id ?? null;
    if (!fulfillmentId) {
      const { data: older } = await db
        .from("fulfillment_log")
        .select("shopify_fulfillment_id")
        .eq("shopify_order_id", orderId)
        .not("shopify_fulfillment_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      fulfillmentId = older?.shopify_fulfillment_id ?? null;
    }
    if (!fulfillmentId) fulfillmentId = await lookupFulfillmentId(orderId, graphql);
    if (!fulfillmentId) {
      const msg = "Shopify has no fulfillment for this order to update.";
      await record({ shopify_sync_error: msg });
      return { ok: false, error: msg };
    }

    const result = await graphql<{
      fulfillmentTrackingInfoUpdate: { fulfillment: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> };
    }>(TRACKING_UPDATE_MUTATION, {
      fulfillmentId,
      trackingInfoInput: {
        company: row.carrier ?? undefined,
        number: row.tracking_number,
        ...(row.tracking_url ? { url: row.tracking_url } : {}),
      },
      notifyCustomer: row.notify_customer !== false,
    });
    const userErrors = result?.fulfillmentTrackingInfoUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      const msg = userErrors.map((e) => e.message).join("; ");
      await record({ shopify_sync_error: msg, shopify_fulfillment_id: fulfillmentId });
      return { ok: false, error: msg };
    }
    await record({ shopify_fulfillment_id: fulfillmentId, shopify_tracking_synced_at: new Date().toISOString(), shopify_sync_error: null });
    return { ok: true, fulfillmentId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[shopify-tracking] Update failed for order ${orderId}: ${msg}`);
    await record({ shopify_sync_error: msg });
    return { ok: false, error: msg };
  }
}
