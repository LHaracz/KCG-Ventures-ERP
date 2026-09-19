/**
 * Shared "raw materials for a BotanIQals cycle" deduction / undo logic.
 *
 * Used by both the "Mark as Produced" action (deducts raw materials early, while
 * the cycle stays Draft/Planned) and "Complete Production" (which still deducts on
 * its own for cycles that skip straight to completion). `production_cycles
 * .raw_materials_deducted_at` is the single source of truth for whether a given
 * cycle's raw materials have already been pulled — both callers gate on it, and the
 * claim/release updates below are written so a race (double click, or completing a
 * cycle that's mid-deduction) can only ever result in one deduction.
 */

export type RequiredByItem = Map<string, number>;

/** BOM (inventory_item / packaging lines) × planned target quantity, per inventory item. */
export function computeRequiredRawMaterials(
  cycleTargets: any[],
  bomLines: any[],
): RequiredByItem {
  const bomByProduct = new Map<string, any[]>();
  for (const line of bomLines) {
    if (!line.inventory_item) continue;
    if (line.line_type !== "inventory_item" && line.line_type !== "packaging") {
      continue;
    }
    const existing = bomByProduct.get(line.product) || [];
    existing.push(line);
    bomByProduct.set(line.product, existing);
  }

  const requiredByItem: RequiredByItem = new Map();
  for (const target of cycleTargets) {
    const qty = Number(target.quantity_to_produce ?? target.target_units ?? 0) || 0;
    if (qty <= 0) continue;
    const lines = bomByProduct.get(target.product) || [];
    for (const line of lines) {
      const lineQty = qty * Number(line.qty_per_unit || 0);
      if (!Number.isFinite(lineQty) || lineQty <= 0) continue;
      requiredByItem.set(
        line.inventory_item,
        (requiredByItem.get(line.inventory_item) || 0) + lineQty,
      );
    }
  }
  return requiredByItem;
}

export type DeductResult =
  | { ok: true; deducted: true }
  | { ok: true; deducted: false } // someone/something else already claimed it
  | { ok: false; reason: "declined" }; // user declined the shortage confirm

/**
 * Deducts raw materials for a cycle's current targets, guarded so it can only ever
 * happen once per cycle. Safe to call from "Mark as Produced" or from "Complete
 * Production" — pass the same `cycle` row (must include at least `id`).
 */
