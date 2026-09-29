import { shopifyAdminGraphQL, toOrderGid } from "@/lib/shopifyAdmin";

/**
 * Shared "live shipping address" fetch for the Fulfillments feature.
 * Extracted out of src/app/api/fulfillments/[orderId]/route.ts's GET
 * handler (which still uses this for its own response) so the address
 * verification routes/webhook reuse the exact same GraphQL query and
 * field-normalization instead of a second/third copy of it.
 */

export type CanonicalAddress = {
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
};

type RawShippingAddress = {
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
};

type ShippingAddressQueryResponse = {
  order: {
    shippingAddress: RawShippingAddress | null;
  } | null;
};

const SHIPPING_ADDRESS_QUERY = `
  query FulfillmentOrderShippingAddress($id: ID!) {
    order(id: $id) {
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
  }
`;

export function normalizeShippingAddress(address: RawShippingAddress | null): CanonicalAddress | null {
  if (!address) return null;
  return {
    name: [address.firstName, address.lastName].filter(Boolean).join(" ") || "",
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.provinceCode || address.province,
    zip: address.zip,
    country: address.countryCodeV2 || address.country,
    phone: address.phone,
  };
}

// Live-fetches just the shipping address for one order (a lighter query
// than the full order-detail fetch route.ts GET also does). Returns null
// if the order doesn't exist or has no shipping address (local pickup,
// digital orders, etc).
export async function fetchLiveShippingAddress(orderId: string): Promise<CanonicalAddress | null> {
  const data = await shopifyAdminGraphQL<ShippingAddressQueryResponse>(SHIPPING_ADDRESS_QUERY, {
    id: toOrderGid(orderId),
  });
  return normalizeShippingAddress(data.order?.shippingAddress ?? null);
}
