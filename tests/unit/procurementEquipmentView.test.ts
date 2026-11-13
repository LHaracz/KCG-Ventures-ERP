// Equipment tab logic and rendering (no browser), the raw materials Price
// column and Missing price filter, tabs and Back links, and the equipment
// PO prefill. Invented equipment, suppliers and example.test addresses only.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NO_EQUIPMENT_FILTERS,
  NO_FILTERS,
  buildEquipmentRows,
  buildMaterialRows,
  categoryCounts,
  equipmentCreatePoBlocker,
  equipmentSummary,
  filterEquipmentRows,
  filterRows,
  naturalCompare,
  orderTarget,
  supplierEquipment,
  supplierEquipmentUsage,
  supplierUsage,
  usageText,
} from "@/lib/procurement/view";
import { EquipmentTable, ProcurementTable, ProcurementTabs, SupplierInfoBox } from "@/components/procurement/ProcurementUi";
import {
  buildEquipmentPoPrefill,
  buildEquipmentSupplierInfo,
  buildPoPrefill,
  MISSING_ADDRESS_WARNING,
  newEquipmentPoHref,
} from "@/lib/procurement/poPrefill";
import { procurementHref, type EquipmentCategory, type EquipmentItem, type EquipmentLink, type ProcurementData, type Supplier, type SupplierLink } from "@/lib/procurement/types";

const NOTES = ["PAYNOTE-call first", "ORDERNOTE-before noon", "LISTINGNOTE-ask for demo unit"];

const sup = (id: string, name: string, over: Partial<Supplier> = {}): Supplier => ({
  id, name, website_url: null, contact_name: null, contact_email: null, contact_phone: null, account_number: null,
  payment_methods: [], payment_notes: null, ordering_notes: null, address_line1: null, address_line2: null, city: null,
  state: null, zip: null, country: null, default_po_payment_terms: null, archived_at: null,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", updated_by_name: null, ...over,
});
const cat = (id: string, name: string, sort: number, archived = false): EquipmentCategory => ({
  id, name, sort_order: sort, archived_at: archived ? "2026-10-01T00:00:00Z" : null, created_at: "",
});
const item = (id: string, name: string, category: string, over: Partial<EquipmentItem> = {}): EquipmentItem => ({
  id, name, category_id: category, description: null, archived_at: null, created_at: "", updated_at: "", updated_by_name: null, ...over,
});
const eqLink = (id: string, eq: string, supplier: string, over: Partial<EquipmentLink> = {}): EquipmentLink => ({
  id, equipment_id: eq, supplier_id: supplier, is_preferred: false, product_url: null, supplier_item: null, price: null, price_note: null,
  price_updated_at: null, notes: null, link_updated_at: null, archived_at: null, created_at: "", updated_at: "", ...over,
});
const rmLink = (id: string, raw: string, supplier: string, over: Partial<SupplierLink> = {}): SupplierLink => ({
  id, raw_material_id: raw, supplier_id: supplier, is_preferred: false, product_url: null, supplier_item: null, pack_info: null,
  coa_policy: "unknown", notes: null, link_updated_at: null, price: null, price_note: null, price_updated_at: null, archived_at: null,
  created_at: "", updated_at: "", ...over,
});

