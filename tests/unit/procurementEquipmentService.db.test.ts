// Procurement server code for equipment, categories and listing prices
// (src/lib/procurement/service.ts) against the real migration SQL in PGlite.
// Invented equipment ("Equipment A"), suppliers ("Supplier A") and
// example.test addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  ProcurementError,
  addEquipmentLink,
  addLink,
  archiveCategory,
  archiveEquipment,
  archiveEquipmentLink,
  archiveSupplier,
  createCategory,
  createEquipment,
  createSupplier,
  loadEquipmentPoPrefill,
  loadPoPrefill,
  loadProcurementData,
  makeEquipmentPreferred,
  renameCategory,
  reorderCategories,
  restoreEquipment,
  updateEquipment,
  updateEquipmentLink,
  updateLink,
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

const supplierA = {
  name: "Supplier A",
  website_url: "https://supplier-a.example.test",
  contact_email: "orders@supplier-a.example.test",
  payment_methods: ["credit_card"],
  payment_notes: "PAYNOTE call first",
  ordering_notes: "ORDERNOTE before noon",
  address_line1: "1 Example Way",
  city: "Testville",
  state: "DE",
  zip: "19700",
  country: "USA",
  default_po_payment_terms: "Net 30",
};

async function categoryId(name: string) {
  const d = await loadProcurementData(db);
  return d.categories.find((c) => c.name === name && !c.archived_at)!.id;
}
async function material(name: string, on = 0, par = 10) {
  return (await pg.query<{ id: string }>(`insert into inventory_items (name, unit, par_level, quantity_on_hand) values ($1, 'kg', $2, $3) returning id`, [name, par, on])).rows[0].id;
}
const poNumbersUsed = async () =>
  (await pg.query<{ n: number }>(`select (select count(*) from purchase_orders)::int + (select coalesce(sum(last_number), 0) from po_counters)::int n`)).rows[0].n;

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(migration("procurement_suppliers.sql"));
  await pg.exec(migration("procurement_equipment_prices.sql"));
  db = pgliteSupabase(pg) as unknown as Db;
});

describe("categories", () => {
  it("add (trimmed, unique), rename, reorder, and archive blocked while in use", async () => {
    const lab = await createCategory(db, "  Lab   bench ");
    expect(lab.name).toBe("Lab bench");
    expect(lab.sort_order).toBe(5);
    await rejects(() => createCategory(db, "production"), /already exists/, 409);
    await rejects(() => createCategory(db, "  "), /Enter a category name/, 400);
    expect((await renameCategory(db, lab.id, "Lab")).name).toBe("Lab");

    const d = await loadProcurementData(db);
    const ids = d.categories.filter((c) => !c.archived_at).map((c) => c.id).reverse();
    expect((await reorderCategories(db, ids)).map((c) => c.name)).toEqual(["Lab", "Other", "Office", "Warehouse", "Production"]);
    await rejects(() => reorderCategories(db, ids.slice(1)), /changed/, 409);

    await createEquipment(db, { name: "Equipment A", category_id: lab.id }, null);
    await rejects(() => archiveCategory(db, lab.id), /1 item uses this category/, 409);
    const other = await categoryId("Other");
    expect((await archiveCategory(db, other)).archived_at).not.toBeNull();
    await rejects(() => createEquipment(db, { name: "Equipment B", category_id: other }, null), /archived/, 400);
  });
});

describe("equipment items", () => {
  it("create, validate, duplicate names, edit, archive with listings, restore", async () => {
    const prod = await categoryId("Production");
    const e = await createEquipment(db, { name: "Equipment A", category_id: prod, description: "Bench model" }, "Test Person");
    expect(e.updated_by_name).toBe("Test Person");
    await rejects(() => createEquipment(db, { name: "equipment a", category_id: prod }, null), /already exists/, 409);
    const bad = await rejects(() => createEquipment(db, { name: "", category_id: "nope" }, null), /not valid/, 400);
    expect(Object.keys(bad.fields ?? {}).sort()).toEqual(["category_id", "name"]);
    const office = await categoryId("Office");
    expect((await updateEquipment(db, e.id, { name: "Equipment A2", category_id: office }, null)).category_id).toBe(office);

    const s = await createSupplier(db, supplierA, null);
    await addEquipmentLink(db, { equipment_id: e.id, supplier_id: s.id, link: {} }, null);
    expect(await archiveEquipment(db, e.id, null)).toEqual({ archivedLinks: 1 });
    let d = await loadProcurementData(db);
    expect(d.equipmentLinks).toEqual([]);
    expect(d.equipment.find((x) => x.id === e.id)?.archived_at).not.toBeNull();
    await rejects(() => updateEquipment(db, e.id, { name: "x", category_id: office }, null), /archived/);

    expect((await restoreEquipment(db, e.id, null)).archived_at).toBeNull();
    d = await loadProcurementData(db);
    expect(d.equipment.find((x) => x.id === e.id)?.archived_at).toBeNull();
    await rejects(() => restoreEquipment(db, e.id, null), /not archived/);
  });
});

