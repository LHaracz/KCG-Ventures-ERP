import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { shopifyAdminGraphQL, weightToOz, toOrderGid } from "@/lib/shopifyAdmin";

type OrderQueryResponse = {
  order: {
    id: string;
    name: string;
    createdAt: string;
    email: string | null;
    phone: string | null;
    customer: {
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
    } | null;
    shippingAddress: {
      firstName: string | null;
      lastName: string | null;
      address1: string | null;
      address2: string | null;
      city: string | null;
      province: string | null;
      provinceCode: string | null;
      zip: string | null;
      country: string | null;
      countryCodeV2: string | null;
      phone: string | null;
    } | null;
    shippingLine: { title: string | null } | null;
    lineItems: {
      edges: Array<{
        node: {
          title: string;
          sku: string | null;
          quantity: number;
          weight: { value: number; unit: string } | null;
        };
      }>;
    };
  } | null;
};

const ORDER_QUERY = `
  query FulfillmentOrderDetail($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      email
      phone
      customer {
        firstName
        lastName
        email
        phone
      }
      shippingAddress {
        firstName
        lastName
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        phone
      }
      shippingLine {
        title
      }
      lineItems(first: 100) {
        edges {
          node {
            title
            sku
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
`;

export type FulfillmentOrderDetail = {
  orderId: string;
  name: string;
  createdAt: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  shippingAddress: {
    name: string;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
  } | null;
  shippingMethodTitle: string | null;
  lineItems: Array<{
    title: string;
    sku: string | null;
    quantity: number;
    unitWeightOz: number;
    extendedWeightOz: number;
  }>;
  totalProductWeightOz: number;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) {
      return NextResponse.json({ error: "Missing orderId." }, { status: 400 });
    }

    const data = await shopifyAdminGraphQL<OrderQueryResponse>(ORDER_QUERY, {
      id: toOrderGid(orderId.trim()),
    });

    if (!data.order) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }

    const order = data.order;
    const lineItems = order.lineItems.edges.map((e) => e.node);
    const detail: FulfillmentOrderDetail = {
      orderId,
      name: order.name,
      createdAt: order.createdAt,
      customerName: order.customer
        ? [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ") ||
          "Guest"
        : "Guest",
      customerEmail: order.customer?.email ?? order.email ?? null,
      customerPhone: order.customer?.phone ?? order.phone ?? null,
      shippingAddress: order.shippingAddress
        ? {
            name:
              [order.shippingAddress.firstName, order.shippingAddress.lastName]
                .filter(Boolean)
                .join(" ") || "",
            address1: order.shippingAddress.address1,
            address2: order.shippingAddress.address2,
            city: order.shippingAddress.city,
            province: order.shippingAddress.provinceCode || order.shippingAddress.province,
            zip: order.shippingAddress.zip,
            country: order.shippingAddress.countryCodeV2 || order.shippingAddress.country,
            phone: order.shippingAddress.phone,
          }
        : null,
      shippingMethodTitle: order.shippingLine?.title ?? null,
      lineItems: lineItems.map((li) => {
        const unitWeightOz = weightToOz(li.weight);
        return {
          title: li.title,
          sku: li.sku,
          quantity: li.quantity,
          unitWeightOz,
          extendedWeightOz: unitWeightOz * (li.quantity || 0),
        };
      }),
      totalProductWeightOz: lineItems.reduce(
        (sum, li) => sum + weightToOz(li.weight) * (li.quantity || 0),
        0,
      ),
    };

    return NextResponse.json({ ok: true, order: detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
