// buildPoPrefill: what a new Purchase Order starts with when opened from
// Procurement. Invented suppliers and example.test addresses only.
import { describe, expect, it } from "vitest";
import {
  MISSING_ADDRESS_WARNING,
  applyPrefillToDraft,
  buildPoPrefill,
  buildSupplierInfo,
  mapUnit,
  newPoHref,
  type PrefillItem,
} from "@/lib/procurement/poPrefill";
import { EMPTY_PO_LINE } from "@/lib/purchaseOrders";
import type { RawMaterial, Supplier, SupplierLink } from "@/lib/procurement/types";

const SECRET_NOTES = ["PAYNOTE-call before paying", "ORDERNOTE-order before noon", "LINKNOTE-ask for the bulk tier"];

function supplier(over: Partial<Supplier> = {}): Supplier {
  return {
    id: "s1",
    name: "Supplier A",
    website_url: "https://supplier-a.example.test",
    contact_name: "Pat Example",
    contact_email: "orders@supplier-a.example.test",
    contact_phone: "555-0100",
    account_number: "ACCT-1",
    payment_methods: ["credit_card", "po_required"],
    payment_notes: SECRET_NOTES[0],
    ordering_notes: SECRET_NOTES[1],
    address_line1: "1 Example Way",
    address_line2: "Suite 2",
    city: "Testville",
    state: "DE",
    zip: "19700",
    country: "USA",
    default_po_payment_terms: null,
    archived_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    updated_by_name: "Test Person",
    ...over,
  };
}
const mat = (id: string, over: Partial<RawMaterial> = {}): RawMaterial => ({ id, name: `Material ${id}`, unit: "kg", quantity_on_hand: 2, par_level: 10, ...over });
const lnk = (rawId: string, over: Partial<SupplierLink> = {}): SupplierLink => ({
  id: `l-${rawId}`,
  raw_material_id: rawId,
  supplier_id: "s1",
  is_preferred: true,
  product_url: `https://supplier-a.example.test/p/${rawId}`,
  supplier_item: null,
  pack_info: "25 kg bag",
  coa_policy: "request",
  notes: SECRET_NOTES[2],
  link_updated_at: null,
  price: null,
  price_note: null,
  price_updated_at: null,
  archived_at: null,
  created_at: "",
  updated_at: "",
  ...over,
});
const item = (id: string, m: Partial<RawMaterial> = {}, l: Partial<SupplierLink> = {}): PrefillItem => ({ material: mat(id, m), link: lnk(id, l) });

describe("buildPoPrefill", () => {
  it("copies the supplier's vendor fields", () => {
    const p = buildPoPrefill(supplier(), [item("1")], { payment_terms: "Net 30" });
    expect(p).toMatchObject({
      vendor_name: "Supplier A",
      vendor_contact_name: "Pat Example",
      vendor_email: "orders@supplier-a.example.test",
      vendor_phone: "555-0100",
      vendor_account_number: "ACCT-1",
      vendor_address_line1: "1 Example Way",
      vendor_address_line2: "Suite 2",
      vendor_city: "Testville",
      vendor_state: "DE",
      vendor_zip: "19700",
      vendor_country: "USA",
    });
    expect(p.warnings).toEqual([]);
  });

  it("leaves missing vendor fields blank", () => {
    const p = buildPoPrefill(supplier({ contact_name: null, contact_email: null, account_number: null, address_line2: null }), [], { payment_terms: "" });
    expect(p.vendor_contact_name).toBe("");
    expect(p.vendor_email).toBe("");
    expect(p.vendor_account_number).toBe("");
    expect(p.vendor_address_line2).toBe("");
  });

  it("payment terms: the supplier's default, otherwise the form's normal default", () => {
    expect(buildPoPrefill(supplier({ default_po_payment_terms: "Prepaid" }), [], { payment_terms: "Net 30" }).payment_terms).toBe("Prepaid");
    expect(buildPoPrefill(supplier(), [], { payment_terms: "Net 30" }).payment_terms).toBe("Net 30");
  });

  it("one line per ingredient, in order: supplier item or material name, suggested quantity, mapped unit, blank price and item number", () => {
    const p = buildPoPrefill(
      supplier(),
      [item("1", { quantity_on_hand: 0, par_level: 25, unit: "Kilograms" }, { supplier_item: "Organic thing, 25 kg" }), item("2", { quantity_on_hand: "1.25", par_level: 2, unit: "lbs" }), item("3", { unit: "ML" })],
      { payment_terms: "" },
    );
    expect(p.lines).toEqual([
      { item_number: "", description: "Organic thing, 25 kg", quantity: "25", unit: "kg", unit_price: "" },
      { item_number: "", description: "Material 2", quantity: "0.75", unit: "lb", unit_price: "" },
      { item_number: "", description: "Material 3", quantity: "8", unit: "mL", unit_price: "" },
    ]);
  });

  it("blank quantity when there is no par (or nothing to order)", () => {
    const p = buildPoPrefill(supplier(), [item("1", { par_level: null }), item("2", { quantity_on_hand: 20, par_level: 10 })], { payment_terms: "" });
    expect(p.lines.map((l) => l.quantity)).toEqual(["", ""]);
  });

  it("an unknown unit is kept as typed (the PO form's free-text Other)", () => {
    const p = buildPoPrefill(supplier(), [item("1", { unit: "drum (55 gal)" }), item("2", { unit: "" })], { payment_terms: "" });
    expect(p.lines[0].unit).toBe("drum (55 gal)");
    expect(p.lines[1].unit).toBe("");
    expect(p.unmatched_units).toEqual(["drum (55 gal)"]);
  });

  it("caps at 100 lines with a warning", () => {
    const items = Array.from({ length: 103 }, (_, i) => item(String(i)));
    const p = buildPoPrefill(supplier(), items, { payment_terms: "" });
    expect(p.lines).toHaveLength(100);
    expect(p.lines[99].description).toBe("Material 99");
    expect(p.warnings).toContain("3 ingredients were not added");
    expect(buildPoPrefill(supplier(), Array.from({ length: 101 }, (_, i) => item(String(i))), { payment_terms: "" }).warnings).toContain("1 ingredient was not added");
  });

  it("warns when the address is incomplete", () => {
    for (const k of ["address_line1", "city", "state", "zip", "country"] as const) {
      expect(buildPoPrefill(supplier({ [k]: " " }), [], { payment_terms: "" }).warnings).toEqual([MISSING_ADDRESS_WARNING]);
    }
    expect(buildPoPrefill(supplier({ address_line2: null }), [], { payment_terms: "" }).warnings).toEqual([]);
  });

  it("never copies notes or the product link into any PO field", () => {
    const p = buildPoPrefill(supplier(), [item("1"), item("2", {}, { supplier_item: "Thing" })], { payment_terms: "" });
    const draft = applyPrefillToDraft(
      { ...p, special_instructions: "", terms_text: "", notes_to_vendor: "", internal_notes: "", reference_number: "" },
      p,
      EMPTY_PO_LINE,
    );
    const all = JSON.stringify({ p, draft });
    for (const n of SECRET_NOTES) expect(all).not.toContain(n);
    expect(all).not.toContain("/p/1");
    expect(draft.special_instructions).toBe("");
    expect(draft.notes_to_vendor).toBe("");
    expect(draft.terms_text).toBe("");
    expect(draft.internal_notes).toBe("");
  });
});