describe("equipment listings share the suppliers list", () => {
  it("choose a supplier added under Raw Materials, add a brand new one, refuse duplicates, move the star", async () => {
    const m = await material("Material A");
    const rawListing = await addLink(db, { raw_material_id: m, new_supplier: supplierA, link: {} }, null); // supplier first added under Raw Materials
    const e = await createEquipment(db, { name: "Equipment A", category_id: await categoryId("Production") }, null);

    const first = await addEquipmentLink(
      db,
      { equipment_id: e.id, supplier_id: rawListing.supplier_id, link: { product_url: "https://supplier-a.example.test/eq", supplier_item: "EQ-100", price: "1299.50", price_note: "each" } },
      null,
    );
    expect(first.is_preferred).toBe(true);
    expect(String(first.price)).toMatch(/^1299\.5/);
    expect(first.price_updated_at).not.toBeNull();
    await rejects(() => addEquipmentLink(db, { equipment_id: e.id, supplier_id: rawListing.supplier_id, link: {} }, null), /already listed for this equipment item/, 409);

    const second = await addEquipmentLink(db, { equipment_id: e.id, new_supplier: { name: "Supplier B", website_url: "https://supplier-b.example.test" }, link: { price: "1250" } }, null);
    expect(second.is_preferred).toBe(false);
    await makeEquipmentPreferred(db, second.id);
    let d = await loadProcurementData(db);
    expect(d.equipmentLinks.filter((l) => l.is_preferred).map((l) => l.id)).toEqual([second.id]);
    expect(d.suppliers.map((s) => s.name).sort()).toEqual(["Supplier A", "Supplier B"]);

    const edited = await updateEquipmentLink(db, first.id, { link: { supplier_item: "EQ-100", price: "1300", price_note: "each" }, make_preferred: true }, null);
    expect(edited.is_preferred).toBe(true);
    d = await loadProcurementData(db);
    expect(d.equipmentLinks.find((l) => l.id === second.id)?.is_preferred).toBe(false);

    await archiveEquipmentLink(db, first.id);
    d = await loadProcurementData(db);
    expect(d.equipmentLinks.map((l) => [l.id, l.is_preferred])).toEqual([[second.id, false]]); // nobody promoted
  });

  it("validates price and links on the server", async () => {
    const e = await createEquipment(db, { name: "Equipment A", category_id: await categoryId("Production") }, null);
    const s = await createSupplier(db, { name: "Supplier A" }, null);
    const bad = await rejects(
      () => addEquipmentLink(db, { equipment_id: e.id, supplier_id: s.id, link: { price: "12.34567", product_url: "javascript:alert(1)", price_note: "x".repeat(201) } }, null),
      /not valid/,
      400,
    );
    expect(Object.keys(bad.fields ?? {}).sort()).toEqual(["price", "price_note", "product_url"]);
    for (const price of ["0", "-3", "abc"]) {
      await rejects(() => addEquipmentLink(db, { equipment_id: e.id, supplier_id: s.id, link: { price } }, null), /not valid/);
    }
  });
});

describe("raw material listing prices", () => {
  it("price and note save; price_updated_at changes only with the price; the PO line price stays blank", async () => {
    const m = await material("Material A", 0, 25);
    const l = await addLink(db, { raw_material_id: m, new_supplier: supplierA, link: { price: "48.5", price_note: "per 25 kg bag" } }, null);
    expect(l.price_note).toBe("per 25 kg bag");
    const t0 = l.price_updated_at;
    expect(t0).not.toBeNull();
    await new Promise((r) => setTimeout(r, 15));
    const noteOnly = await updateLink(db, l.id, { link: { price: "48.50", price_note: "per bag" } }, null);
    expect(noteOnly.price_updated_at).toEqual(t0);
    await new Promise((r) => setTimeout(r, 15));
    const changed = await updateLink(db, l.id, { link: { price: "50", price_note: "per bag" } }, null);
    expect(new Date(changed.price_updated_at!).getTime()).toBeGreaterThan(new Date(t0!).getTime());
    const cleared = await updateLink(db, l.id, { link: { price: "" } }, null);
    expect(cleared.price).toBeNull();
    expect(cleared.price_updated_at).toBeNull();
    await rejects(() => updateLink(db, l.id, { link: { price: "1.23456" } }, null), /not valid/);

    await updateLink(db, l.id, { link: { price: "50" } }, null);
    const r = await loadPoPrefill(db, l.supplier_id, [m]);
    expect(r.prefill.lines[0].unit_price).toBe("");
    expect(r.supplierInfo.prices).toMatchObject([{ label: "Material A", price: expect.stringMatching(/^50/) }]);
  });
});

