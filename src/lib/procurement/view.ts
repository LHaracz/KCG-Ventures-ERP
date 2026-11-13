/**
 * Pure view logic for the Procurement and Suppliers pages: one row per raw
 * material with its stock alert and suppliers, the Order button target,
 * filters, summary counts and the shortages groups. Tested without a browser.
 */
import { isShortage, sortByStockAlert, stockAlert, suggestedQuantity, type StockAlert } from "./stockAlert";
import type { EquipmentCategory, EquipmentItem, EquipmentLink, ProcurementData, RawMaterial, Supplier, SupplierLink } from "./types";

export type LinkWithSupplier = SupplierLink & { supplier: Supplier };

export type MaterialRow = {
  material: RawMaterial;
  name: string;
  quantity_on_hand: RawMaterial["quantity_on_hand"];
  par_level: RawMaterial["par_level"];
  unit: string;
  alert: StockAlert;
  /** Active links to active suppliers, preferred first, then by supplier name. */
  links: LinkWithSupplier[];
  preferred: LinkWithSupplier | null;
  /** No active supplier, no preferred one, or the preferred one has no product link and no website. */
  missingInfo: boolean;
  /** Has a preferred listing, and that listing has no price. */
  missingPrice: boolean;
};

const hasPrice = (l: { price: number | string | null } | null | undefined) => !!l && l.price !== null && l.price !== undefined && String(l.price) !== "";

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

export function activeLinksBySupplier(data: ProcurementData): Map<string, LinkWithSupplier[]> {
  const suppliers = new Map(data.suppliers.filter((s) => !s.archived_at).map((s) => [s.id, s]));
  const out = new Map<string, LinkWithSupplier[]>();
  for (const l of data.links) {
    const supplier = suppliers.get(l.supplier_id);
    if (l.archived_at || !supplier) continue;
    const list = out.get(l.raw_material_id) ?? [];
    list.push({ ...l, supplier });
    out.set(l.raw_material_id, list);
  }
  return out;
}

export function buildMaterialRows(data: ProcurementData): MaterialRow[] {
  const linksByMaterial = activeLinksBySupplier(data);
  const rows = data.materials.map((m): MaterialRow => {
    const links = (linksByMaterial.get(m.id) ?? []).sort(
      (a, b) => Number(b.is_preferred) - Number(a.is_preferred) || byName(a.supplier.name, b.supplier.name),
    );
    const preferred = links.find((l) => l.is_preferred) ?? null;
    const unit = (m.unit ?? "").trim();
    return {
      material: m,
      name: m.name,
      quantity_on_hand: m.quantity_on_hand,
      par_level: m.par_level,
      unit,
      alert: stockAlert(m.quantity_on_hand, m.par_level, unit),
      links,
      preferred,
      missingInfo: !preferred || (!preferred.product_url && !preferred.supplier.website_url),
      missingPrice: !!preferred && !hasPrice(preferred),
    };
  });
  return sortByStockAlert(rows);
}

export type OrderTarget =
  | { kind: "product"; href: string; label: "Order"; title: string }
  | { kind: "website"; href: string; label: "Website"; title: string }
  | { kind: "none"; href: null; label: "No link yet"; title: string };

type Orderable = { product_url: string | null; supplier: Pick<Supplier, "name" | "website_url"> };

/** Product page first, then the supplier's website, otherwise disabled. Same for raw materials and equipment. */
export function orderTarget(link: Orderable | null): OrderTarget {
  if (!link) return { kind: "none", href: null, label: "No link yet", title: "No preferred supplier yet" };
  const name = link.supplier.name;
  if (link.product_url) return { kind: "product", href: link.product_url, label: "Order", title: `Open the product page at ${name}` };
  if (link.supplier.website_url) return { kind: "website", href: link.supplier.website_url, label: "Website", title: `Open the website of ${name}` };
  return { kind: "none", href: null, label: "No link yet", title: `${name} has no product link or website yet` };
}

/** Why Create PO is disabled for a row, or null when it can be used. */
export function createPoBlocker(row: MaterialRow): string | null {
  if (row.links.length === 0) return "Add a supplier first";
  if (!row.preferred) return "Choose a preferred supplier first";
  return null;
}

export type QuickFilter = "out" | "below" | "no_supplier" | null;
export type RowFilters = { search: string; shortagesOnly: boolean; missingInfo: boolean; missingPrice?: boolean; quick: QuickFilter };
export const NO_FILTERS: RowFilters = { search: "", shortagesOnly: false, missingInfo: false, missingPrice: false, quick: null };