describe("applyPrefillToDraft", () => {
  const base = {
    company_profile_id: "profile-1",
    payment_terms: "Net 60",
    shipping_method: "LTL freight",
    lines: [{ ...EMPTY_PO_LINE }],
    vendor_name: "",
    vendor_contact_name: "",
    vendor_email: "",
    vendor_phone: "",
    vendor_account_number: "",
    vendor_address_line1: "",
    vendor_address_line2: "",
    vendor_city: "",
    vendor_state: "",
    vendor_zip: "",
    vendor_country: "",
  };
  it("keeps the business and its defaults, fills vendor and lines, and uses the supplier's terms only when set", () => {
    const p = buildPoPrefill(supplier(), [item("1")], { payment_terms: "" });
    const d = applyPrefillToDraft(base, p, EMPTY_PO_LINE);
    expect(d.company_profile_id).toBe("profile-1");
    expect(d.shipping_method).toBe("LTL freight");
    expect(d.payment_terms).toBe("Net 60");
    expect(d.vendor_name).toBe("Supplier A");
    expect(d.lines).toHaveLength(1);
    expect(applyPrefillToDraft(base, buildPoPrefill(supplier({ default_po_payment_terms: "Prepaid" }), [], { payment_terms: "" }), EMPTY_PO_LINE).payment_terms).toBe("Prepaid");
  });
  it("no ingredients leaves one empty line, like a new PO", () => {
    const d = applyPrefillToDraft(base, buildPoPrefill(supplier(), [], { payment_terms: "" }), EMPTY_PO_LINE);
    expect(d.lines).toEqual([EMPTY_PO_LINE]);
  });
});

describe("mapUnit", () => {
  it("maps common spellings case-insensitively", () => {
    expect(mapUnit("G").unit).toBe("g");
    expect(mapUnit(" grams ").unit).toBe("g");
    expect(mapUnit("KG").unit).toBe("kg");
    expect(mapUnit("Pounds").unit).toBe("lb");
    expect(mapUnit("oz").unit).toBe("oz");
    expect(mapUnit("Fl Oz").unit).toBe("fl oz");
    expect(mapUnit("l").unit).toBe("L");
    expect(mapUnit("Liters").unit).toBe("L");
    expect(mapUnit("ml").unit).toBe("mL");
    expect(mapUnit("ea").unit).toBe("each");
    expect(mapUnit("pcs").unit).toBe("each");
  });
  it("keeps unknown units as typed", () => {
    expect(mapUnit("tote")).toEqual({ unit: "tote", matched: false });
    expect(mapUnit(null)).toEqual({ unit: "", matched: false });
  });
});

describe("buildSupplierInfo and newPoHref", () => {
  it("the info box shows contact, payment and notes, with the product page for one ingredient, else the website", () => {
    const one = buildSupplierInfo(supplier(), [item("1")]);
    expect(one).toMatchObject({ name: "Supplier A", payment_notes: SECRET_NOTES[0], ordering_notes: SECRET_NOTES[1], reference_label: "Product page" });
    expect(one.reference_url).toBe("https://supplier-a.example.test/p/1");
    const many = buildSupplierInfo(supplier(), [item("1"), item("2")]);
    expect(many).toMatchObject({ reference_label: "Website", reference_url: "https://supplier-a.example.test" });
    expect(buildSupplierInfo(supplier({ website_url: null }), []).reference_url).toBeNull();
  });
  it("puts only ids in the URL", () => {
    expect(newPoHref("s1", ["m1", "m2"])).toBe("/inventory/purchase-orders/new?supplier=s1&materials=m1%2Cm2");
    expect(newPoHref("s1", [])).toBe("/inventory/purchase-orders/new?supplier=s1");
  });
});
