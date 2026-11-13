// Procurement server code (src/lib/procurement/service.ts) against the real
// migration SQL in PGlite: add, edit, make preferred, remove, archive
// supplier, and the PO prefill (ids only; unknown, archived and mismatched
// ids rejected). Invented suppliers and example.test addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  ProcurementError,
  addLink,
  archiveLink,
  archiveSupplier,
  createSupplier,
  loadPoPrefill,
  loadProcurementData,
  makePreferred,
  updateLink,
  updateSupplier,
  type Db,
} from "@/lib/procurement/service";

let pg: PGlite;
let db: Db;

const rejects = async (fn: () => Promise<unknown>, re: RegExp, status?: number) => {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected an error").toBeInstanceOf(ProcurementError);
  expect((err as Error).message).toMatch(re);
  if (status) expect((err as ProcurementError).status).toBe(status);
  return err as ProcurementError;
};

async function material(name: string, on: number, par: number | null, unit = "kg") {
  return (await pg.query<{ id: string }>(`insert into inventory_items (name, unit, par_level, quantity_on_hand) values ($1, $2, $3, $4) returning id`, [name, unit, par, on])).rows[0].id;
}
const supplierA = {
  name: "Supplier A",
  website_url: "https://supplier-a.example.test",
  contact_name: "Pat Example",
  contact_email: "orders@supplier-a.example.test",
  contact_phone: "555-0100",
  payment_methods: ["credit_card", "po_required"],
  payment_notes: "Card on file, call first",
  ordering_notes: "Order before noon",
  address_line1: "1 Example Way",
  city: "Testville",
  state: "DE",
  zip: "19700",
  country: "USA",
  default_po_payment_terms: "Net 30",
};

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(migration("procurement_suppliers.sql"));
  await pg.exec(migration("procurement_equipment_prices.sql"));
  db = pgliteSupabase(pg) as unknown as Db;
});

describe("suppliers", () => {
  it("creates, validates on the server, and refuses duplicate names", async () => {
    const s = await createSupplier(db, supplierA, "Test Person");
    expect(s.name).toBe("Supplier A");
    expect(s.payment_methods).toEqual(["credit_card", "po_required"]);
    expect(s.updated_by_name).toBe("Test Person");
    const dup = await rejects(() => createSupplier(db, { name: " supplier a " }, null), /already exists/, 409);
    expect(dup.fields?.name).toBeTruthy();
    const bad = await rejects(() => createSupplier(db, { name: "Supplier B", website_url: "javascript:alert(1)", contact_email: "nope" }, null), /not valid/, 400);
    expect(Object.keys(bad.fields ?? {}).sort()).toEqual(["contact_email", "website_url"]);
    await rejects(() => createSupplier(db, { name: "Supplier C", payment_notes: "card 4111 1111 1111 1111" }, null), /not valid/);
  });

  it("updates shared details and archives with its links", async () => {
    const m1 = await material("Material One", 0, 10);
    const s = await createSupplier(db, supplierA, null);
    await addLink(db, { raw_material_id: m1, supplier_id: s.id, link: {} }, null);
    const u = await updateSupplier(db, s.id, { ...supplierA, ordering_notes: "Order by 11am" }, "Test Person");
    expect(u.ordering_notes).toBe("Order by 11am");
    expect(await archiveSupplier(db, s.id, "Test Person")).toEqual({ archivedLinks: 1, archivedEquipmentLinks: 0 });
    await rejects(() => updateSupplier(db, s.id, supplierA, null), /archived/);
    await rejects(() => archiveSupplier(db, "not-a-uuid", null), /Unknown supplier/, 404);
  });
});

describe("links", () => {
  it("add with a new supplier (first becomes preferred), add an existing one, make preferred, edit, remove", async () => {
    const m = await material("Material One", 2, 10);
    const first = await addLink(db, { raw_material_id: m, new_supplier: supplierA, link: { product_url: "https://supplier-a.example.test/p/1", coa_policy: "request" } }, "Test Person");
    expect(first.is_preferred).toBe(true);
    expect(first.link_updated_at).not.toBeNull();

    const b = await createSupplier(db, { name: "Supplier B" }, null);
    const second = await addLink(db, { raw_material_id: m, supplier_id: b.id, link: { supplier_item: "B item" } }, null);
    expect(second.is_preferred).toBe(false);
    await rejects(() => addLink(db, { raw_material_id: m, supplier_id: b.id, link: {} }, null), /already listed/, 409);

    await makePreferred(db, second.id);
    let data = await loadProcurementData(db);
    expect(data.links.filter((l) => l.is_preferred).map((l) => l.id)).toEqual([second.id]);

    const edited = await updateLink(db, first.id, { link: { product_url: "https://supplier-a.example.test/p/1", notes: "Ask for bulk" }, make_preferred: true }, null);
    expect(edited.is_preferred).toBe(true);
    data = await loadProcurementData(db);
    expect(data.links.find((l) => l.id === second.id)?.is_preferred).toBe(false);
    expect(data.links.find((l) => l.id === first.id)?.notes).toBe("Ask for bulk");

    await archiveLink(db, first.id);
    data = await loadProcurementData(db);
    expect(data.links.map((l) => l.id)).toEqual([second.id]);
    expect(data.links[0].is_preferred).toBe(false); // nobody promoted
    await rejects(() => archiveLink(db, first.id), /removed/);
    await rejects(() => makePreferred(db, first.id), /removed/);
  });

  it("editing a link can change the supplier's shared details", async () => {
    const m = await material("Material One", 2, 10);
    const l = await addLink(db, { raw_material_id: m, new_supplier: supplierA, link: {} }, null);
    await updateLink(db, l.id, { link: {}, supplier: { ...supplierA, contact_phone: "555-0199" } }, "Test Person");
    const data = await loadProcurementData(db);
    expect(data.suppliers[0].contact_phone).toBe("555-0199");
  });

  it("rejects bad links, unknown materials and archived suppliers", async () => {
    const m = await material("Material One", 2, 10);
    const s = await createSupplier(db, supplierA, null);
    const bad = await rejects(() => addLink(db, { raw_material_id: m, supplier_id: s.id, link: { product_url: "ftp://x.example.test", coa_policy: "maybe" } }, null), /not valid/);
    expect(Object.keys(bad.fields ?? {}).sort()).toEqual(["coa_policy", "product_url"]);
    await rejects(() => addLink(db, { raw_material_id: "00000000-0000-4000-8000-000000000000", supplier_id: s.id, link: {} }, null), /Unknown raw material/, 404);
    await archiveSupplier(db, s.id, null);
    await rejects(() => addLink(db, { raw_material_id: m, supplier_id: s.id, link: {} }, null), /archived/);
  });
});

