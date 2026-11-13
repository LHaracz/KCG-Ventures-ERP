// procurement_equipment_prices.sql against the real migration SQL in PGlite
// (after procurement_suppliers.sql). Invented equipment ("Equipment A"),
// suppliers ("Supplier A") and example.test addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, applyPolicies, asAnon, asOwner, asUser, createAccessDb, migration } from "./helpers/accessDb";

let pg: PGlite;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const one = async (sql: string, params: unknown[] = []) => (await rows<any>(sql, params))[0];
const failsWith = async (fn: () => Promise<unknown>, re: RegExp) => {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(re);
};
const sleep = () => new Promise((r) => setTimeout(r, 15));

const category = async (name: string) => (await one(`select id from equipment_categories where name = $1 and archived_at is null`, [name])).id as string;
const supplier = async (name: string) => (await one(`insert into suppliers (name) values ($1) returning id`, [name])).id as string;
const equipment = async (name: string, cat = "Production") =>
  (await one(`insert into equipment_items (name, category_id) values ($1, $2) returning id`, [name, await category(cat)])).id as string;
const listing = async (eq: string, sup: string, extra: Record<string, unknown> = {}) => {
  const cols = ["equipment_id", "supplier_id", ...Object.keys(extra)];
  return one(
    `insert into equipment_suppliers (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    [eq, sup, ...Object.values(extra)],
  );
};
const listingRow = (id: string) => one(`select * from equipment_suppliers where id = $1`, [id]);

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(migration("procurement_suppliers.sql"));
  await pg.exec(migration("procurement_equipment_prices.sql"));
});

describe("migration", () => {
  it("seeds the four categories once and can run twice", async () => {
    await pg.exec(migration("procurement_equipment_prices.sql"));
    expect((await rows<{ name: string }>(`select name from equipment_categories order by sort_order`)).map((r) => r.name)).toEqual([
      "Production", "Warehouse", "Office", "Other",
    ]);
  });
  it("adds nullable price columns to raw material listings without touching existing rows", async () => {
    const m = (await one(`insert into inventory_items (name, unit) values ('Material A', 'kg') returning id`)).id;
    const l = await one(`insert into raw_material_suppliers (raw_material_id, supplier_id) values ($1, $2) returning *`, [m, await supplier("Supplier A")]);
    expect(l.price).toBeNull();
    expect(l.price_note).toBeNull();
    expect(l.price_updated_at).toBeNull();
  });
});

describe("equipment and categories", () => {
  it("equipment names are unique among active items, ignoring case", async () => {
    const a = await equipment("Equipment A");
    await failsWith(() => equipment("equipment a"), /equipment_items_name_unique|duplicate key/);
    await pg.query(`select archive_equipment_item($1, 'Test Person')`, [a]);
    expect(await equipment("Equipment A")).toBeTruthy();
  });

  it("category names are unique among active categories", async () => {
    await failsWith(() => pg.query(`insert into equipment_categories (name) values ('production')`), /equipment_categories_name_unique|duplicate key/);
    await failsWith(() => pg.query(`insert into equipment_categories (name) values (' Lab ')`), /equipment_categories_name_len/);
  });

  it("archiving a category is blocked while an active item uses it", async () => {
    const e = await equipment("Equipment A", "Office");
    await failsWith(() => pg.query(`update equipment_categories set archived_at = now() where name = 'Office'`), /1 item uses this category/);
    await equipment("Equipment B", "Office");
    await failsWith(() => pg.query(`update equipment_categories set archived_at = now() where name = 'Office'`), /2 items use this category/);
    await pg.query(`update equipment_items set archived_at = now()`);
    await pg.query(`update equipment_categories set archived_at = now() where name = 'Office'`);
    await failsWith(() => pg.query(`update equipment_items set archived_at = null where id = $1`, [e]), /category is archived/);
  });

  it("nothing is hard-deleted", async () => {
    const e = await equipment("Equipment A");
    const l = await listing(e, await supplier("Supplier A"));
    await failsWith(() => pg.query(`delete from equipment_suppliers where id = $1`, [l.id]), /never deleted/);
    await failsWith(() => pg.query(`delete from equipment_items where id = $1`, [e]), /never deleted/);
    await failsWith(() => pg.query(`delete from equipment_categories where name = 'Other'`), /never deleted/);
  });
});

describe("equipment listings", () => {
  it("first active supplier is preferred; at most one preferred; unique active pair", async () => {
    const e = await equipment("Equipment A");
    const sa = await supplier("Supplier A");
    const a = await listing(e, sa);
    const b = await listing(e, await supplier("Supplier B"));
    expect(a.is_preferred).toBe(true);
    expect(b.is_preferred).toBe(false);
    await failsWith(() => listing(e, sa), /es_active_pair_unique|duplicate key/);
    const sc = await supplier("Supplier C");
    await failsWith(() => listing(e, sc, { is_preferred: true }), /es_one_preferred_unique|duplicate key/);
    await pg.query(`update equipment_suppliers set archived_at = now() where id = $1`, [a.id]);
    expect((await listing(e, sa)).is_preferred).toBe(false); // B exists, so the new one is not auto-preferred
  });

  it("set_preferred_equipment_supplier moves the star in one step and rejects other items' or archived listings", async () => {
    const e = await equipment("Equipment A");
    const e2 = await equipment("Equipment B");
    const sa = await supplier("Supplier A");
    const a = await listing(e, sa);
    const b = await listing(e, await supplier("Supplier B"));
    const other = await listing(e2, sa);
    await pg.query(`select set_preferred_equipment_supplier($1, $2)`, [e, b.id]);
    expect((await listingRow(a.id)).is_preferred).toBe(false);
    expect((await listingRow(b.id)).is_preferred).toBe(true);
    await failsWith(() => pg.query(`select set_preferred_equipment_supplier($1, $2)`, [e, other.id]), /not found for this equipment item/);
    await pg.query(`update equipment_suppliers set archived_at = now() where id = $1`, [a.id]);
    await failsWith(() => pg.query(`select set_preferred_equipment_supplier($1, $2)`, [e, a.id]), /archived/);
    expect((await listingRow(b.id)).is_preferred).toBe(true);
  });

  it("archiving the preferred listing promotes nobody", async () => {
    const e = await equipment("Equipment A");
    const a = await listing(e, await supplier("Supplier A"));
    const b = await listing(e, await supplier("Supplier B"));
    await pg.query(`update equipment_suppliers set archived_at = now() where id = $1`, [a.id]);
    expect((await listingRow(a.id)).is_preferred).toBe(false);
    expect((await listingRow(b.id)).is_preferred).toBe(false);
  });

  it("URL, price and text constraints", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    for (const bad of ["javascript:alert(1)", "ftp://x.example.test", "no-scheme.example.test", `https://example.test/${"a".repeat(2000)}`]) {
      await failsWith(() => listing(e, s, { product_url: bad }), /es_product_url_ok/);
    }
    await failsWith(() => listing(e, s, { price: 0 }), /es_price_positive/);
    await failsWith(() => listing(e, s, { price: -5 }), /es_price_positive/);
    await failsWith(() => listing(e, s, { price_note: "x".repeat(201) }), /es_price_note_len/);
    await failsWith(() => listing(e, s, { notes: "x".repeat(2001) }), /es_notes_len/);
    await failsWith(() => listing(e, s, { price: "123456789012.5" }), /numeric field overflow|out of range/);
    const ok = await listing(e, s, { price: "1299.12345", product_url: "https://supplier-a.example.test/e" });
    expect(String(ok.price)).toBe("1299.1235"); // numeric(14,4)

    const m = (await one(`insert into inventory_items (name, unit) values ('Material A', 'kg') returning id`)).id;
    await failsWith(() => pg.query(`insert into raw_material_suppliers (raw_material_id, supplier_id, price) values ($1, $2, 0)`, [m, s]), /rms_price_positive/);
    await failsWith(() => pg.query(`insert into raw_material_suppliers (raw_material_id, supplier_id, price_note) values ($1, $2, $3)`, [m, s, "x".repeat(201)]), /rms_price_note_len/);
  });

  it("price_updated_at: set when a price is added or changed, kept for note or same-value edits, cleared with the price (both tables)", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    const m = (await one(`insert into inventory_items (name, unit) values ('Material A', 'kg') returning id`)).id;
    for (const table of ["equipment_suppliers", "raw_material_suppliers"]) {
      const row =
        table === "equipment_suppliers"
          ? await listing(e, s)
          : await one(`insert into raw_material_suppliers (raw_material_id, supplier_id) values ($1, $2) returning *`, [m, s]);
      const get = async () => one(`select price_updated_at from ${table} where id = $1`, [row.id]);
      expect((await get()).price_updated_at, table).toBeNull();

      await pg.query(`update ${table} set price = 10 where id = $1`, [row.id]);
      const t1 = new Date((await get()).price_updated_at).getTime();
      expect(t1).toBeGreaterThan(0);

      await sleep();
      await pg.query(`update ${table} set price_note = 'per 25 kg bag', notes = 'x', price_updated_at = '2000-01-01' where id = $1`, [row.id]);
      expect(new Date((await get()).price_updated_at).getTime(), table).toBe(t1);
      await pg.query(`update ${table} set price = 10.0000 where id = $1`, [row.id]);
      expect(new Date((await get()).price_updated_at).getTime(), table).toBe(t1);

      await sleep();
      await pg.query(`update ${table} set price = 12.5 where id = $1`, [row.id]);
      expect(new Date((await get()).price_updated_at).getTime(), table).toBeGreaterThan(t1);

      await pg.query(`update ${table} set price = null where id = $1`, [row.id]);
      expect((await get()).price_updated_at, table).toBeNull();
    }
    const withPrice = await listing(await equipment("Equipment B"), s, { price: 3 });
    expect(withPrice.price_updated_at).not.toBeNull();
  });

  it("link_updated_at follows the product link only", async () => {
    const e = await equipment("Equipment A");
    const l = await listing(e, await supplier("Supplier A"), { product_url: "https://supplier-a.example.test/1" });
    const t0 = new Date(l.link_updated_at).getTime();
    await sleep();
    await pg.query(`update equipment_suppliers set notes = 'x', price = 4, link_updated_at = '2000-01-01' where id = $1`, [l.id]);
    expect(new Date((await listingRow(l.id)).link_updated_at).getTime()).toBe(t0);
    await sleep();
    await pg.query(`update equipment_suppliers set product_url = 'https://supplier-a.example.test/2' where id = $1`, [l.id]);
    expect(new Date((await listingRow(l.id)).link_updated_at).getTime()).toBeGreaterThan(t0);
    await pg.query(`update equipment_suppliers set product_url = null where id = $1`, [l.id]);
    expect((await listingRow(l.id)).link_updated_at).toBeNull();
  });
});

