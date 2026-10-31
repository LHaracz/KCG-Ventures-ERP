/**
 * Loads the numbers behind a Formula Table: a BotanIQals product's latest
 * FINAL formulation lines (the same per-unit amounts Finish Iteration
 * writes to Products & BOM). Works with the browser client (live editor
 * view) and the service-role client (publish snapshots, auto-versioning).
 *
 * Quantities are read as text (qty_per_unit::text) so they stay exact
 * decimals; they are never parsed into floats here.
 */
import type { FormulaInputRow } from "@/lib/formulaTable";

type AnyClient = { from: (table: string) => any };

export type ProductFormula =
  | {
      status: "ok";
      productId: string;
      productName: string;
      formulationId: string;
      versionNumber: number;
      finalizedAt: string | null;
      finalizedBy: string | null;
      changeSummary: string | null;
      rows: FormulaInputRow[];
      /** True when the product's Products & BOM lines differ from this formula. */
      bomDiffers: boolean;
    }
  | { status: "no_formula"; productId: string; productName: string }
  | { status: "product_removed"; productId: string; productName: string | null };

/** One formula table's frozen values inside sop_versions.formula_snapshot (keyed by nodeId). */
export type FormulaSnapshotEntry = {
  productId: string | null;
  productName: string | null;
  formulationId: string | null;
  versionNumber: number | null;
  capturedAt: string;
  status: "ok" | "no_formula" | "product_removed" | "no_product";
  rows: FormulaInputRow[];
};
export type FormulaSnapshot = Record<string, FormulaSnapshotEntry>;

export type BotanicalProduct = { id: string; name: string };

/** Active BotanIQals products for the Product picker. */
export async function listBotaniqalsProducts(client: AnyClient): Promise<BotanicalProduct[]> {
  const { data, error } = await client
    .from("products")
    .select("id, name, is_microgreen, deleted_at")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; name: string; is_microgreen: boolean | null }[])
    .filter((p) => p.is_microgreen !== true)
    .map((p) => ({ id: p.id, name: p.name }));
}

/** Canonical decimal string for equality checks (no float parsing). */
export function canonicalDecimal(value: string | number | null | undefined): string {
  const s = String(value ?? "").trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const int = (m[2] || "0").replace(/^0+(?=\d)/, "");
  const frac = (m[3] || "").replace(/0+$/, "");
  const body = frac ? `${int}.${frac}` : int;
  return body === "0" ? "0" : `${m[1]}${body}`;
}

/** Latest final formulation per product, keyed by product id. */
export async function loadLatestFinalFormulations(
  client: AnyClient,
  productIds: string[],
): Promise<Map<string, { formulationId: string; versionNumber: number }>> {
  const out = new Map<string, { formulationId: string; versionNumber: number }>();
  if (productIds.length === 0) return out;
  const { data: fps, error: fpError } = await client
    .from("formulation_products")
    .select("id, product_id, deleted_at")
    .in("product_id", productIds);
  if (fpError) throw new Error(fpError.message);
  const live = ((fps ?? []) as { id: string; product_id: string; deleted_at: string | null }[]).filter((f) => !f.deleted_at);
  if (live.length === 0) return out;
  const { data: forms, error } = await client
    .from("formulations")
    .select("id, formulation_product_id, version_number, status")
    .in("formulation_product_id", live.map((f) => f.id))
    .eq("status", "final");
  if (error) throw new Error(error.message);
  for (const f of (forms ?? []) as { id: string; formulation_product_id: string; version_number: number }[]) {
    const productId = live.find((x) => x.id === f.formulation_product_id)?.product_id;
    if (!productId) continue;
    const prev = out.get(productId);
    if (!prev || f.version_number > prev.versionNumber) out.set(productId, { formulationId: f.id, versionNumber: f.version_number });
  }
  return out;
}