function data(): ProcurementData {
  return {
    materials: [
      { id: "m1", name: "Material A", unit: "kg", quantity_on_hand: 0, par_level: 10 },
      { id: "m2", name: "Material B", unit: "kg", quantity_on_hand: 2, par_level: 10 },
    ],
    suppliers: [
      sup("s-a", "Supplier A", {
        website_url: "https://supplier-a.example.test",
        payment_methods: ["credit_card"],
        payment_notes: NOTES[0],
        ordering_notes: NOTES[1],
        address_line1: "1 Example Way", city: "Testville", state: "DE", zip: "19700", country: "USA",
        default_po_payment_terms: "Net 30",
      }),
      sup("s-b", "Supplier B", { website_url: "https://supplier-b.example.test" }),
      sup("s-c", "Supplier C"),
    ],
    links: [
      rmLink("r1", "m1", "s-a", { is_preferred: true, price: "48.5", price_note: "per 25 kg bag", price_updated_at: "2026-11-03T15:00:00Z" }),
      rmLink("r2", "m2", "s-b", { is_preferred: true }),
    ],
    categories: [cat("c-prod", "Production", 1), cat("c-wh", "Warehouse", 2), cat("c-off", "Office", 3), cat("c-old", "Retired", 4, true)],
    equipment: [
      item("e10", "Scale 10", "c-prod"),
      item("e2", "Scale 2", "c-prod", { description: "Bench scale, <b>0.1 g</b>" }),
      item("ep", "pallet jack", "c-wh"),
      item("ed", "Desk", "c-off"),
      item("ex", "Old mixer", "c-prod", { archived_at: "2026-10-02T00:00:00Z" }),
    ],
    equipmentLinks: [
      eqLink("l1", "e2", "s-a", { is_preferred: true, product_url: "https://supplier-a.example.test/scale-2", supplier_item: "SC-2000", price: "1299.5", price_note: "each", price_updated_at: "2026-11-04T15:00:00Z", notes: NOTES[2] }),
      eqLink("l2", "e2", "s-b", { price: "1250" }),
      eqLink("l3", "e10", "s-b", { is_preferred: true }),
      eqLink("l4", "ep", "s-c", { is_preferred: true }),
      eqLink("l5", "ed", "s-a", { archived_at: "2026-10-01T00:00:00Z" }),
    ],
  };
}

describe("equipment rows", () => {
  const rows = buildEquipmentRows(data());
  const byId = (id: string) => rows.find((r) => r.item.id === id)!;

  it("sort alphabetically, case-insensitive, with natural number order; archived hidden unless asked", () => {
    expect(rows.map((r) => r.name)).toEqual(["Desk", "pallet jack", "Scale 2", "Scale 10"]);
    expect(buildEquipmentRows(data(), { includeArchived: true }).map((r) => r.name)).toEqual(["Desk", "Old mixer", "pallet jack", "Scale 2", "Scale 10"]);
    expect(["Scale 10", "scale 9", "Scale 1"].sort(naturalCompare)).toEqual(["Scale 1", "scale 9", "Scale 10"]);
  });

  it("listings: active only, preferred first", () => {
    expect(byId("e2").links.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(byId("ed").links).toEqual([]);
    expect(byId("e2").category?.name).toBe("Production");
  });

  it("Order button: product page, website fallback, disabled", () => {
    expect(orderTarget(byId("e2").preferred)).toMatchObject({ kind: "product", href: "https://supplier-a.example.test/scale-2" });
    expect(orderTarget(byId("e10").preferred)).toMatchObject({ kind: "website", label: "Website" });
    expect(orderTarget(byId("ep").preferred)).toMatchObject({ kind: "none", label: "No link yet" });
    expect(orderTarget(byId("ed").preferred)).toMatchObject({ kind: "none" });
  });

  it("Create PO needs a supplier", () => {
    expect(equipmentCreatePoBlocker(byId("ed"))).toBe("Add a supplier first");
    expect(equipmentCreatePoBlocker(byId("e2"))).toBeNull();
  });

  it("category filter, category counts (active items, active categories, in order)", () => {
    expect(filterEquipmentRows(rows, { ...NO_EQUIPMENT_FILTERS, categoryId: "c-prod" }).map((r) => r.name)).toEqual(["Scale 2", "Scale 10"]);
    expect(categoryCounts(data()).map((c) => [c.category.name, c.count])).toEqual([["Production", 2], ["Warehouse", 1], ["Office", 1]]);
  });

  it("No supplier yet and Missing price counts and filters, Missing supplier info, search", () => {
    expect(equipmentSummary(rows)).toEqual({ noSupplier: 1, missingPrice: 2 });
    const names = (f: Partial<typeof NO_EQUIPMENT_FILTERS>) => filterEquipmentRows(rows, { ...NO_EQUIPMENT_FILTERS, ...f }).map((r) => r.name);
    expect(names({ quick: "no_supplier" })).toEqual(["Desk"]);
    expect(names({ quick: "missing_price" })).toEqual(["pallet jack", "Scale 10"]);
    expect(names({ missingPrice: true })).toEqual(["pallet jack", "Scale 10"]);
    expect(names({ missingInfo: true })).toEqual(["Desk", "pallet jack"]);
    expect(names({ search: "supplier b" })).toEqual(["Scale 2", "Scale 10"]);
    expect(names({ search: "JACK" })).toEqual(["pallet jack"]);
  });

  it("supplier usage counts both kinds", () => {
    const d = data();
    expect(supplierUsage(d).get("s-a")).toBe(1);
    expect(supplierEquipmentUsage(d).get("s-a")).toBe(1);
    expect(supplierEquipmentUsage(d).get("s-b")).toBe(2);
    expect(usageText(1, 1)).toBe("Used for 1 ingredient and 1 equipment item");
    expect(usageText(3, 0)).toBe("Used for 3 ingredients and 0 equipment items");
    expect(supplierEquipment(rows, "s-b").map((x) => x.row.name)).toEqual(["Scale 2", "Scale 10"]);
  });
});

describe("raw materials prices", () => {
  const rows = buildMaterialRows(data());
  it("Missing price filter uses the preferred listing", () => {
    expect(rows.find((r) => r.material.id === "m1")?.missingPrice).toBe(false);
    expect(filterRows(rows, { ...NO_FILTERS, missingPrice: true }).map((r) => r.name)).toEqual(["Material B"]);
  });
  it("the table shows a Price column after Preferred supplier, with the update date on hover", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(ProcurementTable, {
        rows,
        expanded: new Set(["m1"]),
        handlers: { onToggle: noop, onAddSupplier: noop, onEditLink: noop, onEditSupplier: noop, onRemoveLink: noop, onMakePreferred: noop, onCreatePo: noop },
      }),
    );
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]).filter(Boolean);
    expect(headers.slice(0, 10)).toEqual(["Material", "On hand", "Par level", "Stock alert", "Preferred supplier", "Price", "Payment", "Ordering notes", "Order", "Create PO"]);
    expect(html).toContain('title="Price updated 11/3/2026"');
    expect(html).toContain("$48.50 per 25 kg bag");
    expect(html).toContain("COA"); // raw material subtable keeps COA
  });
});