describe("archive cascades", () => {
  it("archive_equipment_item archives the item and its listings", async () => {
    const e = await equipment("Equipment A");
    await listing(e, await supplier("Supplier A"));
    await listing(e, await supplier("Supplier B"));
    expect((await one(`select archive_equipment_item($1, 'Test Person') n`, [e])).n).toBe(2);
    expect((await one(`select count(*)::int n from equipment_suppliers where archived_at is null`)).n).toBe(0);
    expect((await one(`select archived_at, updated_by_name from equipment_items where id = $1`, [e])).updated_by_name).toBe("Test Person");
    await failsWith(() => pg.query(`select archive_equipment_item($1, 'x')`, [e]), /already archived/);
  });

  it("archive_supplier_listings archives raw material and equipment listings and clears their stars", async () => {
    const s = await supplier("Supplier A");
    const keep = await supplier("Supplier B");
    const m = (await one(`insert into inventory_items (name, unit) values ('Material A', 'kg') returning id`)).id;
    await pg.query(`insert into raw_material_suppliers (raw_material_id, supplier_id) values ($1, $2)`, [m, s]);
    const e1 = await equipment("Equipment A");
    const e2 = await equipment("Equipment B");
    await listing(e1, s);
    await listing(e2, s);
    const other = await listing(e2, keep);
    const r = await one(`select archive_supplier_listings($1, 'Test Person') r`, [s]);
    expect(r.r).toEqual({ raw_material_listings: 1, equipment_listings: 2 });
    expect((await one(`select count(*)::int n from equipment_suppliers where is_preferred`)).n).toBe(0);
    expect((await one(`select count(*)::int n from raw_material_suppliers where is_preferred`)).n).toBe(0);
    expect((await listingRow(other.id)).archived_at).toBeNull();
    expect((await one(`select archived_at from suppliers where id = $1`, [s])).archived_at).not.toBeNull();
    expect((await one(`select count(*)::int n from suppliers`)).n).toBe(2);
  });
});

