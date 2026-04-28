/**
 * Normalize a Shopify ProductVariant id to the numeric REST id string.
 * Accepts REST numeric strings or Admin GraphQL GIDs.
 */
export function normalizeShopifyVariantId(raw: string | number | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) {
    return "";
  }
  const gid = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/i.exec(s);
  if (gid) {
    return gid[1];
  }
  if (/^\d+$/.test(s)) {
    return s;
  }
  return s;
}

/** All `inventory.shopify_variant_id` shapes to try when matching a webhook line item. */
export function shopifyVariantIdLookupKeys(raw: string | number | null | undefined): string[] {
  const s = String(raw ?? "").trim();
  const keys = new Set<string>();
  if (!s) {
    return [];
  }
  keys.add(s);
  const numeric = normalizeShopifyVariantId(s);
  if (numeric && /^\d+$/.test(numeric)) {
    keys.add(numeric);
    keys.add(`gid://shopify/ProductVariant/${numeric}`);
  }
  return [...keys];
}
