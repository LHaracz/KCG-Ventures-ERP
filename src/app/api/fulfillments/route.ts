import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import {
  shopifyAdminGraphQL,
  weightToOz,
  orderGidToNumericId,
  toOrderGid,
} from "@/lib/shopifyAdmin";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { FulfillmentStatus } from "@/lib/fulfillmentStatus";

type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  customer: { firstName: string | null; lastName: string | null } | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  lineItems: {
    edges: Array<{
      node: {
        quantity: number;
        weight: { value: number; unit: string } | null;
      };
    }>;
  };
};

type OrdersQueryResponse = {
  orders: {
    edges: Array<{ node: OrderNode }>;
  };
};

type NodesQueryResponse = {
  nodes: Array<(OrderNode & { __typename?: string }) | null>;
};

const ORDER_FIELDS = `
  id
  name
  createdAt
  customer {
    firstName
    lastName
  }
  totalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }
  lineItems(first: 50) {
    edges {
      node {
        quantity
        weight {
          value
          unit
        }
      }
    }
  }
`;

const ORDERS_QUERY = `
  query UnfulfilledOrders($first: Int!) {
    orders(first: $first, query: "status:open fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: false) {
      edges {
        node {
          ${ORDER_FIELDS}
        }
      }
    }
  }
`;

const NODES_QUERY = `
  query RecentlyFulfilledOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Order {
        ${ORDER_FIELDS}
      }
    }
  }
`;

export type FulfillmentListRow = {
  orderId: string;
  name: string;
  createdAt: string;
  customerName: string;
  itemCount: number;
  totalProductWeightOz: number;
  totalPrice: number;
  currencyCode: string;
  status: FulfillmentStatus;
};

function mapOrderNode(node: OrderNode): Omit<FulfillmentListRow, "status"> {
  const lineItems = node.lineItems.edges.map((e) => e.node);
  const itemCount = lineItems.reduce((sum, li) => sum + (li.quantity || 0), 0);
  const totalProductWeightOz = lineItems.reduce(
    (sum, li) => sum + weightToOz(li.weight) * (li.quantity || 0),
    0,
  );
  const customerName = node.customer
    ? [node.customer.firstName, node.customer.lastName].filter(Boolean).join(" ")
    : "Guest";
  return {
    orderId: orderGidToNumericId(node.id),
    name: node.name,
    createdAt: node.createdAt,
    customerName: customerName || "Guest",
    itemCount,
    totalProductWeightOz,
    totalPrice: Number(node.totalPriceSet?.shopMoney.amount ?? 0),
    currencyCode: node.totalPriceSet?.shopMoney.currencyCode ?? "USD",
  };
}

/** Orders fulfilled in the last 14 days, so they stay visible for a bit
 * after Shopify stops returning them as unfulfilled. */
async function fetchRecentlyFulfilledOrders(): Promise<Omit<FulfillmentListRow, "status">[]> {
  if (!supabaseAdmin) return [];

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("fulfillment_log")
    .select("shopify_order_id, fulfilled_at")
    .not("fulfilled_at", "is", null)
    .gte("fulfilled_at", fourteenDaysAgo)
    .order("fulfilled_at", { ascending: false });

  if (error || !data || data.length === 0) return [];

  // One id per order — first occurrence is the most recent fulfillment.
  const orderIds = Array.from(new Set(data.map((row) => String(row.shopify_order_id))));
  if (orderIds.length === 0) return [];

  const ids = orderIds.map((id) => toOrderGid(id));
  const nodesData = await shopifyAdminGraphQL<NodesQueryResponse>(NODES_QUERY, { ids });

  return nodesData.nodes
    .filter((n): n is OrderNode & { __typename?: string } => !!n && n.__typename === "Order")
    .map(mapOrderNode);
}

async function fetchOrderStatuses(
  orderIds: string[],
): Promise<Map<string, FulfillmentStatus>> {
  const statusMap = new Map<string, FulfillmentStatus>();
  if (!supabaseAdmin || orderIds.length === 0) return statusMap;

  const { data, error } = await supabaseAdmin
    .from("order_status")
    .select("shopify_order_id, status")
    .in("shopify_order_id", orderIds);

  if (error || !data) return statusMap;
  for (const row of data) {
    statusMap.set(String(row.shopify_order_id), row.status as FulfillmentStatus);
  }
  return statusMap;
}

export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);

    const [liveData, recentlyFulfilled] = await Promise.all([
      shopifyAdminGraphQL<OrdersQueryResponse>(ORDERS_QUERY, { first: 50 }),
      fetchRecentlyFulfilledOrders(),
    ]);

    const liveRows = liveData.orders.edges.map(({ node }) => mapOrderNode(node));

    // Merge + dedupe by order id (live orders take precedence on overlap).
    const merged = new Map<string, Omit<FulfillmentListRow, "status">>();
    for (const row of recentlyFulfilled) merged.set(row.orderId, row);
    for (const row of liveRows) merged.set(row.orderId, row);

    const statusMap = await fetchOrderStatuses(Array.from(merged.keys()));

    const rows: FulfillmentListRow[] = Array.from(merged.values()).map((row) => ({
      ...row,
      status: statusMap.get(row.orderId) ?? "preparing_shipment",
    }));

    return NextResponse.json({ ok: true, orders: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