describe("row level security", () => {
  it("read with the Procurement feature only; no browser writes; no anon", async () => {
    const e = await equipment("Equipment A");
    await listing(e, await supplier("Supplier A"));
    await addEmployee(pg, { roles: ["Admin"], email: "admin1@example.test" });
    await applyPolicies(pg);
    await pg.exec(migration("procurement_suppliers.sql"));
    await pg.exec(migration("procurement_equipment_prices.sql"));
    await asOwner(pg);
    const roleId = (await one(`insert into roles (name) values ('Raw only') returning id`)).id;
    await pg.query(`insert into role_features (role_id, feature_key) values ($1, 'inventory.raw_materials')`, [roleId]);
    const wh = await addEmployee(pg, { roles: ["Warehouse Operations"], email: "wh1@example.test" });
    const raw = await addEmployee(pg, { roles: ["Raw only"], email: "raw1@example.test" });

    await asUser(pg, wh.userId);
    for (const t of ["equipment_categories", "equipment_items", "equipment_suppliers"]) expect((await rows(`select id from ${t}`)).length, t).toBeGreaterThan(0);
    await failsWith(() => pg.query(`insert into equipment_categories (name) values ('Lab')`), /permission denied/);
    await failsWith(() => pg.query(`update equipment_items set name = 'Equipment Z'`), /permission denied/);
    await failsWith(() => pg.query(`select set_preferred_equipment_supplier($1, $1)`, [e]), /permission denied/);

    await asUser(pg, raw.userId);
    for (const t of ["equipment_categories", "equipment_items", "equipment_suppliers"]) expect((await rows(`select id from ${t}`)).length, t).toBe(0);

    await asAnon(pg);
    await failsWith(() => pg.query(`select id from equipment_items`), /permission denied/);
    await asOwner(pg);
  });
});
