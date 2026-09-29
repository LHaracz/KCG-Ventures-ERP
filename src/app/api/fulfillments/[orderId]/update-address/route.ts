import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { shopifyAdminGraphQL, toOrderGid } from "@/lib/shopifyAdmin";
import { normalizeShippingAddress, type CanonicalAddress } from "@/lib/fulfillmentOrder";

/**
 * Direct Shopify write for the manual shipping-address edit on the order
 * detail page (replaces the old EasyPost accept/re-verify flow — see
 * supabase-migrations/order_status_manual_flagging.sql). Only the 6 fields
 * the spec calls out are editable; name/phone stay read-only.
 */

type UpdateAddressRequestBody = {
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
};

type OrderUpdateResponse = {
  orderUpdate: {
    order: {
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
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

const ORDER_UPDATE_MUTATION = `
  mutation UpdateOrderShippingAddress($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
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
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) {
      return NextResponse.json({ error: "Missing orderId." }, { status: 400 });
    }

    const body = (await request.json()) as UpdateAddressRequestBody;
    const address1 = body?.address1?.trim() ?? "";
    const city = body?.city?.trim() ?? "";
    const province = body?.province?.trim() ?? "";
    const zip = body?.zip?.trim() ?? "";
    const country = body?.country?.trim() ?? "";
    if (!address1 || !city || !province || !zip || !country) {
      return NextResponse.json(
        { error: "Street address, city, state, zip, and country are required." },
        { status: 400 },
      );
    }

    const result = await shopifyAdminGraphQL<OrderUpdateResponse>(ORDER_UPDATE_MUTATION, {
      input: {
        id: toOrderGid(orderId.trim()),
        shippingAddress: {
          address1,
          address2: body?.address2?.trim() || null,
          city,
          province,
          zip,
          country,
        },
      },
    });

    const userErrors = result.orderUpdate.userErrors;
    if (userErrors && userErrors.length > 0) {
      return NextResponse.json(
        { error: userErrors.map((e) => e.message).join("; ") },
        { status: 400 },
      );
    }

    const shippingAddress: CanonicalAddress | null = normalizeShippingAddress(
      result.orderUpdate.order?.shippingAddress ?? null,
    );

    return NextResponse.json({ ok: true, shippingAddress });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
