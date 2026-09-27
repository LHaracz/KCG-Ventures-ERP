/**
 * Shared "finished-goods on-hand quantity" helpers for BotanIQals products.
 * Used by three call sites: the Sales Data import (decrement, server-side
 * via supabaseAdmin), BotanIQals production cycle completion (increment,
 * client-side via the browser supabase client), and the manual Cycle Count
 * feature (adjustment, also client-side). `supabase` is loosely typed
 * (matches the existing convention in rawMaterialDeduction.ts) so the same
 * helpers work with either client.
 *
 * MiniLeaf/microgreens are out of scope for this table entirely — callers
 * are responsible for only calling these helpers for BotanIQals
 * (products.is_microgreen = false) products.
 */

// Simple, fixed low-stock line for now — a configurable per-product
// threshold comes later with the demand calibration feature.
export const LOW_STOCK_THRESHOLD = 5;

export type InventoryTransactionType =
  | "sale_decrease"
  | "production_increase"
  | "cycle_count_adjustment";

export type InventoryReferenceType = "order" | "production_cycle" | "manual";

export type InventoryRow = { id: string; on_hand_qty: number };
export type InventoryRowCache = Map<string, InventoryRow>;

/** Loads every existing finished_products_inventory row into a fresh cache. */
export async function preloadInventoryCache(supabase: any): Promise<InventoryRowCache> {
  const cache: InventoryRowCache = new Map();
  const { data, error } = await supabase
    .from("finished_products_inventory")
    .select("id, product_id, on_hand_qty");
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    cache.set(row.product_id, { id: row.id, on_hand_qty: Number(row.on_hand_qty) || 0 });
  }
  return cache;
}

/**
 * Returns the product's finished_products_inventory row, lazily creating
 * one at on_hand_qty: 0 on first touch (backfilled in bulk by the
 * migration for existing products, but a product created afterward won't
 * have a row until something here touches it).
 */
export async function getOrCreateInventoryRow(
  supabase: any,
  productId: string,
  cache: InventoryRowCache,
): Promise<InventoryRow> {
  const cached = cache.get(productId);
  if (cached) return cached;

  const { data: existing, error: selectError } = await supabase
    .from("finished_products_inventory")
    .select("id, on_hand_qty")
    .eq("product_id", productId)
    .maybeSingle();
  if (selectError) throw new Error(selectError.message);

  if (existing) {
    const row: InventoryRow = { id: existing.id, on_hand_qty: Number(existing.on_hand_qty) || 0 };
    cache.set(productId, row);
    return row;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("finished_products_inventory")
    .insert({ product_id: productId, on_hand_qty: 0 })
    .select("id, on_hand_qty")
    .single();

  if (insertError) {
    // Unique-violation race (another call created it between our select and
    // insert) — fall back to reading the row that now exists.
    const { data: raceRow, error: raceError } = await supabase
      .from("finished_products_inventory")
      .select("id, on_hand_qty")
      .eq("product_id", productId)
      .single();
    if (raceError) throw new Error(insertError.message);
    const row: InventoryRow = { id: raceRow.id, on_hand_qty: Number(raceRow.on_hand_qty) || 0 };
    cache.set(productId, row);
    return row;
  }

  const row: InventoryRow = { id: inserted.id, on_hand_qty: Number(inserted.on_hand_qty) || 0 };
  cache.set(productId, row);
  return row;
}

/**
 * Records one inventory_transactions row and applies its delta to
 * finished_products_inventory.on_hand_qty, keeping `cache` in sync so a
 * caller processing many transactions in a row (e.g. one sales import run)
 * sees each product's running total correctly without re-querying.
 * Returns the new on_hand_qty.
 */
export async function recordInventoryTransaction(
  supabase: any,
  params: {
    productId: string;
    type: InventoryTransactionType;
    quantityDelta: number;
    referenceType: InventoryReferenceType | null;
    referenceId: string | null;
    note?: string | null;
    createdBy?: string | null;
    cache: InventoryRowCache;
  },
): Promise<number> {
  const { productId, type, quantityDelta, referenceType, referenceId, note, createdBy, cache } = params;

  const row = await getOrCreateInventoryRow(supabase, productId, cache);
  const newQty = row.on_hand_qty + quantityDelta;

  const { error: insertError } = await supabase.from("inventory_transactions").insert({
    product_id: productId,
    type,
    quantity_delta: quantityDelta,
    resulting_qty: newQty,
    reference_type: referenceType,
    reference_id: referenceId,
    note: note ?? null,
    created_by: createdBy ?? null,
  });
  if (insertError) throw new Error(insertError.message);

  const { error: updateError } = await supabase
    .from("finished_products_inventory")
    .update({ on_hand_qty: newQty, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (updateError) throw new Error(updateError.message);

  cache.set(productId, { id: row.id, on_hand_qty: newQty });
  return newQty;
}
