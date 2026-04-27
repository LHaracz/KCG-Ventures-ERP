import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  adjustShopifyInventoryQuantity,
  syncShopifyAvailableQuantity,
} from "@/lib/shopifyInventorySync";

export type InventoryRow = {
  id: string;
  product_id: string | null;
  product_name: string;
  shopify_variant_id: string;
  shopify_inventory_item_id: string;
  shopify_location_id: string;
  qty_on_hand: number;
  reserved_qty: number;
  available_qty: number;
  updated_at: string;
};

type InventoryChangeReason = "production" | "order";

type InventoryMutationResult = {
  row: InventoryRow;
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

async function syncShopifyDelta(row: InventoryRow, previousAvailableQty: number): Promise<{
  ok: boolean;
  error?: string;
}> {
  const delta = row.available_qty - previousAvailableQty;
  if (delta === 0) return { ok: true };

  try {
    const syncResult = await adjustShopifyInventoryQuantity({
      delta,
      inventoryItemId: row.shopify_inventory_item_id,
      locationId: row.shopify_location_id,
    });
    if (!syncResult.ok) {
      const message =
        syncResult.userErrors?.map((error) => error.message).join("; ") ||
        "Unknown Shopify user error";
      return { ok: false, error: message };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown Shopify sync failure" };
  }
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

  const currentQtyOnHand = Number(existing.qty_on_hand);
  const reservedQty = Number(existing.reserved_qty ?? 0);
  const previousAvailableQty = Number(existing.available_qty ?? computeAvailableQty(currentQtyOnHand, reservedQty));
  const nextQtyOnHand = currentQtyOnHand + safeDelta;

  if (nextQtyOnHand < 0) {
    throw new Error("Quantity on hand cannot go below zero.");
  }

  const nextAvailableQty = computeAvailableQty(nextQtyOnHand, reservedQty);
  const nowIso = new Date().toISOString();

  const { data: updated, error: updateError } = await admin
    .from("inventory")
    .update({
      qty_on_hand: nextQtyOnHand,
      available_qty: nextAvailableQty,
      updated_at: nowIso,
    })
    .eq("id", productId)
    .select("*")
    .single();

  if (updateError || !updated) {
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

  const row = updated as InventoryRow;
  const shopifySync = await syncShopifyDelta(row, previousAvailableQty);

  if (!shopifySync.ok) {
    console.error(`Shopify mirror sync failed for inventory row ${row.id}: ${shopifySync.error}`);
  }

  return {
    row,
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

  const availableQty = Number(
    row.available_qty ?? computeAvailableQty(Number(row.qty_on_hand), Number(row.reserved_qty ?? 0)),
  );
  const result = await syncShopifyAvailableQuantity({
    targetAvailableQty: availableQty,
    inventoryItemId: String(row.shopify_inventory_item_id),
    locationId: String(row.shopify_location_id),
  });
  if (!result.ok) {
    const message = result.userErrors?.map((error) => error.message).join("; ") || "Unknown Shopify user error";
    throw new Error(message);
  }
}

export async function syncAllInventoryToShopify(): Promise<{
  synced: number;
  failed: Array<{ productId: string; error: string }>;
}> {
  const rows = await getInventory();
  const failed: Array<{ productId: string; error: string }> = [];
  let synced = 0;

  for (const row of rows) {
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

  return { synced, failed };
}
