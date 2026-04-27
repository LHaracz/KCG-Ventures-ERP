import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  syncShopifyAvailableQuantity,
} from "@/lib/shopifyInventorySync";

export type InventoryRow = {
  id: string;
  product_id: string | null;
  product_name: string;
  shopify_variant_id: string;
  shopify_inventory_item_id: string;
  shopify_location_id: string;
  units_per_variant: number;
  qty_on_hand: number;
  reserved_qty: number;
  available_qty: number;
  updated_at: string;
};

type InventoryChangeReason = "production" | "order";

type InventoryMutationResult = {
  row: InventoryRow;
  groupRows: InventoryRow[];
  shopifySyncOk: boolean;
  shopifySyncError?: string;
};

function requireAdminClient() {
  if (!supabaseAdmin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return supabaseAdmin;
}

function toSafeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Quantity must be a finite number.");
  }
  if (!Number.isInteger(value)) {
    throw new Error("Quantity must be an integer.");
  }
  return value;
}

function computeAvailableQty(qtyOnHand: number, reservedQty: number): number {
  return qtyOnHand - reservedQty;
}

function hasRealShopifyMapping(row: Pick<InventoryRow, "shopify_variant_id" | "shopify_inventory_item_id" | "shopify_location_id">): boolean {
  const variantId = String(row.shopify_variant_id ?? "");
  const inventoryItemId = String(row.shopify_inventory_item_id ?? "");
  const locationId = String(row.shopify_location_id ?? "");
  return (
    !!variantId &&
    !!inventoryItemId &&
    !!locationId &&
    !variantId.startsWith("UNMAPPED_") &&
    !variantId.startsWith("MISSING_") &&
    !inventoryItemId.startsWith("UNMAPPED_") &&
    !inventoryItemId.startsWith("MISSING_") &&
    !locationId.startsWith("UNMAPPED_") &&
    !locationId.startsWith("MISSING_")
  );
}

