// procurement_equipment_delete.sql against the real migration SQL in PGlite.
// Invented equipment ("Equipment A"), suppliers ("Supplier A"), materials
// ("Material A") and example.test addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, asAnon, asOwner, asService, asUser, createAccessDb, migration } from "./helpers/accessDb";

let pg: PGlite;
let adminUser: string;
let staffUser: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
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

const supplier = async (name: string) => (await one(`insert into suppliers (name) values ($1) returning id`, [name])).id as string;
const equipment = async (name: string) =>
  (await one(`insert into equipment_items (name, category_id) values ($1, (select id from equipment_categories where name = 'Production')) returning id`, [name])).id as string;
const listing = async (eq: string, sup: string, archived = false) => {
  await pg.query(`insert into equipment_suppliers (equipment_id, supplier_id) values ($1, $2)`, [eq, sup]);
  if (archived) await pg.query(`update equipment_suppliers set archived_at = now() where equipment_id = $1 and supplier_id = $2`, [eq, sup]);
};
const material = async (name: string) => (await one(`insert into inventory_items (name, unit) values ($1, 'kg') returning id`, [name])).id as string;
const rmListing = async (m: string, sup: string, archived = false) => {
  await pg.query(`insert into raw_material_suppliers (raw_material_id, supplier_id) values ($1, $2)`, [m, sup]);
  if (archived) await pg.query(`update raw_material_suppliers set archived_at = now() where raw_material_id = $1 and supplier_id = $2`, [m, sup]);
};

/** Calls the function as the given user (authenticated role, like the app). */
async function del(user: string, eq: string, expected: string[], actor: string | null = "Test Person") {
  await asUser(pg, user);
  try {
    return (await one(`select delete_equipment_item($1, $2::uuid[], $3) as r`, [eq, expected, actor])).r as {
      equipment_name: string;
      deleted_suppliers: Array<{ id: string; name: string }>;
      kept_suppliers: Array<{ id: string; name: string; reason: string }>;
    };
  } finally {
    await asOwner(pg);
  }
}
const exists = async (table: string, id: string) => (await rows(`select 1 from ${table} where id = $1`, [id])).length === 1;
const snapshot = async () => ({
  eq: await rows(`select id from equipment_items order by id`),
  es: await rows(`select id, archived_at from equipment_suppliers order by id`),
  sup: await rows(`select id from suppliers order by id`),
  rms: await rows(`select * from raw_material_suppliers order by id`),
  mats: await rows(`select * from inventory_items order by id`),
  log: await rows(`select id from procurement_delete_log`),
});

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(migration("procurement_suppliers.sql"));
  await pg.exec(migration("procurement_equipment_prices.sql"));
  await pg.exec(migration("procurement_equipment_delete.sql"));
  adminUser = (await addEmployee(pg, { roles: ["Admin"], email: "admin1@example.test" })).userId;
  staffUser = (await addEmployee(pg, { roles: ["Warehouse Operations"], email: "staff1@example.test" })).userId;
});