export function filterRows(rows: readonly MaterialRow[], f: RowFilters): MaterialRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q) && !r.links.some((l) => l.supplier.name.toLowerCase().includes(q))) return false;
    if (f.shortagesOnly && !isShortage(r.alert.state)) return false;
    if (f.missingInfo && !r.missingInfo) return false;
    if (f.missingPrice && !r.missingPrice) return false;
    if (f.quick === "out" && r.alert.state !== "out") return false;
    if (f.quick === "below" && r.alert.state !== "below") return false;
    if (f.quick === "no_supplier" && r.links.length > 0) return false;
    return true;
  });
}

export function summaryCounts(rows: readonly MaterialRow[]) {
  return {
    out: rows.filter((r) => r.alert.state === "out").length,
    below: rows.filter((r) => r.alert.state === "below").length,
    noSupplier: rows.filter((r) => r.links.length === 0).length,
  };
}

export type ShortageItem = { row: MaterialRow; suggested: string | null };
export type ShortageGroup = { supplier: Supplier; items: ShortageItem[] };

/** Shortages (out or below), one group per preferred supplier; the rest have no preferred supplier yet. */
export function shortageGroups(rows: readonly MaterialRow[]): { groups: ShortageGroup[]; noSupplier: MaterialRow[] } {
  const groups = new Map<string, ShortageGroup>();
  const noSupplier: MaterialRow[] = [];
  for (const row of rows) {
    if (!isShortage(row.alert.state)) continue;
    if (!row.preferred) {
      noSupplier.push(row);
      continue;
    }
    const g = groups.get(row.preferred.supplier_id) ?? { supplier: row.preferred.supplier, items: [] };
    g.items.push({ row, suggested: suggestedQuantity(row.quantity_on_hand, row.par_level)?.toFixed() ?? null });
    groups.set(row.preferred.supplier_id, g);
  }
  return { groups: [...groups.values()].sort((a, b) => byName(a.supplier.name, b.supplier.name)), noSupplier };
}

/** Raw materials that are short AND have this supplier as preferred, in table order. */
export function supplierShortageMaterialIds(rows: readonly MaterialRow[], supplierId: string): string[] {
  return rows.filter((r) => isShortage(r.alert.state) && r.preferred?.supplier_id === supplierId).map((r) => r.material.id);
}

/** Active equipment listing count per supplier (active items only). */
export function supplierEquipmentUsage(data: ProcurementData): Map<string, number> {
  const active = new Set(data.equipment.filter((e) => !e.archived_at).map((e) => e.id));
  const out = new Map<string, number>();
  for (const l of data.equipmentLinks) if (!l.archived_at && active.has(l.equipment_id)) out.set(l.supplier_id, (out.get(l.supplier_id) ?? 0) + 1);
  return out;
}

/** "Used for 3 ingredients and 1 equipment item" */
export function usageText(materials: number, equipment: number): string {
  return `Used for ${materials} ${materials === 1 ? "ingredient" : "ingredients"} and ${equipment} ${equipment === 1 ? "equipment item" : "equipment items"}`;
}

/** Active ingredient count per supplier. */
export function supplierUsage(data: ProcurementData): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of data.links) if (!l.archived_at) out.set(l.supplier_id, (out.get(l.supplier_id) ?? 0) + 1);
  return out;
}

/** The raw materials a supplier is linked to (active links), with their rows, by name. */
export function supplierMaterials(rows: readonly MaterialRow[], supplierId: string): { row: MaterialRow; link: LinkWithSupplier }[] {
  const out: { row: MaterialRow; link: LinkWithSupplier }[] = [];
  for (const row of rows) {
    const link = row.links.find((l) => l.supplier_id === supplierId);
    if (link) out.push({ row, link });
  }
  return out.sort((a, b) => byName(a.row.name, b.row.name));
}

export function filterSuppliers(suppliers: readonly Supplier[], search: string, showArchived: boolean): Supplier[] {
  const q = search.trim().toLowerCase();
  return suppliers
    .filter((s) => (showArchived ? true : !s.archived_at))
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.contact_name ?? "").toLowerCase().includes(q))
    .sort((a, b) => byName(a.name, b.name));
}

// --- Equipment ----------------------------------------------------------------------------
export type EquipmentLinkWithSupplier = EquipmentLink & { supplier: Supplier };

