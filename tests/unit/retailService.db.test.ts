// Retail server code (src/lib/retail/service.ts) against the real migration
// SQL in PGlite. Invented retailers ("Retailer A"), products ("Product A"),
// order numbers and example.test addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  RetailError,
  buildPreviewInvoice,
  createInvoice,
  createRetailer,
  findOrderConflict,
  getInvoice,
  listInvoices,
  loadRetailBootstrap,
  loadRetailerDetail,
  markDownloaded,
  runPriceTool,
  savePrices,
  saveSettings,
  setInvoiceDeleted,
  setRetailerArchived,
  updateInvoice,
  updateRetailer,
  type Db,
} from "@/lib/retail/service";
import { editedSinceDownload } from "@/lib/retail/snapshots";

let pg: PGlite;
let db: Db;
let botaniqals: string;
let minileaf: string;

const rejects = async (fn: () => Promise<unknown>, re: RegExp, status?: number) => {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected an error").toBeInstanceOf(RetailError);
  expect((err as Error).message).toMatch(re);
  if (status) expect((err as RetailError).status).toBe(status);
  return err as RetailError;
};

const retailerA = {
  name: "Retailer A",
  legal_name: "Retailer A Holdings",
  contact_name: "Pat Example",
  contact_email: "buyer@retailer-a.example.test",
  contact_phone: "(555) 010-0200",
  billing_line1: "1 Market Way",
  billing_city: "Shopton",
  billing_state: "PA",
  billing_zip: "19100",
  shipping_same_as_billing: true,
};

async function product(name: string, opts: { sale?: string; microgreen?: boolean } = {}) {
  return (
    await pg.query<{ id: string }>(`insert into products (name, unit, sale_price_per_unit, is_microgreen) values ($1, 'each', $2, $3) returning id`, [
      name,
      opts.sale ?? null,
      opts.microgreen ?? false,
    ])
  ).rows[0].id;
}
/** PGlite returns date columns as Date objects; PostgREST returns "YYYY-MM-DD". */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
const counterTotal = async () => (await pg.query<{ n: number }>(`select coalesce(sum(last_number), 0)::int n from invoice_counters`)).rows[0].n;

function invoiceBody(retailerId: string, productId: string | null, over: Record<string, unknown> = {}) {
  return {
    company_profile_id: botaniqals,
    retailer_id: retailerId,
    order_number: "1001",
    invoice_date: "2026-11-15",
    delivery_date: "2026-11-20",
    terms: { terms_type: "net", net_days: 30, terms_start: "invoice_date" },
    delivery_fee: "10",
    tax_exempt: false,
    tax_rate_percent: "6",
    bill_to: { name: "Retailer A Holdings", contact_name: "Pat Example", line1: "1 Market Way", line2: "", city: "Shopton", state: "PA", zip: "19100", country: "United States", email: "buyer@retailer-a.example.test", phone: "" },
    ship_to: { name: "Retailer A", line1: "1 Market Way", line2: "", city: "Shopton", state: "PA", zip: "19100", country: "United States" },
    notes_to_retailer: "Thank you",
    internal_notes: null,
    lines: [
      { product_id: productId, description: "Product A", quantity: "12", unit: "each", unit_price: "6.5", save_to_price_list: true },
      { product_id: null, description: "Display stand", quantity: "1", unit: "each", unit_price: "0", save_to_price_list: false },
    ],
    ...over,
  };
}

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  await pg.exec(migration("retail_invoices.sql"));
  db = pgliteSupabase(pg) as unknown as Db;
  botaniqals = (await pg.query<{ id: string }>(`select id from company_profiles where display_name = 'BotanIQals'`)).rows[0].id;
  minileaf = (await pg.query<{ id: string }>(`select id from company_profiles where display_name = 'MiniLeaf'`)).rows[0].id;
}, 60_000);