describe("delete_equipment_item", () => {
  it("can run twice", async () => {
    await pg.exec(migration("procurement_equipment_delete.sql"));
  });

  it("deletes the equipment and a supplier used only for it", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    await listing(e, s);
    const r = await del(adminUser, e, [s]);
    expect(r.equipment_name).toBe("Equipment A");
    expect(r.deleted_suppliers).toEqual([{ id: s, name: "Supplier A" }]);
    expect(r.kept_suppliers).toEqual([]);
    expect(await exists("equipment_items", e)).toBe(false);
    expect(await exists("suppliers", s)).toBe(false);
    expect(await rows(`select 1 from equipment_suppliers`)).toHaveLength(0);
  });

  it("keeps a supplier also listed for a raw material", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    await listing(e, s);
    await rmListing(await material("Material A"), s);
    const r = await del(adminUser, e, [s]);
    expect(r.kept_suppliers).toEqual([{ id: s, name: "Supplier A", reason: "used for other ingredients or equipment" }]);
    expect(await exists("suppliers", s)).toBe(true);
    expect(await exists("equipment_items", e)).toBe(false);
  });

  it("keeps a supplier also listed for another equipment item", async () => {
    const e = await equipment("Equipment A");
    const other = await equipment("Equipment B");
    const s = await supplier("Supplier A");
    await listing(e, s);
    await listing(other, s);
    const r = await del(adminUser, e, [s]);
    expect(r.kept_suppliers.map((k) => k.reason)).toEqual(["used for other ingredients or equipment"]);
    expect(await exists("suppliers", s)).toBe(true);
    expect(await rows(`select 1 from equipment_suppliers where equipment_id = $1`, [other])).toHaveLength(1);
  });

  it("keeps a supplier whose only other listing is archived", async () => {
    const e = await equipment("Equipment A");
    const other = await equipment("Equipment B");
    const s = await supplier("Supplier A");
    const t = await supplier("Supplier B");
    await listing(e, s);
    await listing(other, s, true);
    await listing(e, t);
    await rmListing(await material("Material A"), t, true);
    const r = await del(adminUser, e, [s, t]);
    expect(r.deleted_suppliers).toEqual([]);
    expect(r.kept_suppliers.map((k) => k.name).sort()).toEqual(["Supplier A", "Supplier B"]);
  });

  it("deletes a supplier whose listing on this equipment is archived", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    await listing(e, s, true);
    const r = await del(adminUser, e, [s]);
    expect(r.deleted_suppliers.map((d) => d.name)).toEqual(["Supplier A"]);
    expect(await exists("suppliers", s)).toBe(false);
  });

  it("keeps a supplier that is not in the expected list", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    await listing(e, s);
    const r = await del(adminUser, e, []);
    expect(r.kept_suppliers).toEqual([{ id: s, name: "Supplier A", reason: "not in the confirmed list" }]);
    expect(await exists("suppliers", s)).toBe(true);
  });

  it("deletes equipment with no suppliers", async () => {
    const e = await equipment("Equipment A");
    const r = await del(adminUser, e, []);
    expect(r).toEqual({ equipment_name: "Equipment A", deleted_suppliers: [], kept_suppliers: [] });
    expect(await exists("equipment_items", e)).toBe(false);
  });

  it("a missing id errors without changing anything", async () => {
    const e = await equipment("Equipment A");
    await listing(e, await supplier("Supplier A"));
    const before = await snapshot();
    await failsWith(() => del(adminUser, "00000000-0000-4000-8000-000000000099", []), /Equipment not found/);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a non-admin, anon and the service role without changing anything", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    await listing(e, s);
    const before = await snapshot();
    await failsWith(() => del(staffUser, e, [s]), /Only an Admin/);
    await asAnon(pg);
    await failsWith(() => pg.query(`select delete_equipment_item($1, $2::uuid[], 'x')`, [e, [s]]), /permission denied/);
    await asService(pg);
    await failsWith(() => pg.query(`select delete_equipment_item($1, $2::uuid[], 'x')`, [e, [s]]), /permission denied/);
    await asOwner(pg);
    expect(await snapshot()).toEqual(before);
  });

  it("a failure part way rolls everything back, and the no-delete guards stay on", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    await listing(e, s);
    const before = await snapshot();
    // The log row fails its length check after the deletes ran.
    await failsWith(() => del(adminUser, e, [s], "x".repeat(300)), /pdl_deleted_by_name_len|check constraint/);
    expect(await snapshot()).toEqual(before);
    await failsWith(() => pg.query(`delete from suppliers where id = $1`, [s]), /never deleted/);
    await failsWith(() => pg.query(`delete from equipment_items where id = $1`, [e]), /never deleted/);
    await failsWith(() => pg.query(`delete from equipment_suppliers`), /never deleted/);
  });

  it("writes the log row, readable by Admins only", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    const t = await supplier("Supplier B");
    await listing(e, s);
    await listing(e, t);
    await listing(await equipment("Equipment B"), t);
    await del(adminUser, e, [s, t], "Test Person");
    const log = await one(`select * from procurement_delete_log`);
    expect(log).toMatchObject({ deleted_by_name: "Test Person", equipment_name: "Equipment A", deleted_supplier_names: ["Supplier A"], kept_supplier_names: ["Supplier B"] });
    await asUser(pg, adminUser);
    expect(await rows(`select id from procurement_delete_log`)).toHaveLength(1);
    await asUser(pg, staffUser);
    expect(await rows(`select id from procurement_delete_log`)).toHaveLength(0);
    await failsWith(() => pg.query(`insert into procurement_delete_log (equipment_name) values ('Equipment Z')`), /permission denied|row-level security/);
    await asAnon(pg);
    await failsWith(() => pg.query(`select id from procurement_delete_log`), /permission denied/);
    await asOwner(pg);
  });

  it("never changes raw_material_suppliers rows or raw materials", async () => {
    const e = await equipment("Equipment A");
    const s = await supplier("Supplier A");
    const t = await supplier("Supplier B");
    await listing(e, s);
    await listing(e, t);
    const m = await material("Material A");
    await rmListing(m, s);
    await rmListing(await material("Material B"), t, true);
    const rmsBefore = await rows(`select * from raw_material_suppliers order by id`);
    const matsBefore = await rows(`select * from inventory_items order by id`);
    await del(adminUser, e, [s, t]);
    expect(await rows(`select * from raw_material_suppliers order by id`)).toEqual(rmsBefore);
    expect(await rows(`select * from inventory_items order by id`)).toEqual(matsBefore);
  });
});
