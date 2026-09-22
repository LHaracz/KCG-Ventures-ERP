import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { shopifyAdminGraphQL, weightToOz, orderGidToNumericId } from "@/lib/shopifyAdmin";

type OrdersQueryResponse = {
  orders: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        createdAt: string;
        customer: { firstName: string | null; lastName: string | null } | null;
        lineItems: {
          edges: Array<{
            node: {
              quantity: number;
              weight: { value: number; unit: string } | null;
            };
          }>;
        };
      };
    }>;
  };
};

const ORDERS_QUERY = `
  query UnfulfilledOrders($first: Int!) {
    orders(first: $first, query: "fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: false) {
      edges {
        node {
          id
          name
          createdAt
          customer {
            firstName
            lastName
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
        }
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
};

export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);

    const data = await shopifyAdminGraphQL<OrdersQueryResponse>(ORDERS_QUERY, {
      first: 50,
    });

    const rows: FulfillmentListRow[] = data.orders.edges.map(({ node }) => {
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
      };
    });

    return NextResponse.json({ ok: true, orders: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
