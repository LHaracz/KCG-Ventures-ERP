/**
 * Builds the values a new Purchase Order starts with when it is opened from
 * Procurement. Pure (tested). The server loads the supplier and raw
 * materials from their ids and runs this; the browser never sends names,
 * notes or prices.
 *
 * Never copied into the PO: payment notes, ordering notes, link notes, the
 * product link, or any other note. Prices are not tracked, so unit price
 * stays blank and the PO form's own "unit price must be greater than 0"
 * rule still applies before saving.
 */
import type { PoLineInput } from "@/lib/purchaseOrders";
import { suggestedQuantity } from "./stockAlert";
import { priceForPoLine } from "./price";
import type { EquipmentItem, EquipmentLink, RawMaterial, Supplier, SupplierLink } from "./types";

export const MAX_PO_LINES = 100;

/**
 * Canonical unit spellings for PO lines. The PO form's unit is free text, so
 * a unit we don't recognize is kept as typed (the free-text "Other").
 */
const UNIT_ALIASES: Record<string, string[]> = {
  g: ["g", "gr", "gram", "grams", "gm", "gms"],
  kg: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"],
  mg: ["mg", "milligram", "milligrams"],
  lb: ["lb", "lbs", "pound", "pounds"],
  oz: ["oz", "ounce", "ounces"],
  "fl oz": ["fl oz", "floz", "fl. oz", "fl. oz.", "fluid ounce", "fluid ounces"],
  L: ["l", "liter", "liters", "litre", "litres", "ltr"],
  mL: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"],
  gal: ["gal", "gallon", "gallons"],
  each: ["each", "ea", "unit", "units", "pc", "pcs", "piece", "pieces", "ct", "count"],
  case: ["case", "cases", "cs"],
  box: ["box", "boxes"],
  bag: ["bag", "bags"],
  roll: ["roll", "rolls"],
  pack: ["pack", "packs", "pk"],
};
export const PO_UNIT_OPTIONS = Object.keys(UNIT_ALIASES);

/** { unit, matched }: the PO unit for a raw material unit; unmatched units are kept as typed ("Other"). */
export function mapUnit(unit: string | null | undefined): { unit: string; matched: boolean } {
  const original = (unit ?? "").trim();
  const key = original.toLowerCase().replace(/\s+/g, " ");
  for (const [canonical, aliases] of Object.entries(UNIT_ALIASES)) {
    if (aliases.includes(key)) return { unit: canonical, matched: true };
  }
  return { unit: original, matched: false };
}

export type PrefillItem = {
  material: RawMaterial;
  link: SupplierLink | null;
};

export type PoVendorPrefill = {
  vendor_name: string;
  vendor_contact_name: string;
  vendor_email: string;
  vendor_phone: string;
  vendor_account_number: string;
  vendor_address_line1: string;
  vendor_address_line2: string;
  vendor_city: string;
  vendor_state: string;
  vendor_zip: string;
  vendor_country: string;
};

export type PoPrefill = PoVendorPrefill & {
  payment_terms: string;
  lines: PoLineInput[];
  /** Units that were kept as typed (no standard unit matched). */
  unmatched_units: string[];
  warnings: string[];
};

export const MISSING_ADDRESS_WARNING =
  "This supplier has no address saved. Add it on the Suppliers page so it prefills next time.";
export const notAddedWarning = (n: number) => `${n} ${n === 1 ? "ingredient was" : "ingredients were"} not added`;

const s = (v: string | null | undefined) => (v ?? "").trim();

export function hasCompleteAddress(supplier: Pick<Supplier, "address_line1" | "city" | "state" | "zip" | "country">): boolean {
  return [supplier.address_line1, supplier.city, supplier.state, supplier.zip, supplier.country].every((v) => s(v) !== "");
}

function vendorFrom(supplier: Supplier): PoVendorPrefill {
  return {
    vendor_name: s(supplier.name),
    vendor_contact_name: s(supplier.contact_name),
    vendor_email: s(supplier.contact_email),
    vendor_phone: s(supplier.contact_phone),
    vendor_account_number: s(supplier.account_number),
    vendor_address_line1: s(supplier.address_line1),
    vendor_address_line2: s(supplier.address_line2),
    vendor_city: s(supplier.city),
    vendor_state: s(supplier.state),
    vendor_zip: s(supplier.zip),
    vendor_country: s(supplier.country),
  };
}

/**
 * Raw materials: one line per ingredient with the suggested quantity. The
 * unit price stays blank on purpose: a stored listing price may be per a
 * different unit (for example per 25 kg bag) than the PO line.
 */
export function buildPoPrefill(
  supplier: Supplier,
  items: readonly PrefillItem[],
  formDefaults: { payment_terms: string },
): PoPrefill {
  const warnings: string[] = [];
  if (!hasCompleteAddress(supplier)) warnings.push(MISSING_ADDRESS_WARNING);

  const kept = items.slice(0, MAX_PO_LINES);
  if (items.length > MAX_PO_LINES) warnings.push(notAddedWarning(items.length - MAX_PO_LINES));

  const unmatched = new Set<string>();
  const lines: PoLineInput[] = kept.map(({ material, link }) => {
    const mapped = mapUnit(material.unit);
    if (!mapped.matched && mapped.unit) unmatched.add(mapped.unit);
    const qty = suggestedQuantity(material.quantity_on_hand, material.par_level);
    return {
      item_number: "",
      description: s(link?.supplier_item) || s(material.name),
      quantity: qty ? qty.toFixed() : "",
      unit: mapped.unit,
      unit_price: "",
    };
  });

  return {
    ...vendorFrom(supplier),
    payment_terms: s(supplier.default_po_payment_terms) || formDefaults.payment_terms,
    lines,
    unmatched_units: [...unmatched],
    warnings,
  };
}