describe("rendered Equipment table", () => {
  const noop = () => {};
  const handlers = { onToggle: noop, onEditItem: noop, onRestore: noop, onAddSupplier: noop, onEditLink: noop, onEditSupplier: noop, onRemoveLink: noop, onMakePreferred: noop, onCreatePo: noop };
  const rows = buildEquipmentRows(data(), { includeArchived: true });
  const html = renderToStaticMarkup(createElement(EquipmentTable, { rows, expanded: new Set(["e2"]), handlers }));

  it("has no quantity, par level or stock alert, and the expected columns", () => {
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]).filter(Boolean);
    expect(headers.slice(0, 8)).toEqual(["Equipment", "Category", "Preferred supplier", "Price", "Payment", "Ordering notes", "Order", "Create PO"]);
    for (const word of ["On hand", "Par level", "Stock alert", "Out of stock", "COA"]) expect(html).not.toContain(word);
  });

  it("rows in natural order, prices, badges and buttons", () => {
    const names = [...html.matchAll(/data-testid="equipment-name">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(["Desk", "Old mixer", "pallet jack", "Scale 2", "Scale 10"]);
    expect(html).toContain("$1,299.50 each");
    expect(html).toContain('title="Price updated 11/4/2026"');
    expect(html).toContain("No supplier yet");
    expect(html).toContain("Restore");
    expect(html).toContain('title="Add a supplier first"');
    expect(html).toContain('href="https://supplier-a.example.test/scale-2" target="_blank" rel="noopener noreferrer"');
  });

  it("the expanded subtable shows model, prices, dates and actions; text never becomes HTML", () => {
    expect(html).toContain('data-testid="subtable-e2"');
    expect(html.match(/data-testid="supplier-link-row"/g)?.length).toBe(2);
    expect(html).toContain("Model or part number");
    expect(html).toContain("SC-2000");
    expect(html).toContain("$1,250.00");
    expect(html).toContain("Price updated 11/4/2026");
    expect(html).toContain("Listing: ");
    expect(html).toContain("&lt;b&gt;0.1 g&lt;/b&gt;");
    expect(html).not.toContain("<b>0.1 g</b>");
  });
});

