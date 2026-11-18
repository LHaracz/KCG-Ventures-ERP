// Line sheet server code against the real migrations in PGlite: create with
// snapshots, list, edit without and with Refresh prices, duplicate, soft
// delete and restore, the preview build, reference checks and the 60-line
// database limit. Invented businesses' data, "Store A" and "Product A" only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  buildPreviewLineSheet,
  createLineSheet,
  duplicateLineSheet,
  getLineSheet,
  listLineSheets,
  loadLineSheetBuilder,
  markLineSheetDownloaded,
  setLineSheetDeleted,
  updateLineSheet,
  type LsDb,
} from "@/lib/retail/lineSheetService";

let pg: PGlite;
let db: LsDb;
let biz: string;
let mini: string;
let store: string;
let prodA: string;
let prodB: string;
const q = async <T>(sql: string, p: unknown[] = []) => (await pg.query<T>(sql, p)).rows;

const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected an error").toBeTruthy();
  expect((err as Error).message).toMatch(re);
  return err as Error & { fields?: Record<string, string> };
};

const input = (over: Record<string, unknown> = {}) => ({
  name: "Spring Wholesale",
  company_profile_id: biz,
  retailer_id: store,
  price_basis: "retailer",
  show_margin: true,
  payment_terms_text: "Net 30",
  contact_email: "orders@company-a.example.test",
  lines: [
    { product_id: prodA, name: "Product A", description: "Mint", size_text: "4 oz", case_pack_text: "12 per case", wholesale_price: "6.125", msrp: "12" },
    { product_id: prodB, name: "Product B", wholesale_price: "", msrp: "" },
  ],
  ...over,
});

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql"]) await pg.exec(migration(f));
  db = pgliteSupabase(pg) as unknown as LsDb;
  biz = (await q<{ id: string }>(`select id from company_profiles where display_name = 'BotanIQals'`))[0].id;
  mini = (await q<{ id: string }>(`select id from company_profiles where display_name = 'MiniLeaf'`))[0].id;
  store = (await q<{ id: string }>(`insert into retailers (name) values ('Store A') returning id`))[0].id;
  prodA = (await q<{ id: string }>(`insert into products (name, sale_price_per_unit) values ('Product A', 12) returning id`))[0].id;
  prodB = (await q<{ id: string }>(`insert into products (name, sale_price_per_unit) values ('Product B', 9.99) returning id`))[0].id;
}, 120_000);

describe("line sheets", () => {
  it("create, list and read back with the company snapshot and prices", async () => {
    const { id } = await createLineSheet(db, input(), "Admin A");
    const s = await getLineSheet(db, id);
    expect(s).toMatchObject({ name: "Spring Wholesale", price_basis: "retailer", show_margin: true, created_by_name: "Admin A" });
    expect(s.company_snapshot.display_name).toBe("BotanIQals");
    expect(s.lines.map((l) => [l.line_number, l.name, l.wholesale_price === null ? null : Number(l.wholesale_price)])).toEqual([
      [1, "Product A", 6.125],
      [2, "Product B", null],
    ]);
    const list = await listLineSheets(db);
    expect(list[0]).toMatchObject({ id, business_name: "BotanIQals", retailer_name: "Store A", product_count: 2 });
    await markLineSheetDownloaded(db, id);
    expect((await getLineSheet(db, id)).last_downloaded_at).not.toBeNull();
  });

  it("edits keep the saved letterhead and date until Refresh prices", async () => {
    const { id } = await createLineSheet(db, input(), null);
    const first = await getLineSheet(db, id);
    await q(`update line_sheets set prices_saved_at = '2026-01-02T12:00:00Z' where id = $1`, [id]);
    await q(`update company_profiles set phone = '(555) 010-0999' where id = $1`, [biz]);
    await updateLineSheet(db, id, input({ name: "Spring Wholesale v2" }));
    const kept = await getLineSheet(db, id);
    expect(kept.name).toBe("Spring Wholesale v2");
    expect(new Date(kept.prices_saved_at).toISOString()).toBe("2026-01-02T12:00:00.000Z");
    expect(kept.company_snapshot.phone).toBe(first.company_snapshot.phone);
    await updateLineSheet(db, id, input({ refresh_prices: true }));
    const fresh = await getLineSheet(db, id);
    expect(new Date(fresh.prices_saved_at).getTime()).toBeGreaterThan(Date.parse("2026-06-01"));
    expect(fresh.company_snapshot.phone).toBe("(555) 010-0999");
  });

  it("duplicate, soft delete and restore", async () => {
    const { id } = await createLineSheet(db, input(), null);
    const copy = await duplicateLineSheet(db, id, "Admin A");
    const c = await getLineSheet(db, copy.id);
    expect(c.name).toBe("Spring Wholesale (copy)");
    expect(c.lines).toHaveLength(2);
    await setLineSheetDeleted(db, id, true);
    expect((await listLineSheets(db)).map((r) => r.id)).toEqual([copy.id]);
    expect((await listLineSheets(db, { deleted: true })).map((r) => r.id)).toEqual([id]);
    await rejects(() => updateLineSheet(db, id, input()), /Restore this line sheet/);
    await setLineSheetDeleted(db, id, false);
    expect(await listLineSheets(db)).toHaveLength(2);
  });

  it("checks references and the standard basis; the database caps lines at 60", async () => {
    await rejects(() => createLineSheet(db, input({ company_profile_id: "33333333-3333-4333-8333-333333333333" }), null), /Choose a business/);
    await rejects(() => createLineSheet(db, input({ lines: [{ product_id: "44444444-4444-4444-8444-444444444444", name: "Ghost" }] }), null), /no longer exists/);
    const std = await createLineSheet(db, input({ company_profile_id: mini, price_basis: "standard", retailer_id: null, standard_wholesale_percent: "55" }), null);
    expect((await getLineSheet(db, std.id)).standard_wholesale_percent).toBeTruthy();
    const values = Array.from({ length: 61 }, (_, i) => `('${std.id}', ${i + 1}, 'P${i}')`).join(",");
    await q(`delete from line_sheet_lines where line_sheet_id = $1`, [std.id]);
    await expect(q(`insert into line_sheet_lines (line_sheet_id, line_number, name) values ${values}`)).rejects.toThrow();
  });

  it("preview builds an unsaved sheet; the builder data has prices and marketing copy", async () => {
    const p = await buildPreviewLineSheet(db, input(), null);
    expect(p).toMatchObject({ id: "preview", name: "Spring Wholesale" });
    expect(p.lines).toHaveLength(2);
    await q(`insert into retailer_prices (retailer_id, product_id, wholesale_price, msrp) values ($1, $2, 6, 12)`, [store, prodA]);
    const fp = (await q<{ id: string }>(`insert into formulation_products (name, product_id, status) values ('Product A', $1, 'active') returning id`, [prodA]))[0].id;
    await q(`insert into marketing_product_profiles (formulation_product_id, short_description) values ($1, 'Fresh mint')`, [fp]);
    const b = await loadLineSheetBuilder(db);
    expect(b.prices).toHaveLength(1);
    expect(b.marketing).toEqual([{ product_id: prodA, description: "Fresh mint", photo_asset_id: null, photo_title: null }]);
    expect(b.riskyWords.length).toBeGreaterThan(10);
  });
});