export type EquipmentRow = {
  item: EquipmentItem;
  name: string;
  category: EquipmentCategory | null;
  archived: boolean;
  /** Active listings with active suppliers, preferred first, then by supplier name. */
  links: EquipmentLinkWithSupplier[];
  preferred: EquipmentLinkWithSupplier | null;
  missingInfo: boolean;
  missingPrice: boolean;
};

/** Case-insensitive, natural number order: "Scale 2" before "Scale 10". */
export const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || a.localeCompare(b, "en", { numeric: true });

export function buildEquipmentRows(data: ProcurementData, opts: { includeArchived?: boolean } = {}): EquipmentRow[] {
  const suppliers = new Map(data.suppliers.filter((s) => !s.archived_at).map((s) => [s.id, s]));
  const categories = new Map(data.categories.map((c) => [c.id, c]));
  const byItem = new Map<string, EquipmentLinkWithSupplier[]>();
  for (const l of data.equipmentLinks) {
    const supplier = suppliers.get(l.supplier_id);
    if (l.archived_at || !supplier) continue;
    const list = byItem.get(l.equipment_id) ?? [];
    list.push({ ...l, supplier });
    byItem.set(l.equipment_id, list);
  }
  return data.equipment
    .filter((e) => opts.includeArchived || !e.archived_at)
    .map((item): EquipmentRow => {
      const links = item.archived_at
        ? []
        : (byItem.get(item.id) ?? []).sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred) || byName(a.supplier.name, b.supplier.name));
      const preferred = links.find((l) => l.is_preferred) ?? null;
      return {
        item,
        name: item.name,
        category: categories.get(item.category_id) ?? null,
        archived: !!item.archived_at,
        links,
        preferred,
        missingInfo: !preferred || (!preferred.product_url && !preferred.supplier.website_url),
        missingPrice: !!preferred && !hasPrice(preferred),
      };
    })
    .sort((a, b) => naturalCompare(a.name, b.name));
}

export type EquipmentQuick = "no_supplier" | "missing_price" | null;
export type EquipmentFilters = { search: string; categoryId: string | null; missingInfo: boolean; missingPrice: boolean; quick: EquipmentQuick };
export const NO_EQUIPMENT_FILTERS: EquipmentFilters = { search: "", categoryId: null, missingInfo: false, missingPrice: false, quick: null };

export function filterEquipmentRows(rows: readonly EquipmentRow[], f: EquipmentFilters): EquipmentRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q) && !r.links.some((l) => l.supplier.name.toLowerCase().includes(q))) return false;
    if (f.categoryId && r.item.category_id !== f.categoryId) return false;
    if (f.missingInfo && !r.missingInfo) return false;
    if ((f.missingPrice || f.quick === "missing_price") && !r.missingPrice) return false;
    if (f.quick === "no_supplier" && r.links.length > 0) return false;
    return true;
  });
}

/** Counts over active items only. */
export function equipmentSummary(rows: readonly EquipmentRow[]) {
  const active = rows.filter((r) => !r.archived);
  return { noSupplier: active.filter((r) => r.links.length === 0).length, missingPrice: active.filter((r) => r.missingPrice).length };
}

/** Active categories in order, each with its number of active equipment items. */
export function categoryCounts(data: ProcurementData): { category: EquipmentCategory; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of data.equipment) if (!e.archived_at) counts.set(e.category_id, (counts.get(e.category_id) ?? 0) + 1);
  return data.categories
    .filter((c) => !c.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order || naturalCompare(a.name, b.name))
    .map((category) => ({ category, count: counts.get(category.id) ?? 0 }));
}

export function equipmentCreatePoBlocker(row: EquipmentRow): string | null {
  if (row.archived) return "This item is archived";
  if (row.links.length === 0) return "Add a supplier first";
  if (!row.preferred) return "Choose a preferred supplier first";
  return null;
}

/** The equipment items a supplier is listed for (active listings), by name. */
export function supplierEquipment(rows: readonly EquipmentRow[], supplierId: string): { row: EquipmentRow; link: EquipmentLinkWithSupplier }[] {
  const out: { row: EquipmentRow; link: EquipmentLinkWithSupplier }[] = [];
  for (const row of rows) {
    const link = row.links.find((l) => l.supplier_id === supplierId);
    if (link) out.push({ row, link });
  }
  return out.sort((a, b) => naturalCompare(a.row.name, b.row.name));
}