describe("suppliers page archive", () => {
  it("archives raw material and equipment listings and reports both counts", async () => {
    const m = await material("Material A");
    const l = await addLink(db, { raw_material_id: m, new_supplier: supplierA, link: {} }, null);
    const prod = await categoryId("Production");
    const e1 = await createEquipment(db, { name: "Equipment A", category_id: prod }, null);
    const e2 = await createEquipment(db, { name: "Equipment B", category_id: prod }, null);
    await addEquipmentLink(db, { equipment_id: e1.id, supplier_id: l.supplier_id, link: {} }, null);
    await addEquipmentLink(db, { equipment_id: e2.id, supplier_id: l.supplier_id, link: {} }, null);
    expect(await archiveSupplier(db, l.supplier_id, "Test Person")).toEqual({ archivedLinks: 1, archivedEquipmentLinks: 2 });
    const d = await loadProcurementData(db);
    expect(d.links).toEqual([]);
    expect(d.equipmentLinks).toEqual([]);
    expect(d.suppliers[0].archived_at).not.toBeNull();
  });
});

describe("equipment PO prefill", () => {
  it("loads by id: one line with quantity 1, each, model and listing price; notes stay out; nothing is saved", async () => {
    const s = await createSupplier(db, supplierA, null);
    const e = await createEquipment(db, { name: "Equipment A", category_id: await categoryId("Production") }, null);
    await addEquipmentLink(
      db,
      { equipment_id: e.id, supplier_id: s.id, link: { supplier_item: "EQ-100", price: "1299.5", price_note: "each", notes: "LISTINGNOTE demo", product_url: "https://supplier-a.example.test/eq" } },
      null,
    );
    const before = await poNumbersUsed();
    const r = await loadEquipmentPoPrefill(db, s.id, e.id);
    expect(r.tab).toBe("equipment");
    expect(r.prefill.lines).toEqual([{ item_number: "EQ-100", description: "Equipment A", quantity: "1", unit: "each", unit_price: "1299.5" }]);
    expect(r.prefill).toMatchObject({ vendor_name: "Supplier A", vendor_zip: "19700", payment_terms: "Net 30", warnings: [] });
    const text = JSON.stringify(r.prefill);
    for (const secret of ["PAYNOTE", "ORDERNOTE", "LISTINGNOTE", "/eq"]) expect(text).not.toContain(secret);
    expect(r.supplierInfo).toMatchObject({ reference_label: "Product page", prices: [{ label: "Equipment A", price_note: "each" }] });
    expect(await poNumbersUsed()).toBe(before);
  });

  it("rejects unknown, archived and mismatched ids", async () => {
    const a = await createSupplier(db, supplierA, null);
    const b = await createSupplier(db, { name: "Supplier B" }, null);
    const prod = await categoryId("Production");
    const e1 = await createEquipment(db, { name: "Equipment A", category_id: prod }, null);
    const e2 = await createEquipment(db, { name: "Equipment B", category_id: prod }, null);
    const link = await addEquipmentLink(db, { equipment_id: e1.id, supplier_id: a.id, link: {} }, null);
    await addEquipmentLink(db, { equipment_id: e2.id, supplier_id: b.id, link: {} }, null);

    await rejects(() => loadEquipmentPoPrefill(db, "00000000-0000-4000-8000-000000000000", e1.id), /Unknown supplier/, 404);
    await rejects(() => loadEquipmentPoPrefill(db, a.id, "00000000-0000-4000-8000-000000000000"), /Unknown equipment item/, 404);
    await rejects(() => loadEquipmentPoPrefill(db, a.id, "Equipment A"), /Unknown equipment item/, 404);
    await rejects(() => loadEquipmentPoPrefill(db, a.id, e2.id), /not listed as a supplier/, 400);
    await archiveEquipmentLink(db, link.id);
    await rejects(() => loadEquipmentPoPrefill(db, a.id, e1.id), /not listed as a supplier/, 400);
    await archiveEquipment(db, e2.id, null);
    await rejects(() => loadEquipmentPoPrefill(db, b.id, e2.id), /archived/, 400);
    await archiveSupplier(db, b.id, null);
    await rejects(() => loadEquipmentPoPrefill(db, b.id, e2.id), /archived/, 400);
  });
});