export async function deductRawMaterialsForCycle(params: {
  supabase: any;
  user: { id: string };
  cycle: { id: string };
  cycleTargets: any[];
  noteLabel: string; // e.g. "production" or "completion" — for the human-readable note only
}): Promise<DeductResult> {
  const { supabase, user, cycle, cycleTargets, noteLabel } = params;

  const productIds = Array.from(
    new Set(cycleTargets.map((t: any) => t.product).filter(Boolean)),
  );

  if (!productIds.length) {
    return { ok: true, deducted: false };
  }

  const [{ data: bomRows, error: bomErr }, { data: itemRows, error: itemsErr }] =
    await Promise.all([
      supabase
        .from("bom_lines")
        .select("id, product, line_type, inventory_item, qty_per_unit, unit_label")
        .in("product", productIds),
      supabase.from("inventory_items").select("id, name, unit, quantity_on_hand"),
    ]);
  if (bomErr) throw bomErr;
  if (itemsErr) throw itemsErr;

  const requiredByItem = computeRequiredRawMaterials(cycleTargets, bomRows || []);
  if (!requiredByItem.size) {
    // Nothing to deduct (no BOM lines) — still claim, so this cycle is marked done.
  }

  const itemsById = new Map<string, any>((itemRows || []).map((item: any) => [item.id, item]));

  const shortages = Array.from(requiredByItem.entries())
    .map(([itemId, required]) => {
      const item = itemsById.get(itemId);
      if (!item) return null;
      const onHand = Number(item.quantity_on_hand || 0);
      return { itemId, name: item.name, unit: item.unit, required, onHand, shortage: required - onHand };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .filter((row) => row.shortage > 0);

  if (shortages.length && typeof window !== "undefined") {
    const preview = shortages
      .slice(0, 5)
      .map(
        (s) =>
          `- ${s.name}: short ${s.shortage.toFixed(2)} ${s.unit} (need ${s.required.toFixed(2)}, on hand ${s.onHand.toFixed(2)})`,
      )
      .join("\n");
    const extraCount = shortages.length > 5 ? `\n...and ${shortages.length - 5} more` : "";
    const confirmed = window.confirm(
      `Inventory shortages were detected for this ${noteLabel}:\n\n${preview}${extraCount}\n\nContinue anyway? This will allow negative inventory balances.`,
    );
    if (!confirmed) {
      return { ok: false, reason: "declined" };
    }
  }

  // Claim: only proceeds if nobody has deducted for this cycle yet.
  const { data: claimedRows, error: claimErr } = await supabase
    .from("production_cycles")
    .update({ raw_materials_deducted_at: new Date().toISOString() })
    .eq("id", cycle.id)
    .is("raw_materials_deducted_at", null)
    .select("id");
  if (claimErr) throw claimErr;
  if (!claimedRows || claimedRows.length === 0) {
    // Already deducted (by an earlier click, or the other page) — nothing to do.
    return { ok: true, deducted: false };
  }

  if (requiredByItem.size) {
    const adjustmentInserts = Array.from(requiredByItem.entries())
      .map(([itemId, required]) => {
        const item = itemsById.get(itemId);
        if (!item) return null;
        return {
          inventory_item: itemId,
          production_cycle_id: cycle.id,
          adjustment_type: "usage",
          quantity_delta: -required,
          note: `Auto-deduct on ${noteLabel} for cycle ${cycle.id}: ${required.toFixed(2)} ${item.unit}`,
          created_at: new Date().toISOString(),
          user_id: user.id,
        };
      })
      .filter(Boolean);

    if (adjustmentInserts.length) {
      const { error: adjInsertErr } = await supabase
        .from("inventory_adjustments")
        .insert(adjustmentInserts);
      if (adjInsertErr) throw adjInsertErr;
    }

    await Promise.all(
      Array.from(requiredByItem.entries()).map(async ([itemId, required]) => {
        const item = itemsById.get(itemId);
        if (!item) return;
        const nextOnHand = Number(item.quantity_on_hand || 0) - required;
        const { error: itemUpdateErr } = await supabase
          .from("inventory_items")
          .update({ quantity_on_hand: nextOnHand })
          .eq("id", itemId);
        if (itemUpdateErr) throw itemUpdateErr;
      }),
    );
  }

  return { ok: true, deducted: true };
}

export type UndoResult = { ok: true; undone: true } | { ok: true; undone: false };

/**
 * Reverses a previous deduction: adds the deducted quantities back to inventory
 * and records a compensating adjustment per item, then releases the claim so
 * "Mark as Produced" can be pressed again. No-ops if the cycle was never deducted,
 * already undone, or already completed (matches the DB-level guard).
 */
export async function undoRawMaterialDeductionForCycle(params: {
  supabase: any;
  user: { id: string };
  cycle: { id: string };
}): Promise<UndoResult> {
  const { supabase, user, cycle } = params;

  const { data: releasedRows, error: releaseErr } = await supabase
    .from("production_cycles")
    .update({ raw_materials_deducted_at: null })
    .eq("id", cycle.id)
    .not("raw_materials_deducted_at", "is", null)
    .neq("status", "completed")
    .select("id");
  if (releaseErr) throw releaseErr;
  if (!releasedRows || releasedRows.length === 0) {
    return { ok: true, undone: false };
  }

  const { data: deductionRows, error: fetchErr } = await supabase
    .from("inventory_adjustments")
    .select("inventory_item, quantity_delta")
    .eq("production_cycle_id", cycle.id)
    .eq("adjustment_type", "usage");
  if (fetchErr) throw fetchErr;

  const toRestoreByItem = new Map<string, number>();
  for (const row of deductionRows || []) {
    const delta = Number(row.quantity_delta || 0);
    if (delta >= 0) continue; // only reverse actual deductions
    const restore = -delta;
    toRestoreByItem.set(
      row.inventory_item,
      (toRestoreByItem.get(row.inventory_item) || 0) + restore,
    );
  }

  if (!toRestoreByItem.size) {
    return { ok: true, undone: true };
  }

  const itemIds = Array.from(toRestoreByItem.keys());
  const { data: itemRows, error: itemsErr } = await supabase
    .from("inventory_items")
    .select("id, unit, quantity_on_hand")
    .in("id", itemIds);
  if (itemsErr) throw itemsErr;
  const itemsById = new Map<string, any>((itemRows || []).map((item: any) => [item.id, item]));

  const reversalInserts = Array.from(toRestoreByItem.entries())
    .map(([itemId, restore]) => {
      const item = itemsById.get(itemId);
      if (!item) return null;
      return {
        inventory_item: itemId,
        production_cycle_id: cycle.id,
        adjustment_type: "usage_reversal",
        quantity_delta: restore,
        note: `Undo raw material deduction for cycle ${cycle.id}: +${restore.toFixed(2)} ${item.unit}`,
        created_at: new Date().toISOString(),
        user_id: user.id,
      };
    })
    .filter(Boolean);

  if (reversalInserts.length) {
    const { error: reversalInsertErr } = await supabase
      .from("inventory_adjustments")
      .insert(reversalInserts);
    if (reversalInsertErr) throw reversalInsertErr;
  }

  await Promise.all(
    Array.from(toRestoreByItem.entries()).map(async ([itemId, restore]) => {
      const item = itemsById.get(itemId);
      if (!item) return;
      const nextOnHand = Number(item.quantity_on_hand || 0) + restore;
      const { error: itemUpdateErr } = await supabase
        .from("inventory_items")
        .update({ quantity_on_hand: nextOnHand })
        .eq("id", itemId);
      if (itemUpdateErr) throw itemUpdateErr;
    }),
  );

  return { ok: true, undone: true };
}
