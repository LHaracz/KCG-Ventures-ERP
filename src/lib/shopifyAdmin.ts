import { resolveShopifyAccessToken } from "@/lib/shopifyAccessToken";

/**
 * Shared Shopify Admin GraphQL client for the Fulfillments feature (and future
 * Part 2 mutations). Reuses the same cached-token helper already used by
 * inventory sync / the orders webhook rather than a second token cache.
 */

const DEFAULT_FULFILLMENTS_API_VERSION = "2026-07"; // LineItem.weight requires 2026-07+

function normalizeShopDomain(shopDomain: string): string {
  return shopDomain.includes(".myshopify.com")
    ? shopDomain
    : `${shopDomain}.myshopify.com`;
}

function shopDomainFromEnv(): string {
  return process.env.SHOPIFY_SHOP_DOMAIN ?? process.env.SHOPIFY_STORE_DOMAIN ?? "";
}

export class ShopifyAdminGraphQLError extends Error {
  constructor(
    message: string,
    public readonly graphQLErrors?: Array<{ message: string }>,
  ) {
    super(message);
    this.name = "ShopifyAdminGraphQLError";
  }
}

/**
 * Runs a Shopify Admin GraphQL query/mutation, resolving the shop domain, API
 * version, and access token the same way the rest of this app does.
 */
export async function shopifyAdminGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const shopDomain = shopDomainFromEnv();
  if (!shopDomain) {
    throw new Error(
      "Missing Shopify shop domain. Set SHOPIFY_SHOP_DOMAIN (or SHOPIFY_STORE_DOMAIN).",
    );
  }

  const { accessToken, tokenSource } = await resolveShopifyAccessToken();
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? DEFAULT_FULFILLMENTS_API_VERSION;
  const endpoint = `https://${normalizeShopDomain(shopDomain)}/admin/api/${apiVersion}/graphql.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Shopify Admin API request failed (${response.status}, tokenSource=${tokenSource}): ${bodyText}`,
    );
  }

  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new ShopifyAdminGraphQLError(
      `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
      body.errors,
    );
  }
  if (body.data === undefined) {
    throw new Error("Shopify GraphQL response missing data.");
  }
  return body.data;
}

export type ShopifyWeight = { value: number; unit: string } | null | undefined;

/** Converts a Shopify Weight object to ounces. */
export function weightToOz(weight: ShopifyWeight): number {
  if (!weight || !Number.isFinite(weight.value)) return 0;
  switch (weight.unit) {
    case "GRAMS":
      return weight.value * 0.0352739619;
    case "KILOGRAMS":
      return weight.value * 35.2739619;
    case "POUNDS":
      return weight.value * 16;
    case "OUNCES":
      return weight.value;
    default:
      return weight.value;
  }
}

/** Numeric Shopify order id -> GID, for building order(id: ...) query variables. */
export function toOrderGid(numericId: string): string {
  if (numericId.startsWith("gid://")) return numericId;
  return `gid://shopify/Order/${numericId}`;
}

/** Shopify order GID -> the numeric id used in this app's URLs. */
export function orderGidToNumericId(gid: string): string {
  const match = /^gid:\/\/shopify\/Order\/(\d+)$/i.exec(gid);
  return match ? match[1] : gid;
}