export async function loadProductFormula(client: AnyClient, productId: string): Promise<ProductFormula> {
  const { data: product, error: productError } = await client
    .from("products")
    .select("id, name, is_microgreen, deleted_at")
    .eq("id", productId)
    .maybeSingle();
  if (productError) throw new Error(productError.message);
  if (!product || product.deleted_at || product.is_microgreen === true) {
    return { status: "product_removed", productId, productName: product?.name ?? null };
  }

  const latest = (await loadLatestFinalFormulations(client, [productId])).get(productId);
  if (!latest) return { status: "no_formula", productId, productName: product.name };

  const [formRes, linesRes, bomRes] = await Promise.all([
    client
      .from("formulations")
      .select("id, version_number, finalized_at, finalized_by, change_summary")
      .eq("id", latest.formulationId)
      .single(),
    client
      .from("formulation_lines")
      .select("line_type, raw_material_id, qty:qty_per_unit::text, sort_order")
      .eq("formulation_id", latest.formulationId)
      .order("sort_order", { ascending: true }),
    client
      .from("bom_lines")
      .select("line_type, inventory_item, qty:qty_per_unit::text")
      .eq("product", productId),
  ]);
  if (formRes.error) throw new Error(formRes.error.message);
  if (linesRes.error) throw new Error(linesRes.error.message);
  if (bomRes.error) throw new Error(bomRes.error.message);

  const lines = (linesRes.data ?? []) as { line_type: string; raw_material_id: string; qty: string; sort_order: number }[];
  const itemIds = Array.from(new Set(lines.map((l) => l.raw_material_id)));
  const items = new Map<string, { name: string; unit: string }>();
  if (itemIds.length) {
    const { data: itemRows, error: itemError } = await client.from("inventory_items").select("id, name, unit").in("id", itemIds);
    if (itemError) throw new Error(itemError.message);
    for (const it of (itemRows ?? []) as { id: string; name: string; unit: string | null }[]) {
      items.set(it.id, { name: it.name, unit: it.unit ?? "" });
    }
  }

  const bom = ((bomRes.data ?? []) as { line_type: string; inventory_item: string | null; qty: string }[]).filter((b) => b.inventory_item);
  const key = (t: string, id: string) => `${t}:${id}`;
  const bomMap = new Map(bom.map((b) => [key(b.line_type, b.inventory_item!), canonicalDecimal(b.qty)]));
  let bomDiffers = bomMap.size !== lines.length;
  if (!bomDiffers) {
    for (const l of lines) {
      if (bomMap.get(key(l.line_type, l.raw_material_id)) !== canonicalDecimal(l.qty)) {
        bomDiffers = true;
        break;
      }
    }
  }

  return {
    status: "ok",
    productId,
    productName: product.name,
    formulationId: latest.formulationId,
    versionNumber: formRes.data.version_number,
    finalizedAt: formRes.data.finalized_at,
    finalizedBy: formRes.data.finalized_by,
    changeSummary: formRes.data.change_summary,
    rows: lines.map((l) => ({
      name: items.get(l.raw_material_id)?.name ?? "Unknown material",
      unit: items.get(l.raw_material_id)?.unit ?? "",
      qtyPerUnit: l.qty,
    })),
    bomDiffers,
  };
}

export function snapshotFromFormula(formula: ProductFormula | null, productId: string | null, capturedAt: string): FormulaSnapshotEntry {
  if (!productId || !formula) {
    return { productId: null, productName: null, formulationId: null, versionNumber: null, capturedAt, status: "no_product", rows: [] };
  }
  if (formula.status !== "ok") {
    return {
      productId,
      productName: formula.productName,
      formulationId: null,
      versionNumber: null,
      capturedAt,
      status: formula.status,
      rows: [],
    };
  }
  return {
    productId,
    productName: formula.productName,
    formulationId: formula.formulationId,
    versionNumber: formula.versionNumber,
    capturedAt,
    status: "ok",
    rows: formula.rows.map((r) => ({ name: r.name, unit: r.unit, qtyPerUnit: String(r.qtyPerUnit) })),
  };
}
