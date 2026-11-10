// Procurement and Suppliers page logic, and the table rendered to HTML
// (no browser): shortages first, Order button states, "No supplier yet",
// filters and counts, the expanded subtable, and notes rendered as text.
// Invented suppliers and example.test addresses only.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NO_FILTERS,
  buildMaterialRows,
  createPoBlocker,
  filterRows,
  filterSuppliers,
  orderTarget,
  shortageGroups,
  summaryCounts,
  supplierMaterials,
  supplierShortageMaterialIds,
  supplierUsage,
} from "@/lib/procurement/view";
import { ProcurementTable, SupplierInfoBox } from "@/components/procurement/ProcurementUi";
import type { ProcurementData, RawMaterial, Supplier, SupplierLink } from "@/lib/procurement/types";

const sup = (id: string, name: string, over: Partial<Supplier> = {}): Supplier => ({
  id, name, website_url: null, contact_name: null, contact_email: null, contact_phone: null, account_number: null,
  payment_methods: [], payment_notes: null, ordering_notes: null, address_line1: null, address_line2: null, city: null,
  state: null, zip: null, country: null, default_po_payment_terms: null, archived_at: null,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", updated_by_name: null, ...over,
});
const mat = (id: string, name: string, on: number, par: number | null, unit = "kg"): RawMaterial => ({ id, name, unit, quantity_on_hand: on, par_level: par });
const link = (id: string, raw: string, supplier: string, over: Partial<SupplierLink> = {}): SupplierLink => ({
  id, raw_material_id: raw, supplier_id: supplier, is_preferred: false, product_url: null, supplier_item: null, pack_info: null,
  coa_policy: "unknown", notes: null, link_updated_at: null, archived_at: null, created_at: "", updated_at: "", ...over,
});

function data(): ProcurementData {
  return {
    materials: [
      mat("m-ok", "Basil", 20, 10),
      mat("m-out", "Clove", 0, 5),
      mat("m-below", "Anise", 2, 10),
      mat("m-nopar", "Dill", 3, null),
      mat("m-nosup", "Fennel", 0, 50),
      mat("m-web", "Ginger", 1, 4),
      mat("m-arch", "Hops", 1, 2),
    ],
    suppliers: [
      sup("s-a", "Supplier A", { website_url: "https://supplier-a.example.test", payment_methods: ["credit_card"], ordering_notes: "Order <b>before</b> noon <script>alert(1)</script>" }),
      sup("s-b", "Supplier B", { website_url: "https://supplier-b.example.test" }),
      sup("s-c", "Supplier C"),
      sup("s-old", "Supplier Old", { archived_at: "2026-10-01T00:00:00Z" }),
    ],
    links: [
      link("l1", "m-out", "s-a", { is_preferred: true, product_url: "https://supplier-a.example.test/clove", notes: "<img src=x onerror=alert(1)>", link_updated_at: "2026-11-02T03:30:00Z" }),
      link("l2", "m-out", "s-b"),
      link("l3", "m-below", "s-a", { is_preferred: true, product_url: "https://supplier-a.example.test/anise" }),
      link("l4", "m-web", "s-b", { is_preferred: true }),
      link("l5", "m-ok", "s-c", { is_preferred: true }),
      link("l6", "m-nopar", "s-a"), // has a supplier but none preferred
      link("l7", "m-arch", "s-a", { is_preferred: false, archived_at: "2026-10-05T00:00:00Z" }),
    ],
  };
}