describe("tabs and back links", () => {
  it("tab URLs", () => {
    expect(procurementHref(null)).toBe("/inventory/procurement");
    expect(procurementHref("raw")).toBe("/inventory/procurement");
    expect(procurementHref("equipment")).toBe("/inventory/procurement?tab=equipment");
    expect(procurementHref("equipment", { equipment: "e2" })).toBe("/inventory/procurement?tab=equipment&equipment=e2");
    expect(procurementHref("nonsense")).toBe("/inventory/procurement");
  });
  it("renders two tabs with the active one selected", () => {
    const html = renderToStaticMarkup(createElement(ProcurementTabs, { tab: "equipment", onChange: () => {} }));
    expect(html).toMatch(/aria-selected="false"[^>]*data-testid="tab-raw"[^>]*>Raw Materials/);
    expect(html).toMatch(/aria-selected="true"[^>]*data-testid="tab-equipment"[^>]*>Equipment/);
  });
});

describe("equipment PO prefill", () => {
  const d = data();
  const supplierA = d.suppliers[0];
  const scale2 = d.equipment[1];
  const listing = d.equipmentLinks[0];

  it("one line: name, model as item number, quantity 1, unit each, unit price from the listing", () => {
    const p = buildEquipmentPoPrefill(supplierA, scale2, listing, { payment_terms: "Prepaid" });
    expect(p.lines).toEqual([{ item_number: "SC-2000", description: "Scale 2", quantity: "1", unit: "each", unit_price: "1299.5" }]);
    expect(p).toMatchObject({ vendor_name: "Supplier A", vendor_city: "Testville", payment_terms: "Net 30", warnings: [] });
  });

  it("blank item number and unit price when not set; form default terms; missing address warning", () => {
    const p = buildEquipmentPoPrefill(d.suppliers[1], scale2, { supplier_item: null, price: null }, { payment_terms: "Prepaid" });
    expect(p.lines[0]).toEqual({ item_number: "", description: "Scale 2", quantity: "1", unit: "each", unit_price: "" });
    expect(p.payment_terms).toBe("Prepaid");
    expect(p.warnings).toEqual([MISSING_ADDRESS_WARNING]);
  });

  it("never copies notes or the product link", () => {
    const text = JSON.stringify(buildEquipmentPoPrefill(supplierA, scale2, listing, { payment_terms: "" }));
    for (const n of NOTES) expect(text).not.toContain(n);
    expect(text).not.toContain("scale-2");
  });

  it("raw material prefill still leaves the unit price blank, even with a stored price", () => {
    const p = buildPoPrefill(supplierA, [{ material: d.materials[0], link: d.links[0] }], { payment_terms: "" });
    expect(d.links[0].price).toBe("48.5");
    expect(p.lines[0].unit_price).toBe("");
  });

  it("the Supplier info box shows the price, note and update date, and says it is not printed", () => {
    const info = buildEquipmentSupplierInfo(supplierA, scale2, listing);
    expect(info.prices).toEqual([{ label: "Scale 2", price: "1299.5", price_note: "each", price_updated_at: "2026-11-04T15:00:00Z" }]);
    expect(info.reference_label).toBe("Product page");
    const html = renderToStaticMarkup(createElement(SupplierInfoBox, { info }));
    expect(html).toContain("$1,299.50 each");
    expect(html).toContain("Price updated 11/4/2026");
    expect(html).toContain("For your reference only. This is not printed on the PO.");
  });

  it("puts only ids in the URL", () => {
    expect(newEquipmentPoHref("s-a", "e2")).toBe("/inventory/purchase-orders/new?supplier=s-a&equipment=e2");
  });
});
