/* eslint-disable @typescript-eslint/no-explicit-any */
// retail_invoices.sql against the real migration SQL in PGlite. Invented
// retailers ("Retailer A"), products ("Product A"), order numbers and
// example.test addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, applyPolicies, asAnon, asOwner, asUser, createAccessDb, migration } from "./helpers/accessDb";
import { computeTotals } from "@/lib/retail/totals";

let pg: PGlite;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
const one = async <T = any>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0];
const failsWith = async (fn: () => Promise<unknown>, re: RegExp) => {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(re);
};

/** Shapes the app uses on the base tables these reference (test-only). */
async function baseTables() {
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
}

const profileId = async (name: string) => (await one(`select id from company_profiles where display_name = $1`, [name])).id as string;
async function retailer(name = "Retailer A") {
  return (await one(`insert into retailers (name, contact_email) values ($1, 'buyer@retailer-a.example.test') returning id`, [name])).id as string;
}
async function product(name = "Product A") {
  return (await one(`insert into products (name) values ($1) returning id`, [name])).id as string;
}

function payload(over: Record<string, unknown> = {}) {
  return {
    order_number: "#1001",
    invoice_date: "2026-11-15",
    delivery_date: "2026-11-20",
    terms_type: "net",
    net_days: 30,
    terms_start: "invoice_date",
    due_date: "2026-12-15",
    delivery_fee: "15",
    tax_exempt: false,
    tax_rate_percent: "6",
    created_by_name: "Test Person",
    lines: [
      { description: "Product A", quantity: "2", unit: "each", unit_price: "10.5" },
      { description: "Custom item", quantity: "1.5", unit: "case", unit_price: "4.3333" },
    ],
    ...over,
  };
}
async function create(over: Record<string, unknown> = {}) {
  return (await one(`select create_invoice($1::jsonb) r`, [JSON.stringify(over)])).r as { id: string; invoice_number: string };
}

let botaniqals: string;
let minileaf: string;
let retailerA: string;

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await baseTables();
  await pg.exec(migration("retail_invoices.sql"));
  botaniqals = await profileId("BotanIQals");
  minileaf = await profileId("MiniLeaf");
  retailerA = await retailer();
}, 60_000);

const base = () => payload({ company_profile_id: botaniqals, retailer_id: retailerA });

describe("migration and settings seed", () => {
  it("seeds one blank settings row per business, and can run twice", async () => {
    await pg.exec(migration("retail_invoices.sql"));
    const s = await rows(`select s.*, p.display_name from invoice_settings s join company_profiles p on p.id = s.company_profile_id order by p.display_name`);
    expect(s.map((r) => [r.display_name, r.invoice_prefix, r.product_scope, r.default_terms_type, r.default_net_days, Number(r.default_tax_rate_percent)])).toEqual([
      ["BotanIQals", "KCG-INV", "botaniqals", "net", 30, 0],
      ["MiniLeaf", "KCG-INV", "minileaf", "net", 30, 0],
    ]);
    for (const r of s) {
      for (const k of ["payable_to", "remit_line1", "remit_city", "payment_instructions", "footer_note"]) expect(r[k], k).toBeNull();
    }
  });
});

