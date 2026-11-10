/**
 * Pure view logic for the Procurement and Suppliers pages: one row per raw
 * material with its stock alert and suppliers, the Order button target,
 * filters, summary counts and the shortages groups. Tested without a browser.
 */
import { isShortage, sortByStockAlert, stockAlert, suggestedQuantity, type StockAlert } from "./stockAlert";
import type { ProcurementData, RawMaterial, Supplier, SupplierLink } from "./types";

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
};

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
    };
  });
  return sortByStockAlert(rows);
}

export type OrderTarget =
  | { kind: "product"; href: string; label: "Order"; title: string }
  | { kind: "website"; href: string; label: "Website"; title: string }
  | { kind: "none"; href: null; label: "No link yet"; title: string };

/** Product page first, then the supplier's website, otherwise disabled. */
export function orderTarget(link: LinkWithSupplier | null): OrderTarget {
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
export type RowFilters = { search: string; shortagesOnly: boolean; missingInfo: boolean; quick: QuickFilter };
export const NO_FILTERS: RowFilters = { search: "", shortagesOnly: false, missingInfo: false, quick: null };

export function filterRows(rows: readonly MaterialRow[], f: RowFilters): MaterialRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q) && !r.links.some((l) => l.supplier.name.toLowerCase().includes(q))) return false;
    if (f.shortagesOnly && !isShortage(r.alert.state)) return false;
    if (f.missingInfo && !r.missingInfo) return false;
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