describe("rows", () => {
  const rows = buildMaterialRows(data());
  const byId = (id: string) => rows.find((r) => r.material.id === id)!;

  it("sorts shortages first (out by par, then below by ratio, then ok, then no par)", () => {
    expect(rows.map((r) => r.name)).toEqual(["Fennel", "Clove", "Anise", "Ginger", "Hops", "Basil", "Dill"]);
  });

  it("lists active links only, preferred first", () => {
    expect(byId("m-out").links.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(byId("m-arch").links).toEqual([]);
    expect(byId("m-out").preferred?.supplier.name).toBe("Supplier A");
  });

  it("Order button: product link, website fallback, or disabled", () => {
    expect(orderTarget(byId("m-out").preferred)).toMatchObject({ kind: "product", label: "Order", href: "https://supplier-a.example.test/clove" });
    expect(orderTarget(byId("m-web").preferred)).toMatchObject({ kind: "website", label: "Website", href: "https://supplier-b.example.test" });
    expect(orderTarget(byId("m-ok").preferred)).toMatchObject({ kind: "none", label: "No link yet" });
    expect(orderTarget(byId("m-nosup").preferred)).toMatchObject({ kind: "none", label: "No link yet" });
    expect(orderTarget(byId("m-out").preferred).title).toContain("Supplier A");
  });

  it("Create PO needs a supplier, and a preferred one", () => {
    expect(createPoBlocker(byId("m-nosup"))).toBe("Add a supplier first");
    expect(createPoBlocker(byId("m-nopar"))).toBe("Choose a preferred supplier first");
    expect(createPoBlocker(byId("m-out"))).toBeNull();
  });

  it("counts and filters", () => {
    expect(summaryCounts(rows)).toEqual({ out: 2, below: 3, noSupplier: 2 });
    const names = (f: Partial<typeof NO_FILTERS>) => filterRows(rows, { ...NO_FILTERS, ...f }).map((r) => r.name);
    expect(names({ quick: "out" })).toEqual(["Fennel", "Clove"]);
    expect(names({ quick: "below" })).toEqual(["Anise", "Ginger", "Hops"]);
    expect(names({ quick: "no_supplier" })).toEqual(["Fennel", "Hops"]);
    expect(names({ shortagesOnly: true })).toEqual(["Fennel", "Clove", "Anise", "Ginger", "Hops"]);
    expect(names({ missingInfo: true })).toEqual(["Fennel", "Hops", "Basil", "Dill"]);
    expect(names({ search: "supplier b" })).toEqual(["Clove", "Ginger"]);
    expect(names({ search: "ANI" })).toEqual(["Anise"]);
  });

  it("shortage groups: one per preferred supplier; the rest under no supplier", () => {
    const { groups, noSupplier } = shortageGroups(rows);
    expect(groups.map((g) => [g.supplier.name, g.items.map((i) => [i.row.name, i.suggested])])).toEqual([
      ["Supplier A", [["Clove", "5"], ["Anise", "8"]]],
      ["Supplier B", [["Ginger", "3"]]],
    ]);
    expect(noSupplier.map((r) => r.name)).toEqual(["Fennel", "Hops"]);
  });

  it("Suppliers page: Create PO lines, usage counts, ingredients and search", () => {
    expect(supplierShortageMaterialIds(rows, "s-a")).toEqual(["m-out", "m-below"]);
    expect(supplierShortageMaterialIds(rows, "s-c")).toEqual([]);
    const usage = supplierUsage(data());
    expect(usage.get("s-a")).toBe(3);
    expect(usage.get("s-b")).toBe(2);
    expect(supplierMaterials(rows, "s-a").map((x) => x.row.name)).toEqual(["Anise", "Clove", "Dill"]);
    expect(filterSuppliers(data().suppliers, "", false).map((s) => s.name)).toEqual(["Supplier A", "Supplier B", "Supplier C"]);
    expect(filterSuppliers(data().suppliers, "old", true).map((s) => s.name)).toEqual(["Supplier Old"]);
  });
});

describe("rendered table", () => {
  const noop = () => {};
  const handlers = { onToggle: noop, onAddSupplier: noop, onEditLink: noop, onEditSupplier: noop, onRemoveLink: noop, onMakePreferred: noop, onCreatePo: noop };
  const rows = buildMaterialRows(data());
  const html = renderToStaticMarkup(createElement(ProcurementTable, { rows, expanded: new Set(["m-out"]), handlers }));

  it("rows appear shortages first", () => {
    const order = [...html.matchAll(/data-testid="material-name">([^<]+)</g)].map((m) => m[1]);
    expect(order).toEqual(["Fennel", "Clove", "Anise", "Ginger", "Hops", "Basil", "Dill"]);
  });

  it("Order buttons open in a new tab safely, or are disabled", () => {
    expect(html).toContain('href="https://supplier-a.example.test/clove" target="_blank" rel="noopener noreferrer"');
    expect(html).toMatch(/data-kind="website"[^>]*>Website<\/a>|href="https:\/\/supplier-b\.example\.test" target="_blank" rel="noopener noreferrer"[^>]*data-kind="website"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="order-button" data-kind="none">No link yet<\/button>/);
  });

  it("No supplier yet badge, Add supplier and the disabled Create PO", () => {
    expect(html.match(/No supplier yet/g)?.length).toBe(2);
    expect(html).toContain('title="Add a supplier first"');
  });

  it("the expanded subtable lists the suppliers with their actions and link date (New York time)", () => {
    expect(html).toContain('data-testid="subtable-m-out"');
    expect(html.match(/data-testid="supplier-link-row"/g)?.length).toBe(2);
    expect(html).toContain("Link updated 11/1/2026");
    expect(html).toContain("Product page");
    expect(html).toContain("Remove");
    expect(html).toContain("+ Add supplier");
    expect(html).not.toContain('data-testid="subtable-m-below"');
  });

  it("notes and names are text, never HTML", () => {
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>before</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("the Supplier info box says it is not printed, and escapes notes", () => {
    const box = renderToStaticMarkup(
      createElement(SupplierInfoBox, {
        info: {
          name: "Supplier A", contact_name: "Pat", contact_email: "orders@supplier-a.example.test", contact_phone: "555-0100",
          payment_methods: ["credit_card"], payment_notes: "<i>x</i>", ordering_notes: "Call first", reference_url: "https://supplier-a.example.test", reference_label: "Website",
        },
      }),
    );
    expect(box).toContain("For your reference only. This is not printed on the PO.");
    expect(box).toContain("mailto:orders@supplier-a.example.test");
    expect(box).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(box).toContain('target="_blank" rel="noopener noreferrer"');
  });
});