describe("retailers, terms and prices", () => {
  it("active retailer names are unique (case-insensitive); archived ones free the name", async () => {
    await failsWith(() => retailer("retailer a"), /retailers_name_unique|duplicate key/);
    await pg.query(`update retailers set archived_at = now() where id = $1`, [retailerA]);
    expect(await retailer("Retailer A")).toBeTruthy();
    await failsWith(() => pg.query(`insert into retailers (name, website_url) values ('Retailer B', 'javascript:x')`), /retailers_website_ok/);
    await failsWith(() => pg.query(`insert into retailers (name, contact_email) values ('Retailer C', 'nope')`), /retailers_contact_email_ok/);
  });

  it("one terms row per retailer and business, with net and consignment checks", async () => {
    const ins = (over: string) => pg.query(`insert into retailer_terms (retailer_id, company_profile_id, ${over}`, [retailerA, botaniqals]);
    await failsWith(() => ins(`terms_type) values ($1, $2, 'net')`), /retailer_terms_net_days_required/);
    await failsWith(() => ins(`terms_type, net_days) values ($1, $2, 'net', 181)`), /retailer_terms_net_days_range/);
    await failsWith(() => ins(`terms_type, consignment_our_share_percent) values ($1, $2, 'consignment', 70)`), /retailer_terms_consignment_required/);
    for (const share of [0, 100, 120]) {
      await failsWith(
        () => ins(`terms_type, consignment_our_share_percent, consignment_schedule, consignment_days_to_pay) values ($1, $2, 'consignment', ${share}, 'monthly', 15)`),
        /retailer_terms_consignment_required/,
      );
    }
    await ins(`terms_type, consignment_our_share_percent, consignment_schedule, consignment_days_to_pay) values ($1, $2, 'consignment', 70, 'monthly', 15)`);
    await failsWith(() => ins(`terms_type, net_days) values ($1, $2, 'net', 30)`), /retailer_terms_unique|duplicate key/);
    await pg.query(`insert into retailer_terms (retailer_id, company_profile_id, terms_type, net_days) values ($1, $2, 'net', 30)`, [retailerA, minileaf]);
  });

  it("one price row per retailer and product; prices not negative", async () => {
    const p = await product();
    await pg.query(`insert into retailer_prices (retailer_id, product_id, wholesale_price, msrp) values ($1, $2, 6.5, 12.99)`, [retailerA, p]);
    await failsWith(() => pg.query(`insert into retailer_prices (retailer_id, product_id) values ($1, $2)`, [retailerA, p]), /retailer_prices_unique|duplicate key/);
    const p2 = await product("Product B");
    await failsWith(() => pg.query(`insert into retailer_prices (retailer_id, product_id, wholesale_price) values ($1, $2, -1)`, [retailerA, p2]), /retailer_prices_wholesale_ok/);
    await failsWith(() => pg.query(`insert into retailer_prices (retailer_id, product_id, msrp) values ($1, $2, -1)`, [retailerA, p2]), /retailer_prices_msrp_ok/);
  });
});

describe("invoice numbers", () => {
  it("first number, then the sequence; editing never changes it", async () => {
    const a = await create(base());
    const b = await create({ ...base(), order_number: "#1002" });
    const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date());
    expect(a.invoice_number).toBe(`KCG-INV-${year}-001`);
    expect(b.invoice_number).toBe(`KCG-INV-${year}-002`);
    const u = (await one(`select update_invoice($1, $2::jsonb) r`, [a.id, JSON.stringify({ ...base(), order_number: "#1003" })])).r;
    expect(u.invoice_number).toBe(a.invoice_number);
  });

  it("past 999 and across a year boundary, per prefix", async () => {
    const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date()));
    await pg.query(`insert into invoice_counters (prefix, year, last_number) values ('KCG-INV', $1, 999)`, [year]);
    expect((await create(base())).invoice_number).toBe(`KCG-INV-${year}-1000`);
    // A counter from last year doesn't affect this year, and a new prefix starts at 001.
    await pg.query(`insert into invoice_counters (prefix, year, last_number) values ('KCG-INV', $1, 57)`, [year - 1]);
    expect((await create({ ...base(), order_number: "#1002" })).invoice_number).toBe(`KCG-INV-${year}-1001`);
    await pg.query(`update invoice_settings set invoice_prefix = 'ML-INV' where company_profile_id = $1`, [minileaf]);
    expect((await create({ ...base(), company_profile_id: minileaf, order_number: "#1003" })).invoice_number).toBe(`ML-INV-${year}-001`);
    expect((await one(`select invoice_number from assign_invoice_number('NEW-PFX')`)).invoice_number).toBe(`NEW-PFX-${year}-001`);
  });

  it("two saves at once get different numbers", async () => {
    const [a, b] = await Promise.all([create(base()), create({ ...base(), order_number: "#1002" })]);
    expect(a.invoice_number).not.toBe(b.invoice_number);
  });

  it("a failed save uses no number, and an abandoned form never asks for one", async () => {
    const first = await create(base());
    await failsWith(() => create({ ...base(), order_number: "#1001" }), /invoices_order_number_active_unique|duplicate key/); // same order: rolls back
    await failsWith(() => create({ ...base(), order_number: "#2001", lines: [] }), /at least one line/);
    const next = await create({ ...base(), order_number: "#1002" });
    expect(Number(next.invoice_number.split("-").pop())).toBe(Number(first.invoice_number.split("-").pop()) + 1);
    expect((await one(`select sum(last_number)::int n from invoice_counters`)).n).toBe(2);
  });
});