describe("PO prefill", () => {
  it("loads by id and builds the prefill; notes and links stay out of the PO fields", async () => {
    const m1 = await material("Material One", 0, 25, "Kilograms");
    const m2 = await material("Material Two", 1.5, 2, "tote");
    const l1 = await addLink(db, { raw_material_id: m1, new_supplier: supplierA, link: { supplier_item: "Item One 25 kg", product_url: "https://supplier-a.example.test/p/1", notes: "Bulk tier" } }, null);
    await addLink(db, { raw_material_id: m2, supplier_id: l1.supplier_id, link: {} }, null);
    const r = await loadPoPrefill(db, l1.supplier_id, [m1, m2, m1]);
    expect(r.prefill).toMatchObject({ vendor_name: "Supplier A", vendor_city: "Testville", payment_terms: "Net 30", warnings: [] });
    expect(r.prefill.lines).toEqual([
      { item_number: "", description: "Item One 25 kg", quantity: "25", unit: "kg", unit_price: "" },
      { item_number: "", description: "Material Two", quantity: "0.5", unit: "tote", unit_price: "" },
    ]);
    const prefillText = JSON.stringify(r.prefill);
    for (const secret of ["Card on file", "Order before noon", "Bulk tier", "/p/1"]) expect(prefillText).not.toContain(secret);
    expect(r.supplierInfo).toMatchObject({ ordering_notes: "Order before noon", payment_notes: "Card on file, call first", reference_label: "Website" });
  });

  it("a supplier with no ingredients opens with no lines", async () => {
    const s = await createSupplier(db, { name: "Supplier B" }, null);
    const r = await loadPoPrefill(db, s.id, []);
    expect(r.prefill.lines).toEqual([]);
    expect(r.prefill.warnings).toEqual(["This supplier has no address saved. Add it on the Suppliers page so it prefills next time."]);
  });

  it("rejects unknown, archived and mismatched ids", async () => {
    const m1 = await material("Material One", 0, 10);
    const m2 = await material("Material Two", 0, 10);
    const a = await createSupplier(db, supplierA, null);
    const b = await createSupplier(db, { name: "Supplier B" }, null);
    const link = await addLink(db, { raw_material_id: m1, supplier_id: a.id, link: {} }, null);
    await addLink(db, { raw_material_id: m2, supplier_id: b.id, link: {} }, null);

    await rejects(() => loadPoPrefill(db, "00000000-0000-4000-8000-000000000000", [m1]), /Unknown supplier/, 404);
    await rejects(() => loadPoPrefill(db, "Supplier A", [m1]), /Unknown supplier/, 404);
    await rejects(() => loadPoPrefill(db, a.id, ["00000000-0000-4000-8000-000000000000"]), /Unknown raw material/, 404);
    await rejects(() => loadPoPrefill(db, a.id, ["drop table"]), /Unknown raw material/, 404);
    await rejects(() => loadPoPrefill(db, a.id, "not-a-list"), /Unknown raw material/, 404);
    await rejects(() => loadPoPrefill(db, a.id, [m2]), /not listed as a supplier/, 400);

    await archiveLink(db, link.id);
    await rejects(() => loadPoPrefill(db, a.id, [m1]), /not listed as a supplier/, 400);
    await archiveSupplier(db, b.id, null);
    await rejects(() => loadPoPrefill(db, b.id, [m2]), /archived/, 400);
  });

  it("nothing is written: no PO and no PO number is used", async () => {
    const m1 = await material("Material One", 0, 10);
    const l = await addLink(db, { raw_material_id: m1, new_supplier: supplierA, link: {} }, null);
    const before = (await pg.query<{ n: number }>(`select (select count(*) from purchase_orders)::int + (select coalesce(sum(last_number), 0) from po_counters)::int n`)).rows[0].n;
    await loadPoPrefill(db, l.supplier_id, [m1]);
    const after = (await pg.query<{ n: number }>(`select (select count(*) from purchase_orders)::int + (select coalesce(sum(last_number), 0) from po_counters)::int n`)).rows[0].n;
    expect(after).toBe(before);
  });
});
