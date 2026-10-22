/**
 * Shared types + pure helpers for the Formulation feature (product
 * development, formula iterations, test batches). BotanIQals only.
 *
 * Products & BOM (products / bom_lines) stays the single source of truth
 * every other feature reads from — this module never reads bom_lines as
 * anything but the sync target for "Finish Iteration", and never
 * substitutes formulation_lines for it anywhere else in the app.
 */

export type FormulationProductRow = {
  id: string;
  name: string;
  product_id: string | null;
  status: "in_development" | "active";
  created_at: string;
  deleted_at: string | null;
  draft_unit: string | null;
  draft_sale_price_per_unit: number | null;
  draft_shelf_life_days: number | null;
  draft_target_batch_size: number | null;
  draft_target_batch_unit: string | null;
  draft_notes: string | null;
};

export type FormulationRow = {
  id: string;
  formulation_product_id: string;
  version_number: number;
  status: "draft" | "final";
  source: "new" | "baseline_import" | "restored_from_version";
  goal_notes: string | null;
  change_summary: string | null;
  created_at: string;
  finalized_at: string | null;
  created_by: string | null;
  finalized_by: string | null;
};

export type FormulationLineType = "inventory_item" | "packaging";

export type FormulationLineRow = {
  id: string;
  formulation_id: string;
  line_type: FormulationLineType;
  raw_material_id: string;
  qty_per_unit: number;
  reason: string | null;
  sort_order: number;
};

export type TestBatchRow = {
  id: string;
  formulation_id: string;
  batch_date: string;
  batch_size: string | null;
  observations: string | null;
  outcome: "pass" | "needs_changes" | "fail" | null;
  created_by: string | null;
  created_at: string;
};

export type InventoryItemLite = {
  id: string;
  name: string;
  unit: string;
  cost_per_unit: number;
};

export type BomLineLite = {
  id: string;
  product: string;
  line_type: string;
  inventory_item: string | null;
  qty_per_unit: number;
  unit_label: string;
  sale_price: number | null;
  material_name_snapshot: string | null;
  notes: string | null;
};

/** Draft-form shape for one formula line in the editor, before it's saved. */
export type FormulationLineDraft = {
  key: string; // stable client-side id for React lists, unrelated to DB id
  line_type: FormulationLineType;
  raw_material_id: string;
  qty_per_unit: number | "";
  reason: string;
};

export function emptyLineDraft(key: string, line_type: FormulationLineType = "inventory_item"): FormulationLineDraft {
  return { key, line_type, raw_material_id: "", qty_per_unit: "", reason: "" };
}

/** Next version number for a product's formulation history (max + 1, or 1 if none exist). */
export function nextVersionNumber(existing: { version_number: number }[]): number {
  if (!existing.length) return 1;
  return Math.max(...existing.map((f) => f.version_number)) + 1;
}

export function costPerUnitFor(itemId: string, items: InventoryItemLite[]): number {
  const item = items.find((i) => i.id === itemId);
  return item ? Number(item.cost_per_unit) || 0 : 0;
}

/** Total per-unit cost of a set of formula lines, using current inventory costs. */
export function computeFormulaCost(
  lines: { raw_material_id: string; qty_per_unit: number | "" }[],
  items: InventoryItemLite[],
): number {
  return lines.reduce((sum, line) => {
    const qty = Number(line.qty_per_unit) || 0;
    return sum + qty * costPerUnitFor(line.raw_material_id, items);
  }, 0);
}

export type MarginSummary = {
  cost: number;
  salePrice: number | null;
  margin: number | null;
  marginPct: number | null;
};

export function computeMargin(cost: number, salePrice: number | null): MarginSummary {
  if (salePrice == null || !Number.isFinite(salePrice)) {
    return { cost, salePrice: null, margin: null, marginPct: null };
  }
  const margin = salePrice - cost;
  const marginPct = salePrice > 0 ? (margin / salePrice) * 100 : null;
  return { cost, salePrice, margin, marginPct };
}

/**
 * Builds the write plan for "Finish Iteration": syncing a draft
 * formulation's lines into bom_lines for a specific product, in place.
 *
 * Matched by (line_type, inventory_item) against the product's current
 * bom_lines — a match is UPDATED (qty_per_unit, unit_label,
 * material_name_snapshot only, so notes/sale_price/anything else on that
 * row is left exactly as it was); an unmatched formulation line is
 * INSERTED as a new bom_lines row; an existing bom_lines row with no
 * matching formulation line is DELETED (the finished formula is the full
 * BOM going forward, not a patch on top of it).
 */