describe("retailers and terms", () => {
  it("create with consignment terms for one business, default for the other; validation; duplicate names; edit; archive", async () => {
    const r = await createRetailer(
      db,
      {
        retailer: retailerA,
        terms: {
          [botaniqals]: { terms_type: "consignment", consignment_our_share_percent: "70", consignment_schedule: "monthly", consignment_days_to_pay: 15, consignment_extra_terms: "Unsold units may be returned." },
          [minileaf]: { terms_type: "default" },
        },
      },
      "Test Person",
    );
    expect(r.billing_country).toBe("United States");
    expect(r.updated_by_name).toBe("Test Person");
    let d = await loadRetailerDetail(db, r.id);
    expect(d.terms).toHaveLength(1);
    expect(d.terms[0]).toMatchObject({ company_profile_id: botaniqals, terms_type: "consignment", consignment_schedule: "monthly", consignment_days_to_pay: 15, net_days: null });
    expect(Number(d.terms[0].consignment_our_share_percent)).toBe(70);

    await rejects(() => createRetailer(db, { retailer: { ...retailerA, name: "retailer a" } }, null), /already exists/, 409);
    const bad = await rejects(() => createRetailer(db, { retailer: { name: "" } }, null), /not valid|required/, 400);
    expect(Object.keys(bad.fields ?? {})).toEqual(expect.arrayContaining(["name", "billing_line1", "billing_city", "billing_state", "billing_zip"]));
    await rejects(
      () => createRetailer(db, { retailer: { ...retailerA, name: "Retailer B" }, terms: { [botaniqals]: { terms_type: "consignment", consignment_our_share_percent: "100" } } }, null),
      /payment terms/,
      400,
    );

    await updateRetailer(db, r.id, { retailer: { ...retailerA, tax_exempt: true, resale_certificate_number: "RC-0001" }, terms: { [botaniqals]: { terms_type: "default" }, [minileaf]: { terms_type: "net", net_days: 45, terms_start: "delivery_date" } } }, null);
    d = await loadRetailerDetail(db, r.id);
    expect(d.retailer.tax_exempt).toBe(true);
    expect(d.terms.map((t) => [t.company_profile_id, t.terms_type, t.net_days, t.terms_start])).toEqual([[minileaf, "net", 45, "delivery_date"]]);

    expect((await setRetailerArchived(db, r.id, true, null)).archived_at).not.toBeNull();
    await rejects(() => setRetailerArchived(db, r.id, true, null), /already archived/);
    // An archived retailer frees its name.
    await createRetailer(db, { retailer: retailerA }, null);
    await rejects(() => setRetailerArchived(db, r.id, false, null), /already exists/, 409);
  });

  it("bootstrap creates any missing settings rows and lists products", async () => {
    await pg.exec(`delete from invoice_settings`);
    await product("Product A");
    const b = await loadRetailBootstrap(db);
    expect(b.settings.map((s) => s.company_profile_id).sort()).toEqual([botaniqals, minileaf].sort());
    expect(b.products.map((p) => p.name)).toContain("Product A");
  });
});

describe("price lists and helper tools", () => {
  it("save, validate, preview then apply each tool", async () => {
    const a = await product("Product A", { sale: "8" });
    await product("Product B", { sale: "12.5" });
    const c = await product("Product C");
    const r = await createRetailer(db, { retailer: retailerA }, null);
    const other = await createRetailer(db, { retailer: { ...retailerA, name: "Retailer B" } }, null);

    await rejects(() => savePrices(db, r.id, [{ product_id: a, wholesale_price: "-1" }], null), /not valid/, 400);
    await savePrices(db, r.id, [{ product_id: a, wholesale_price: "4.5", msrp: null, notes: "Launch price" }], null);

    // Fill MSRP from shop prices: only where MSRP is empty and a shop price exists.
    const preview = await runPriceTool(db, r.id, { tool: "fill_msrp" }, false, null);
    expect(preview.map((x) => [x.product_name, x.field, x.to])).toEqual([
      ["Product A", "msrp", "8"],
      ["Product B", "msrp", "12.5"],
    ]);
    expect((await loadRetailerDetail(db, r.id)).prices.find((p) => p.product_id === a)!.msrp).toBeNull(); // preview wrote nothing
    await runPriceTool(db, r.id, { tool: "fill_msrp" }, true, null);

    // Fill wholesale at 50% of MSRP: only B (A already has a wholesale price).
    const w = await runPriceTool(db, r.id, { tool: "fill_wholesale", percent: 50 }, true, null);
    expect(w.map((x) => [x.product_name, x.to])).toEqual([["Product B", "6.25"]]);
    await rejects(() => runPriceTool(db, r.id, { tool: "fill_wholesale", percent: 0 }, false, null), /percentage/);

    const prices = (await loadRetailerDetail(db, r.id)).prices;
    const pa = prices.find((p) => p.product_id === a)!;
    expect([Number(pa.wholesale_price), Number(pa.msrp), pa.notes]).toEqual([4.5, 8, "Launch price"]);

    // Copy to another retailer; existing prices kept unless overwrite.
    await savePrices(db, other.id, [{ product_id: a, wholesale_price: "5", msrp: null, notes: null }], null);
    const keep = await runPriceTool(db, other.id, { tool: "copy", source_retailer_id: r.id }, false, null);
    expect(keep.map((x) => `${x.product_name} ${x.field}`).sort()).toEqual(["Product A msrp", "Product B msrp", "Product B wholesale_price"]);
    const over = await runPriceTool(db, other.id, { tool: "copy", source_retailer_id: r.id, overwrite: true }, true, null);
    expect(over.find((x) => x.product_id === a && x.field === "wholesale_price")).toMatchObject({ from: "5", to: "4.5" });
    await rejects(() => runPriceTool(db, r.id, { tool: "copy", source_retailer_id: r.id }, false, null), /different retailer/);
    expect(c).toBeTruthy();
  });
});

