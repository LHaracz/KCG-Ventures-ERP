import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { shopifyAdminGraphQL, toOrderGid } from "@/lib/shopifyAdmin";
import { guardApi } from "@/lib/access/api";

type FulfillmentOrdersResponse = {
  order: {
    fulfillmentOrders: {
      edges: Array<{ node: { id: string } }>;
    };
  } | null;
};

const FULFILLMENT_ORDERS_QUERY = `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 5) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
`;

type FulfillmentCreateResponse = {
  fulfillmentCreate: {
    fulfillment: { id: string; status: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

const FULFILLMENT_CREATE_MUTATION = `
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) {
      return NextResponse.json({ error: "Missing orderId." }, { status: 400 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Server is not configured (missing service role key)." },
        { status: 500 },
      );
    }

    const { data: statusRow } = await supabaseAdmin
      .from("order_status")
      .select("status")
      .eq("shopify_order_id", orderId)
      .maybeSingle();

    if (!statusRow || statusRow.status !== "label_printed") {
      return NextResponse.json(
        { error: "Label must be printed before marking this order fulfilled." },
        { status: 400 },
      );
    }

    const { data: logRow } = await supabaseAdmin
      .from("fulfillment_log")
      .select("tracking_number, carrier, service")
      .eq("shopify_order_id", orderId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!logRow?.tracking_number) {
      return NextResponse.json(
        { error: "No shipping label found for this order." },
        { status: 400 },
      );
    }

    const orderGid = toOrderGid(orderId);
    const fulfillmentOrdersData = await shopifyAdminGraphQL<FulfillmentOrdersResponse>(
      FULFILLMENT_ORDERS_QUERY,
      { id: orderGid },
    );

    const fulfillmentOrderId =
      fulfillmentOrdersData.order?.fulfillmentOrders.edges[0]?.node.id;
    if (!fulfillmentOrderId) {
      return NextResponse.json(
        { error: "This order has no open fulfillment order in Shopify." },
        { status: 400 },
      );
    }

    const result = await shopifyAdminGraphQL<FulfillmentCreateResponse>(
      FULFILLMENT_CREATE_MUTATION,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
          notifyCustomer: true,
          trackingInfo: {
            company: logRow.carrier,
            number: logRow.tracking_number,
          },
        },
      },
    );

    const userErrors = result.fulfillmentCreate.userErrors;
    if (userErrors && userErrors.length > 0) {
      return NextResponse.json(
        { error: userErrors.map((e) => e.message).join("; ") },
        { status: 500 },
      );
    }

    const nowIso = new Date().toISOString();
    const shopifyFulfillmentId = result.fulfillmentCreate.fulfillment?.id ?? null;
    // Shopify is fulfilled now. If the ERP can't record it, say so loudly
    // instead of leaving the order stuck at Label Printed without a word.
    const statusWrite = await supabaseAdmin
      .from("order_status")
      .upsert(
        { shopify_order_id: orderId, status: "fulfilled", updated_at: nowIso },
        { onConflict: "shopify_order_id" },
      );
    const logWrite = await supabaseAdmin
      .from("fulfillment_log")
      .update({ fulfilled_at: nowIso, ...(shopifyFulfillmentId ? { shopify_fulfillment_id: shopifyFulfillmentId } : {}) })
      .eq("shopify_order_id", orderId)
      .is("fulfilled_at", null);
    if (statusWrite.error || logWrite.error) {
      const why = statusWrite.error?.message ?? logWrite.error?.message;
      console.error(`[mark-fulfilled] Shopify fulfilled order ${orderId} (${shopifyFulfillmentId}) but the ERP update failed: ${why}`);
      return NextResponse.json(
        { error: `Shopify marked this order fulfilled, but the ERP could not record it: ${why}. Do not click Mark Fulfilled again; ask for the status to be fixed.` },
        { status: 500 },
      );
    }

    // Free the staging box. Never fails the fulfillment: if this errors, the
    // reconcile on the Pick List / Shipping Assignments load releases it.
    try {
      const release = await supabaseAdmin.rpc("release_assignment_on_fulfilled", { p_order_id: orderId });
      if (release.error) {
        console.error(`[mark-fulfilled] Box release failed for order ${orderId}: ${release.error.message}`);
      }
    } catch (releaseError) {
      console.error(`[mark-fulfilled] Box release failed for order ${orderId}:`, releaseError);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