export function buildBomSyncPlan(
  productId: string,
  existingBomLines: BomLineLite[],
  formulationLines: { line_type: FormulationLineType; raw_material_id: string; qty_per_unit: number; reason: string | null }[],
  items: InventoryItemLite[],
  userId: string,
): {
  toInsert: Record<string, unknown>[];
  toUpdate: { id: string; payload: Record<string, unknown> }[];
  toDeleteIds: string[];
} {
  const existingByKey = new Map<string, BomLineLite>();
  for (const b of existingBomLines) {
    if (b.inventory_item) existingByKey.set(`${b.line_type}:${b.inventory_item}`, b);
  }
  const matchedIds = new Set<string>();
  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: { id: string; payload: Record<string, unknown> }[] = [];

  for (const line of formulationLines) {
    const item = items.find((i) => i.id === line.raw_material_id);
    const unitLabel = item?.unit ?? "";
    const key = `${line.line_type}:${line.raw_material_id}`;
    const existing = existingByKey.get(key);
    if (existing) {
      matchedIds.add(existing.id);
      toUpdate.push({
        id: existing.id,
        payload: {
          qty_per_unit: line.qty_per_unit,
          unit_label: unitLabel,
          material_name_snapshot: item?.name ?? existing.material_name_snapshot ?? null,
        },
      });
    } else {
      toInsert.push({
        product: productId,
        line_type: line.line_type,
        inventory_item: line.raw_material_id,
        microgreen_id: null,
        freeze_dryer_profile_id: null,
        qty_per_unit: line.qty_per_unit,
        unit_label: unitLabel,
        sale_price: null,
        material_name_snapshot: item?.name ?? null,
        notes: line.reason || null,
        user_id: userId,
      });
    }
  }

  const toDeleteIds = existingBomLines.filter((b) => !matchedIds.has(b.id)).map((b) => b.id);
  return { toInsert, toUpdate, toDeleteIds };
}

export type LineDiffEntry = {
  key: string;
  itemName: string;
  line_type: FormulationLineType;
  change: "added" | "removed" | "changed" | "unchanged";
  previousQty: number | null;
  currentQty: number | null;
  unit: string;
};

/** Diffs two versions' formula lines, keyed by (line_type, raw_material_id). */
export function diffFormulationLines(
  previous: FormulationLineRow[],
  current: FormulationLineRow[],
  items: InventoryItemLite[],
): LineDiffEntry[] {
  const key = (l: { line_type: string; raw_material_id: string }) => `${l.line_type}:${l.raw_material_id}`;
  const prevByKey = new Map(previous.map((l) => [key(l), l]));
  const currByKey = new Map(current.map((l) => [key(l), l]));
  const allKeys = new Set([...prevByKey.keys(), ...currByKey.keys()]);
  const entries: LineDiffEntry[] = [];
  for (const k of allKeys) {
    const prev = prevByKey.get(k);
    const curr = currByKey.get(k);
    const material = curr || prev!;
    const item = items.find((i) => i.id === material.raw_material_id);
    let change: LineDiffEntry["change"];
    if (!prev) change = "added";
    else if (!curr) change = "removed";
    else if (Number(prev.qty_per_unit) !== Number(curr.qty_per_unit)) change = "changed";
    else change = "unchanged";
    entries.push({
      key: k,
      itemName: item?.name ?? "Unknown material",
      line_type: material.line_type,
      change,
      previousQty: prev ? Number(prev.qty_per_unit) : null,
      currentQty: curr ? Number(curr.qty_per_unit) : null,
      unit: item?.unit ?? "",
    });
  }
  return entries;
}

/** One row of the baseline-backfill dry-run preview. */
export type BaselinePreviewRow = {
  productId: string;
  productName: string;
  lineCount: number;
  lines: { itemName: string; line_type: string; qty_per_unit: number; unit_label: string }[];
  warning: string | null;
};

/**
 * Builds the dry-run preview for importing every existing BotanIQals
 * product's current BOM as its v1 "baseline" formulation. Pure/read-only —
 * never writes anything. Flags (but does not block on) anything that
 * looks off so a human can review before confirming the write.
 */
export function buildBaselinePreview(
  products: { id: string; name: string; is_microgreen: boolean | null }[],
  bomLines: BomLineLite[],
  items: InventoryItemLite[],
): BaselinePreviewRow[] {
  const botaniqalsProducts = products.filter((p) => p.is_microgreen !== true);
  return botaniqalsProducts.map((p) => {
    const lines = bomLines.filter((b) => b.product === p.id && b.inventory_item);
    const previewLines = lines.map((b) => {
      const item = items.find((i) => i.id === b.inventory_item);
      return {
        itemName: item?.name ?? b.material_name_snapshot ?? "Unknown material",
        line_type: b.line_type,
        qty_per_unit: Number(b.qty_per_unit) || 0,
        unit_label: b.unit_label,
      };
    });
    let warning: string | null = null;
    if (lines.length === 0) {
      warning = "No BOM lines found for this product — nothing to import; it will be skipped.";
    } else if (previewLines.some((l) => !Number.isFinite(l.qty_per_unit) || l.qty_per_unit <= 0)) {
      warning = "One or more quantities are zero, negative, or not a number — review before importing.";
    } else if (previewLines.some((l) => l.qty_per_unit > 10000)) {
      warning = "An unusually large per-unit quantity was found — double-check this isn't a per-batch value.";
    }
    return {
      productId: p.id,
      productName: p.name,
      lineCount: lines.length,
      lines: previewLines,
      warning,
    };
  });
}
