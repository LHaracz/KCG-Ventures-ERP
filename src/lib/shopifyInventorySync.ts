type InventoryAdjustmentChange = {
  delta: number;
  inventoryItemId: string;
  locationId: string;
};

type ShopifyInventorySyncResult = {
  ok: boolean;
  userErrors?: Array<{ field?: string[] | null; message: string }>;
};

const DEFAULT_SHOPIFY_API_VERSION = "2024-10";

function toInventoryItemGid(value: string): string {
  if (value.startsWith("gid://")) return value;
  return `gid://shopify/InventoryItem/${value}`;
}

function toLocationGid(value: string): string {
  if (value.startsWith("gid://")) return value;
  return `gid://shopify/Location/${value}`;
}

function getShopifyConfig() {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN ?? "";
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN ?? process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "";
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? DEFAULT_SHOPIFY_API_VERSION;
  // #region agent log
  fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
    body: JSON.stringify({
      sessionId: "ea9524",
      runId: "manual-sync-debug",
      hypothesisId: "H4",
      location: "src/lib/shopifyInventorySync.ts:30",
      message: "shopify config check",
      data: {
        hasShopDomain: !!shopDomain,
        hasAccessToken: !!accessToken,
        apiVersion,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  if (!shopDomain || !accessToken) {
    throw new Error(
      "Missing Shopify configuration: SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN (or SHOPIFY_ADMIN_ACCESS_TOKEN).",
    );
  }

  const normalizedDomain = shopDomain.includes(".myshopify.com")
    ? shopDomain
    : `${shopDomain}.myshopify.com`;

  return {
    endpoint: `https://${normalizedDomain}/admin/api/${apiVersion}/graphql.json`,
    accessToken,
  };
}

export async function adjustShopifyInventoryQuantity(
  change: InventoryAdjustmentChange,
): Promise<ShopifyInventorySyncResult> {
  const { endpoint, accessToken } = getShopifyConfig();

  const query = `
    mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  const payload = {
    query,
    variables: {
      input: {
        reason: "correction",
        name: "available",
        changes: [
          {
            delta: change.delta,
            inventoryItemId: toInventoryItemGid(change.inventoryItemId),
            locationId: toLocationGid(change.locationId),
          },
        ],
      },
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Shopify inventory sync failed (${response.status}): ${bodyText}`);
  }

  const body = (await response.json()) as {
    data?: {
      inventoryAdjustQuantities?: {
        userErrors?: Array<{ field?: string[] | null; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }

  const userErrors = body.data?.inventoryAdjustQuantities?.userErrors ?? [];
  return { ok: userErrors.length === 0, userErrors };
}

async function getShopifyAvailableQuantity(
  inventoryItemId: string,
  locationId: string,
): Promise<number> {
  const { endpoint, accessToken } = getShopifyConfig();

  const query = `
    query InventoryAvailable($inventoryItemId: ID!, $locationId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            quantity
          }
        }
      }
    }
  `;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query,
      variables: {
        inventoryItemId: toInventoryItemGid(inventoryItemId),
        locationId: toLocationGid(locationId),
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    // #region agent log
    fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
      body: JSON.stringify({
        sessionId: "ea9524",
        runId: "manual-sync-debug",
        hypothesisId: "H5",
        location: "src/lib/shopifyInventorySync.ts:170",
        message: "inventory level request failed",
        data: { inventoryItemId, locationId, status: response.status, bodyText },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    throw new Error(`Failed to fetch Shopify inventory level (${response.status}): ${bodyText}`);
  }

  const body = (await response.json()) as {
    data?: {
      inventoryItem?: {
        inventoryLevel?: {
          quantities?: Array<{ quantity?: number | null }>;
        } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    // #region agent log
    fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
      body: JSON.stringify({
        sessionId: "ea9524",
        runId: "manual-sync-debug",
        hypothesisId: "H5",
        location: "src/lib/shopifyInventorySync.ts:188",
        message: "inventory level graphql errors",
        data: { inventoryItemId, locationId, errors: body.errors },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }

  const available = body.data?.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity;
  return Number(available ?? 0);
}

export async function syncShopifyAvailableQuantity(params: {
  inventoryItemId: string;
  locationId: string;
  targetAvailableQty: number;
}): Promise<{ ok: boolean; delta: number; userErrors?: Array<{ field?: string[] | null; message: string }> }> {
  const currentAvailableQty = await getShopifyAvailableQuantity(params.inventoryItemId, params.locationId);
  const delta = Math.trunc(params.targetAvailableQty - currentAvailableQty);
  if (delta === 0) {
    return { ok: true, delta: 0 };
  }

  const result = await adjustShopifyInventoryQuantity({
    delta,
    inventoryItemId: params.inventoryItemId,
    locationId: params.locationId,
  });
  return { ok: result.ok, delta, userErrors: result.userErrors };
}