describe("order numbers, delete and restore", () => {
  it("one active invoice per order (case-insensitive); delete frees the order but never the invoice number; restore blocked while in use", async () => {
    const a = await create({ ...base(), order_number: "BQ-2552" });
    await failsWith(() => create({ ...base(), order_number: "bq-2552" }), /invoices_order_number_active_unique|duplicate key/);
    await pg.query(`update invoices set deleted_at = now() where id = $1`, [a.id]);
    const b = await create({ ...base(), order_number: "BQ-2552" });
    expect(b.invoice_number).not.toBe(a.invoice_number);
    await failsWith(() => pg.query(`update invoices set deleted_at = null where id = $1`, [a.id]), /invoices_order_number_active_unique|duplicate key/);
    await failsWith(() => pg.query(`update invoices set invoice_number = $1 where id = $2`, [a.invoice_number, b.id]), /invoices_number_unique|duplicate key/);
    await failsWith(() => pg.query(`select update_invoice($1, $2::jsonb)`, [a.id, JSON.stringify(base())]), /deleted/);
  });

  it("order number length", async () => {
    await failsWith(() => create({ ...base(), order_number: "   " }), /invoices_order_number_len/);
    await failsWith(() => create({ ...base(), order_number: "A".repeat(51) }), /invoices_order_number_len/);
  });
});

describe("invoice checks and totals", () => {
  it("computes line totals, subtotal, tax (on the subtotal only) and total in the database, matching computeTotals", async () => {
    const a = await create(base());
    const inv = await one(`select subtotal, tax_amount, total, delivery_fee from invoices where id = $1`, [a.id]);
    const ts = computeTotals(base().lines, "15", "6", false);
    expect([String(inv.subtotal), String(inv.tax_amount), String(inv.total)]).toEqual([ts.subtotal, ts.tax, ts.total]);
    const lines = await rows(`select line_number, line_total from invoice_lines where invoice_id = $1 order by line_number`, [a.id]);
    expect(lines.map((l) => String(l.line_total))).toEqual(ts.lineTotals);

    const exempt = await create({ ...base(), order_number: "#1002", tax_exempt: true });
    expect(String((await one(`select tax_amount from invoices where id = $1`, [exempt.id])).tax_amount)).toBe("0.00");
  });

  it("matches computeTotals on many awkward lines", async () => {
    const lines = Array.from({ length: 37 }, (_, i) => ({ description: `Line ${i}`, unit: "each", quantity: ((i % 7) + 0.125).toFixed(3), unit_price: (i * 1.23457 + 0.005).toFixed(4) }));
    const a = await create({ ...base(), lines, tax_rate_percent: "7.375", delivery_fee: "12.34" });
    const inv = await one(`select subtotal, tax_amount, total from invoices where id = $1`, [a.id]);
    const ts = computeTotals(lines, "12.34", "7.375", false);
    expect([String(inv.subtotal), String(inv.tax_amount), String(inv.total)]).toEqual([ts.subtotal, ts.tax, ts.total]);
  });

  it("net days, terms, consignment fields, due date, dates, fees, tax rate, quantities and prices", async () => {
    let n = 100;
    const bad = async (over: Record<string, unknown>, re: RegExp) => failsWith(() => create({ ...base(), order_number: `#${n++}`, ...over }), re);
    await bad({ net_days: null }, /invoices_net_days_required/);
    await bad({ net_days: 0 }, /invoices_net_days_range/);
    await bad({ due_date: null }, /invoices_due_date_required/);
    await bad({ terms_type: "consignment", net_days: null, due_date: null }, /invoices_consignment_required/);
    await bad({ terms_type: "consignment", net_days: null, due_date: null, consignment_our_share_percent: 100, consignment_schedule: "monthly", consignment_days_to_pay: 15 }, /invoices_consignment_required/);
    await bad({ terms_type: "consignment", net_days: null, due_date: "2026-12-15", consignment_our_share_percent: 70, consignment_schedule: "monthly", consignment_days_to_pay: 15 }, /invoices_consignment_no_due_date/);
    await bad({ delivery_date: "2026-11-14" }, /invoices_delivery_after_invoice/);
    await bad({ delivery_fee: -1 }, /invoices_delivery_fee_ok/);
    await bad({ tax_rate_percent: 101 }, /invoices_tax_rate_range/);
    await bad({ lines: [{ description: "Product A", quantity: "0", unit: "each", unit_price: "1" }] }, /quantity must be greater than 0/);
    await bad({ lines: [{ description: "Product A", quantity: "1", unit: "each", unit_price: "-1" }] }, /unit price must be 0 or more/);
    const ok = await create({
      ...base(),
      order_number: "#999",
      terms_type: "consignment",
      net_days: null,
      due_date: null,
      consignment_our_share_percent: 66.67,
      consignment_schedule: "biweekly",
      consignment_days_to_pay: 30,
    });
    expect(ok.invoice_number).toBeTruthy();
  });

  it("at most 100 lines (function and trigger)", async () => {
    const line = { description: "Product A", quantity: "1", unit: "each", unit_price: "1" };
    await failsWith(() => create({ ...base(), lines: Array.from({ length: 101 }, () => line) }), /at most 100 lines/);
    const a = await create({ ...base(), lines: Array.from({ length: 100 }, () => line) });
    await failsWith(() => pg.query(`insert into invoice_lines (invoice_id, line_number, description, quantity, unit, unit_price, line_total) values ($1, 101, 'x', 1, 'each', 1, 1)`, [a.id]), /at most 100 lines/);
  });
});