describe("invoice settings", () => {
  it("prefix is checked and uppercased; payment instructions refuse card numbers", async () => {
    const s = await saveSettings(db, botaniqals, { invoice_prefix: "bq-inv", default_terms_type: "net", default_net_days: 45, default_tax_rate_percent: "6", product_scope: "botaniqals" }, "Test Person");
    expect([s.invoice_prefix, s.default_net_days, Number(s.default_tax_rate_percent)]).toEqual(["BQ-INV", 45, 6]);
    await rejects(() => saveSettings(db, botaniqals, { invoice_prefix: "-bad", default_terms_type: "net", default_net_days: 30 }, null), /not valid/, 400);
    await rejects(
      () => saveSettings(db, botaniqals, { invoice_prefix: "KCG-INV", default_terms_type: "net", default_net_days: 30, payment_instructions: "Card 4111 1111 1111 1111" }, null),
      /not valid/,
      400,
    );
  });
});

describe("invoices", () => {
  it("create assigns the number, snapshots, due date and saves ticked prices; preview uses no number", async () => {
    const a = await product("Product A");
    const r = await createRetailer(db, { retailer: retailerA }, null);
    await saveSettings(db, botaniqals, { invoice_prefix: "KCG-INV", payable_to: "Company A LLC", default_terms_type: "net", default_net_days: 30, default_tax_rate_percent: "6", product_scope: "botaniqals" }, null);

    const before = await counterTotal();
    const preview = await buildPreviewInvoice(db, invoiceBody(r.id, a), null);
    expect(preview.invoice_number).toBe("Assigned when saved");
    expect([preview.subtotal, preview.tax_amount, preview.total, preview.due_date]).toEqual(["78.00", "4.68", "92.68", "2026-12-15"]);
    expect(await counterTotal()).toBe(before);

    const created = await createInvoice(db, invoiceBody(r.id, a), "Test Person");
    expect(created.invoice_number).toBe("KCG-INV-2026-001");
    const inv = await getInvoice(db, created.id);
    expect(inv.order_number).toBe("#1001");
    expect(inv.company_snapshot.payable_to).toBe("Company A LLC");
    expect(inv.retailer_snapshot.name).toBe("Retailer A");
    expect([Number(inv.subtotal), Number(inv.tax_amount), Number(inv.total)]).toEqual([78, 4.68, 92.68]);
    expect(iso(inv.due_date)).toBe("2026-12-15");
    expect(inv.created_by_name).toBe("Test Person");
    expect(inv.lines.map((l) => l.line_number)).toEqual([1, 2]);
    const price = (await loadRetailerDetail(db, r.id)).prices.find((p) => p.product_id === a)!;
    expect(Number(price.wholesale_price)).toBe(6.5);

    // Downloading doesn't count as an edit.
    await markDownloaded(db, inv.id);
    expect(editedSinceDownload(await getInvoice(db, inv.id))).toBe(false);
  });

  it("one active invoice per Shopify order; edit keeps the number; delete frees the order; restore blocked while in use", async () => {
    const a = await product("Product A");
    const r = await createRetailer(db, { retailer: retailerA }, null);
    const first = await createInvoice(db, invoiceBody(r.id, a), null);
    const conflict = await rejects(() => createInvoice(db, invoiceBody(r.id, a, { order_number: "#1001" }), null), /Order #1001 already has an invoice \(KCG-INV-2026-001, BotanIQals, Retailer A\)/, 409);
    expect(conflict.fields?.order_number).toMatch(/already has an invoice/);
    expect(await findOrderConflict(db, "#1001", first.id)).toBeNull();

    // Edit: number stays; snapshots kept unless asked; consignment never saves prices.
    await pg.query(`update retailers set name = 'Retailer A Renamed' where id = $1`, [r.id]);
    const edited = await updateInvoice(
      db,
      first.id,
      invoiceBody(r.id, a, {
        terms: { terms_type: "consignment", consignment_our_share_percent: "70", consignment_schedule: "biweekly", consignment_days_to_pay: 15 },
        tax_rate_percent: "0",
        lines: [{ product_id: a, description: "Product A", quantity: "3", unit: "each", unit_price: "9.99", save_to_price_list: true }],
      }),
      null,
    );
    expect(edited.invoice_number).toBe(first.invoice_number);
    let inv = await getInvoice(db, first.id);
    expect(inv.retailer_snapshot.name).toBe("Retailer A");
    expect(inv.due_date).toBeNull();
    expect(Number(inv.total)).toBe(39.97);
    // Nothing is saved to the price list from a consignment invoice (6.50 came from the first save).
    expect((await loadRetailerDetail(db, r.id)).prices.map((p) => Number(p.wholesale_price))).toEqual([6.5]);
    await updateInvoice(db, first.id, { ...invoiceBody(r.id, a), refresh_snapshots: true }, null);
    inv = await getInvoice(db, first.id);
    expect(inv.retailer_snapshot.name).toBe("Retailer A Renamed");

    await setInvoiceDeleted(db, first.id, true);
    await rejects(() => updateInvoice(db, first.id, invoiceBody(r.id, a), null), /deleted/);
    const second = await createInvoice(db, invoiceBody(r.id, a), null);
    expect(second.invoice_number).toBe("KCG-INV-2026-002");
    await rejects(() => setInvoiceDeleted(db, first.id, false), /can't be restored: order #1001 is used by KCG-INV-2026-002/, 409);
    await setInvoiceDeleted(db, second.id, true);
    expect((await setInvoiceDeleted(db, first.id, false)).deleted_at).toBeNull();
  });

  it("archived retailers can't get new invoices; list order, filters, search and paging", async () => {
    const a = await product("Product A");
    const r = await createRetailer(db, { retailer: retailerA }, null);
    const b = await createRetailer(db, { retailer: { ...retailerA, name: "Retailer B" } }, null);
    for (let n = 1; n <= 22; n++) {
      await createInvoice(db, invoiceBody(n % 2 ? r.id : b.id, a, { order_number: String(2000 + n), retailer_po_number: n === 7 ? "PO-0007" : null }), null);
    }
    const page1 = await listInvoices(db, {});
    expect(page1.total).toBe(22);
    expect(page1.rows).toHaveLength(20);
    expect(page1.rows[0].invoice_number).toBe("KCG-INV-2026-022");
    expect((await listInvoices(db, { page: 2 })).rows.map((x) => x.invoice_number)).toEqual(["KCG-INV-2026-002", "KCG-INV-2026-001"]);
    expect((await listInvoices(db, { retailerId: b.id })).total).toBe(11);
    expect((await listInvoices(db, { q: "2007" })).rows.map((x) => x.order_number)).toEqual(["#2007"]);
    expect((await listInvoices(db, { q: "po-0007" })).rows.map((x) => x.order_number)).toEqual(["#2007"]);
    expect((await listInvoices(db, { q: "retailer b" })).total).toBe(11);

    const last = page1.rows[0];
    await setInvoiceDeleted(db, last.id, true);
    expect((await listInvoices(db, {})).total).toBe(21);
    expect((await listInvoices(db, { includeDeleted: true })).total).toBe(22);

    await setRetailerArchived(db, r.id, true, null);
    await rejects(() => createInvoice(db, invoiceBody(r.id, a, { order_number: "3001" }), null), /archived/, 400);
    // Existing invoices for it still open, and can still be edited.
    const oldOne = (await listInvoices(db, { retailerId: r.id })).rows[0];
    await updateInvoice(db, oldOne.id, invoiceBody(r.id, a, { order_number: oldOne.order_number }), null);
  });

  it("validation errors are keyed by field", async () => {
    const r = await createRetailer(db, { retailer: retailerA }, null);
    const err = await rejects(
      () => createInvoice(db, invoiceBody(r.id, null, { order_number: " ", delivery_date: "2026-11-01", lines: [{ description: "", quantity: "0", unit: "each", unit_price: "" }] }), null),
      /missing or not valid/,
      400,
    );
    expect(Object.keys(err.fields ?? {})).toEqual(expect.arrayContaining(["order_number", "delivery_date", "lines.1.description", "lines.1.quantity", "lines.1.unit_price"]));
  });
});