/**
 * Equipment: one PO for one supplier and one item. One line: the equipment
 * name, the model or part number as the item number, quantity 1, unit
 * "each", and the listing's stored price as the unit price (blank if none).
 * Notes and the product link are never copied.
 */
export function buildEquipmentPoPrefill(
  supplier: Supplier,
  item: Pick<EquipmentItem, "name">,
  link: Pick<EquipmentLink, "supplier_item" | "price">,
  formDefaults: { payment_terms: string },
): PoPrefill {
  return {
    ...vendorFrom(supplier),
    payment_terms: s(supplier.default_po_payment_terms) || formDefaults.payment_terms,
    lines: [{ item_number: s(link.supplier_item), description: s(item.name), quantity: "1", unit: "each", unit_price: priceForPoLine(link.price) }],
    unmatched_units: [],
    warnings: hasCompleteAddress(supplier) ? [] : [MISSING_ADDRESS_WARNING],
  };
}

/** Read-only box above the PO form. Never part of the PO, never printed, never stored. */
export type SupplierInfo = {
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  payment_methods: string[];
  payment_notes: string | null;
  ordering_notes: string | null;
  reference_url: string | null;
  reference_label: "Product page" | "Website" | null;
  /** Listed prices for reference (one per line that has a price). Never put on the PO. */
  prices: SupplierInfoPrice[];
};

export type SupplierInfoPrice = { label: string; price: string; price_note: string | null; price_updated_at: string | null };

const infoPrice = (label: string, l: { price: number | string | null; price_note: string | null; price_updated_at: string | null } | null): SupplierInfoPrice[] =>
  l && l.price !== null && l.price !== undefined && String(l.price) !== ""
    ? [{ label, price: String(l.price), price_note: l.price_note, price_updated_at: l.price_updated_at }]
    : [];

export function buildSupplierInfo(supplier: Supplier, items: readonly PrefillItem[]): SupplierInfo {
  const productUrls = [...new Set(items.map((i) => i.link?.product_url).filter((u): u is string => !!u))];
  const product = items.length === 1 && productUrls.length === 1 ? productUrls[0] : null;
  return {
    name: supplier.name,
    contact_name: supplier.contact_name,
    contact_email: supplier.contact_email,
    contact_phone: supplier.contact_phone,
    payment_methods: supplier.payment_methods ?? [],
    payment_notes: supplier.payment_notes,
    ordering_notes: supplier.ordering_notes,
    reference_url: product ?? supplier.website_url ?? null,
    reference_label: product ? "Product page" : supplier.website_url ? "Website" : null,
    prices: items.flatMap((i) => infoPrice(i.material.name, i.link)),
  };
}

export function buildEquipmentSupplierInfo(supplier: Supplier, item: Pick<EquipmentItem, "name">, link: EquipmentLink): SupplierInfo {
  return {
    name: supplier.name,
    contact_name: supplier.contact_name,
    contact_email: supplier.contact_email,
    contact_phone: supplier.contact_phone,
    payment_methods: supplier.payment_methods ?? [],
    payment_notes: supplier.payment_notes,
    ordering_notes: supplier.ordering_notes,
    reference_url: link.product_url ?? supplier.website_url ?? null,
    reference_label: link.product_url ? "Product page" : supplier.website_url ? "Website" : null,
    prices: infoPrice(item.name, link),
  };
}

/** The New Purchase Order URL for a supplier and one equipment item. Only ids go in the URL. */
export function newEquipmentPoHref(supplierId: string, equipmentId: string): string {
  return `/inventory/purchase-orders/new?${new URLSearchParams({ supplier: supplierId, equipment: equipmentId }).toString()}`;
}

/** The New Purchase Order URL for a supplier and raw materials. Only ids go in the URL. */
export function newPoHref(supplierId: string, materialIds: readonly string[]): string {
  const p = new URLSearchParams({ supplier: supplierId });
  if (materialIds.length > 0) p.set("materials", materialIds.join(","));
  return `/inventory/purchase-orders/new?${p.toString()}`;
}

type DraftLike = PoVendorPrefill & { payment_terms: string; lines: PoLineInput[] };

/**
 * Puts a prefill onto a new PO form draft that already has the business
 * profile's defaults. Vendor fields and lines come from the prefill; payment
 * terms only when the supplier has a default. Everything else (business,
 * dates, ship-to, buyer, terms text, notes) stays as the form set it.
 */
export function applyPrefillToDraft<T extends DraftLike>(draft: T, prefill: PoPrefill, emptyLine: PoLineInput): T {
  return {
    ...draft,
    vendor_name: prefill.vendor_name,
    vendor_contact_name: prefill.vendor_contact_name,
    vendor_email: prefill.vendor_email,
    vendor_phone: prefill.vendor_phone,
    vendor_account_number: prefill.vendor_account_number,
    vendor_address_line1: prefill.vendor_address_line1,
    vendor_address_line2: prefill.vendor_address_line2,
    vendor_city: prefill.vendor_city,
    vendor_state: prefill.vendor_state,
    vendor_zip: prefill.vendor_zip,
    vendor_country: prefill.vendor_country,
    payment_terms: prefill.payment_terms || draft.payment_terms,
    lines: prefill.lines.length > 0 ? prefill.lines.slice(0, MAX_PO_LINES).map((l) => ({ ...l })) : [{ ...emptyLine }],
  };
}
