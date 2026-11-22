// Supplier lead times on raw material listings: validation, the Raw
// Materials "Lead time" column (preferred supplier), the Missing lead time
// filter and the subtable. Equipment listings are unchanged. Invented
// suppliers ("Supplier A") and example.test addresses only.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_LINK, LEAD_TIME_HINT, parseLeadTimeDays, validateEquipmentLink, validateLink } from "@/lib/procurement/validation";
import { NO_FILTERS, buildMaterialRows, filterRows } from "@/lib/procurement/view";
import { ProcurementTable } from "@/components/procurement/ProcurementUi";
import type { ProcurementData, Supplier, SupplierLink } from "@/lib/procurement/types";

const supplier = (id: string, name: string): Supplier =>
  ({
    id, name, website_url: `https://${id}.example.test`, contact_name: null, contact_email: null, contact_phone: null, account_number: null,
    payment_methods: [], payment_notes: null, ordering_notes: null, address_line1: null, address_line2: null, city: null, state: null, zip: null,
    country: null, default_po_payment_terms: null, is_pinned: false, archived_at: null, created_at: "", updated_at: "", updated_by_name: null,
  }) as Supplier;
const link = (id: string, raw: string, sup: string, over: Partial<SupplierLink> = {}): SupplierLink => ({
  id, raw_material_id: raw, supplier_id: sup, is_preferred: false, product_url: null, supplier_item: null, pack_info: null, coa_policy: "unknown",
  notes: null, link_updated_at: null, price: null, price_note: null, price_updated_at: null, lead_time_days: null, lead_time_note: null,
  archived_at: null, created_at: "", updated_at: "", ...over,
});
const data = (): ProcurementData =>
  ({
    materials: [
      { id: "m1", name: "Material A", unit: "kg", quantity_on_hand: 1, par_level: 10 },
      { id: "m2", name: "Material B", unit: "kg", quantity_on_hand: 20, par_level: 10 },
      { id: "m3", name: "Material C", unit: "g", quantity_on_hand: 0, par_level: 5 },
    ],
    suppliers: [supplier("sa", "Supplier A"), supplier("sb", "Supplier B")],
    links: [
      link("l1", "m1", "sa", { is_preferred: true, lead_time_days: 14, lead_time_note: "Longer in summer" }),
      link("l2", "m1", "sb", { lead_time_days: 3 }),
      link("l3", "m2", "sb", { is_preferred: true, lead_time_days: null }),
      link("l4", "m2", "sa", { lead_time_days: 1 }),
    ],
    categories: [],
    equipment: [],
    equipmentLinks: [],
  }) as unknown as ProcurementData;

describe("validation", () => {
  it("blank is unknown; whole days 0 to 365 only", () => {
    expect(parseLeadTimeDays("")).toEqual({ ok: true, value: null });
    expect(parseLeadTimeDays(null)).toEqual({ ok: true, value: null });
    expect(parseLeadTimeDays(" 0 ")).toEqual({ ok: true, value: 0 });
    expect(parseLeadTimeDays("365")).toEqual({ ok: true, value: 365 });
    expect(parseLeadTimeDays(14)).toEqual({ ok: true, value: 14 });
    for (const bad of ["366", "-1", "2.5", "two weeks", "1e2"]) expect(parseLeadTimeDays(bad).ok, bad).toBe(false);
    expect(LEAD_TIME_HINT).toBe("Typical days from placing the order to it arriving");
  });

  it("the listing keeps both fields; note length and card numbers are checked", () => {
    const ok = validateLink({ ...EMPTY_LINK, lead_time_days: "21", lead_time_note: "Ships from overseas" });
    expect(ok).toEqual({ ok: true, value: expect.objectContaining({ lead_time_days: 21, lead_time_note: "Ships from overseas" }) });
    const blank = validateLink({ ...EMPTY_LINK, lead_time_days: "" });
    expect(blank.ok && blank.value.lead_time_days).toBeNull();
    const bad = validateLink({ ...EMPTY_LINK, lead_time_days: "400", lead_time_note: "x".repeat(201) });
    expect(bad.ok ? {} : bad.errors).toEqual({ lead_time_days: "Enter whole days from 0 to 365.", lead_time_note: "Keep this under 200 characters." });
    const card = validateLink({ ...EMPTY_LINK, lead_time_note: "4111 1111 1111 1111" });
    expect(card.ok ? {} : card.errors).toHaveProperty("lead_time_note");
  });

  it("equipment listings have no lead time", () => {
    const r = validateEquipmentLink({ product_url: null, supplier_item: null, price: null, price_note: null, notes: null, lead_time_days: "5" });
    expect(r.ok && "lead_time_days" in r.value).toBe(false);
  });
});

describe("Raw Materials tab", () => {
  const rows = buildMaterialRows(data());
  it("Missing lead time: rows whose preferred listing has none", () => {
    expect(rows.map((r) => [r.name, r.missingLeadTime])).toEqual(
      expect.arrayContaining([["Material A", false], ["Material B", true], ["Material C", false]]),
    );
    expect(filterRows(rows, { ...NO_FILTERS, missingLeadTime: true }).map((r) => r.name)).toEqual(["Material B"]);
  });

  it("shows the preferred supplier's lead time in a Lead time column, and both fields in the subtable", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(ProcurementTable, {
        rows,
        expanded: new Set(["m1"]),
        handlers: { onToggle: noop, onAddSupplier: noop, onEditLink: noop, onEditSupplier: noop, onRemoveLink: noop, onMakePreferred: noop, onCreatePo: noop },
      }),
    );
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]).filter(Boolean);
    expect(headers.indexOf("Lead time")).toBe(headers.indexOf("Price") + 1);
    const cells = [...html.matchAll(/data-testid="row-lead-time"[^>]*>([^<]*)</g)].map((m) => m[1]);
    const byName = Object.fromEntries(rows.map((r, i) => [r.name, cells[i]]));
    expect(byName).toEqual({ "Material A": "14 days", "Material B": "No lead time", "Material C": "—" });
    expect(html).toContain('title="Longer in summer"');
    // Subtable (Material A expanded): both listings with their lead times.
    expect(html).toContain("Lead time: 14 days");
    expect(html).toContain("Lead time: 3 days");
    expect(html).toContain("Longer in summer</div>");
  });
});