async function syncShopifyGroupToAvailableQty(groupRows: InventoryRow[]): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (groupRows.length === 0) {
    return { ok: true };
  }

  const first = groupRows[0];
  const targetAvailableQty = first.available_qty;
  const syncableRows = groupRows.filter(hasRealShopifyMapping);
  // #region agent log
  fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
    body: JSON.stringify({
      sessionId: "ea9524",
      runId: "manual-sync-debug",
      hypothesisId: "H2",
      location: "src/lib/inventorySync.ts:80",
      message: "sync group rows prepared",
      data: {
        productId: first.product_id,
        groupSize: groupRows.length,
        syncableSize: syncableRows.length,
        targetAvailableQty,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (syncableRows.length === 0) {
    return { ok: false, error: "No valid Shopify mapping rows found for this product group." };
  }

  for (const row of syncableRows) {
    try {
      const syncResult = await syncShopifyAvailableQuantity({
        targetAvailableQty,
        inventoryItemId: String(row.shopify_inventory_item_id),
        locationId: String(row.shopify_location_id),
      });
      if (!syncResult.ok) {
        const message =
          syncResult.userErrors?.map((error) => error.message).join("; ") ||
          "Unknown Shopify user error";
        // #region agent log
        fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
          body: JSON.stringify({
            sessionId: "ea9524",
            runId: "manual-sync-debug",
            hypothesisId: "H3",
            location: "src/lib/inventorySync.ts:107",
            message: "sync result user error",
            data: { productId: row.product_id, variantId: row.shopify_variant_id, message },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
        return { ok: false, error: message };
      }
    } catch (error) {
      // #region agent log
      fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
        body: JSON.stringify({
          sessionId: "ea9524",
          runId: "manual-sync-debug",
          hypothesisId: "H3",
          location: "src/lib/inventorySync.ts:122",
          message: "sync group exception",
          data: {
            productId: row.product_id,
            variantId: row.shopify_variant_id,
            error: error instanceof Error ? error.message : "Unknown",
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Shopify sync failure",
      };
    }
  }

  return { ok: true };
}

async function loadInventoryGroupByProductId(productId: string): Promise<InventoryRow[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from("inventory")
    .select("*")
    .eq("product_id", productId)
    .order("product_name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as InventoryRow[];
  if (rows.length === 0) {
    throw new Error(`Inventory product group ${productId} not found.`);
  }
  return rows;
}

async function mutateInventory(
  productId: string,
  qtyDelta: number,
  reason: InventoryChangeReason,
): Promise<InventoryMutationResult> {
  const admin = requireAdminClient();
  const safeDelta = toSafeInteger(qtyDelta);

  const { data: existing, error: fetchError } = await admin
    .from("inventory")
    .select("*")
    .eq("id", productId)
    .single();

  if (fetchError || !existing) {
    throw new Error(fetchError?.message || `Inventory product ${productId} not found.`);
  }

  const existingRow = existing as InventoryRow;
  const productGroupId = existingRow.product_id;
  if (!productGroupId) {
    throw new Error(`Inventory row ${productId} is missing product_id.`);
  }

  const groupRows = await loadInventoryGroupByProductId(productGroupId);
  const groupAnchor = groupRows[0];

  const currentQtyOnHand = Number(groupAnchor.qty_on_hand);
  const reservedQty = Number(groupAnchor.reserved_qty ?? 0);
  const nextQtyOnHand = currentQtyOnHand + safeDelta;

  if (nextQtyOnHand < 0) {
    throw new Error("Quantity on hand cannot go below zero.");
  }

  const nextAvailableQty = computeAvailableQty(nextQtyOnHand, reservedQty);
  const nowIso = new Date().toISOString();

  const rowIds = groupRows.map((row) => row.id);
  const { data: updatedRows, error: updateError } = await admin
    .from("inventory")
    .update({
      qty_on_hand: nextQtyOnHand,
      available_qty: nextAvailableQty,
      updated_at: nowIso,
    })
    .in("id", rowIds)
    .select("*");

  if (updateError || !updatedRows?.length) {
    throw new Error(updateError?.message || `Failed to update inventory row ${productId}.`);
  }

  const { error: logError } = await admin.from("inventory_logs").insert({
    product_id: productId,
    change: safeDelta,
    reason,
    created_at: nowIso,
  });

  if (logError) {
    throw new Error(logError.message);
  }

  const updatedGroupRows = (updatedRows ?? []) as InventoryRow[];
  const row = updatedGroupRows.find((item) => item.id === productId) ?? updatedGroupRows[0];
  const shopifySync = await syncShopifyGroupToAvailableQty(updatedGroupRows);

  if (!shopifySync.ok) {
    console.error(`Shopify mirror sync failed for product group ${productGroupId}: ${shopifySync.error}`);
  }

  return {
    row,
    groupRows: updatedGroupRows,
    shopifySyncOk: shopifySync.ok,
    shopifySyncError: shopifySync.error,
  };
}

export async function addInventory(productId: string, qty: number): Promise<InventoryMutationResult> {
  const safeQty = toSafeInteger(qty);
  if (safeQty <= 0) {
    throw new Error("addInventory requires a positive quantity.");
  }
  return mutateInventory(productId, safeQty, "production");
}

export async function subtractInventory(productId: string, qty: number): Promise<InventoryMutationResult> {
  const safeQty = toSafeInteger(qty);
  if (safeQty <= 0) {
    throw new Error("subtractInventory requires a positive quantity.");
  }
  return mutateInventory(productId, -safeQty, "order");
}

export async function getInventory(): Promise<InventoryRow[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from("inventory")
    .select("*")
    .order("product_name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as InventoryRow[];
}

export async function syncInventoryRowToShopify(productId: string): Promise<void> {
  const admin = requireAdminClient();
  const { data: row, error } = await admin
    .from("inventory")
    .select("*")
    .eq("id", productId)
    .single();

  if (error || !row) {
    throw new Error(error?.message || `Inventory product ${productId} not found.`);
  }

  const typedRow = row as InventoryRow;
  if (!typedRow.product_id) {
    throw new Error(`Inventory row ${productId} is missing product_id.`);
  }

  const groupRows = await loadInventoryGroupByProductId(typedRow.product_id);
  const result = await syncShopifyGroupToAvailableQty(groupRows);
  if (!result.ok) {
    throw new Error(result.error || "Unknown Shopify sync failure");
  }
}

export async function syncAllInventoryToShopify(): Promise<{
  synced: number;
  failed: Array<{ productId: string; error: string }>;
}> {
  const rows = await getInventory();
  const failed: Array<{ productId: string; error: string }> = [];
  let synced = 0;
  const seenProductIds = new Set<string>();

  for (const row of rows) {
    if (!row.product_id || seenProductIds.has(row.product_id)) {
      continue;
    }
    seenProductIds.add(row.product_id);
    try {
      await syncInventoryRowToShopify(row.id);
      synced += 1;
    } catch (error) {
      failed.push({
        productId: row.id,
        error: error instanceof Error ? error.message : "Unknown sync failure",
      });
    }
  }

  // #region agent log
  fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
    body: JSON.stringify({
      sessionId: "ea9524",
      runId: "manual-sync-debug",
      hypothesisId: "H2",
      location: "src/lib/inventorySync.ts:336",
      message: "sync all completed",
      data: { totalRows: rows.length, productGroups: seenProductIds.size, synced, failed },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return { synced, failed };
}