describe("row level security", () => {
  it("only active Admins can read or write; no deletes; no anon", async () => {
    // Real order: the access policies already exist when this migration runs.
    ({ pg } = await createAccessDb());
    await asOwner(pg);
    await baseTables();
    const admin = await addEmployee(pg, { roles: ["Admin"], email: "admin1@example.test" });
    await applyPolicies(pg);
    await asOwner(pg);
    await pg.exec(migration("retail_invoices.sql"));
    botaniqals = await profileId("BotanIQals");
    retailerA = await retailer();
    const p = await product();
    await pg.query(`insert into retailer_prices (retailer_id, product_id, wholesale_price) values ($1, $2, 5)`, [retailerA, p]);
    await pg.query(`insert into retailer_terms (retailer_id, company_profile_id, terms_type, net_days) values ($1, $2, 'net', 30)`, [retailerA, botaniqals]);
    await create(base());
    const role = (await rows<{ id: string }>(`select id from roles where name = 'Warehouse Operations'`))[0].id;
    for (const f of ["fulfillment.orders", "fulfillment.pick_list", "fulfillment.sales_data", "fulfillment.stats", "fulfillment.setup"]) {
      await pg.query(`insert into role_features (role_id, feature_key) values ($1, $2) on conflict do nothing`, [role, f]);
    }
    const wh = await addEmployee(pg, { roles: ["Warehouse Operations"], email: "wh1@example.test" });

    const tables = ["retailers", "retailer_terms", "retailer_prices", "invoice_settings", "invoices", "invoice_lines", "invoice_counters"];
    await asUser(pg, admin.userId);
    for (const t of tables) expect((await rows(`select * from ${t}`)).length, t).toBeGreaterThan(0);
    await pg.query(`update retailers set notes = 'Admin note' where id = $1`, [retailerA]);
    await pg.query(`insert into retailers (name) values ('Retailer B')`);
    await failsWith(() => pg.query(`delete from retailers where name = 'Retailer B'`), /permission denied/);
    await failsWith(() => pg.query(`delete from invoices`), /permission denied/);
    await failsWith(() => pg.query(`update invoice_counters set last_number = 0`), /permission denied/);
    await failsWith(() => pg.query(`select create_invoice($1::jsonb)`, [JSON.stringify(base())]), /permission denied/);

    await asUser(pg, wh.userId);
    for (const t of tables) expect((await rows(`select * from ${t}`)).length, t).toBe(0);
    await failsWith(() => pg.query(`insert into retailers (name) values ('Retailer C')`), /row-level security|permission denied/);
    const upd = await pg.query(`update retailers set notes = 'x' returning id`);
    expect(upd.rows.length).toBe(0);

    await asAnon(pg);
    await failsWith(() => pg.query(`select * from invoices`), /permission denied/);
    await asOwner(pg);
  });
});
