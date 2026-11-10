/* eslint-disable @typescript-eslint/no-explicit-any */
// procurement_suppliers.sql against the real migration SQL in PGlite.
// Invented suppliers ("Supplier A"), materials and example.test addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, applyPolicies, asAnon, asOwner, asUser, createAccessDb, migration } from "./helpers/accessDb";

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

async function material(name: string) {
  return (await one<{ id: string }>(`insert into inventory_items (name, unit, par_level, quantity_on_hand) values ($1, 'kg', 10, 0) returning id`, [name])).id;
}
async function supplier(name: string, extra: Record<string, unknown> = {}) {
  const cols = ["name", ...Object.keys(extra)];
  const vals = [name, ...Object.values(extra)];
  return (await one<{ id: string }>(
    `insert into suppliers (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    vals,
  )).id;
}
async function link(rawId: string, supplierId: string, extra: Record<string, unknown> = {}) {
  const cols = ["raw_material_id", "supplier_id", ...Object.keys(extra)];
  const vals = [rawId, supplierId, ...Object.values(extra)];
  return one<any>(
    `insert into raw_material_suppliers (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    vals,
  );
}
const linkRow = (id: string) => one<any>(`select * from raw_material_suppliers where id = $1`, [id]);

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(migration("procurement_suppliers.sql"));
});

describe("migration", () => {
  it("can run twice", async () => {
    await pg.exec(migration("procurement_suppliers.sql"));
    expect((await one(`select count(*)::int n from pg_policies where tablename = 'suppliers'`)).n).toBe(1);
  });
});

describe("preferred supplier", () => {
  it("the first active supplier becomes preferred, later ones do not", async () => {
    const m = await material("Material One");
    const a = await link(m, await supplier("Supplier A"));
    const b = await link(m, await supplier("Supplier B"));
    expect(a.is_preferred).toBe(true);
    expect(b.is_preferred).toBe(false);
  });

  it("allows at most one active preferred link per raw material", async () => {
    const m = await material("Material One");
    await link(m, await supplier("Supplier A"));
    const sb = await supplier("Supplier B");
    await failsWith(() => link(m, sb, { is_preferred: true }), /rms_one_preferred_unique|duplicate key/);
  });

  it("set_preferred_supplier moves the star in one step", async () => {
    const m = await material("Material One");
    const a = await link(m, await supplier("Supplier A"));
    const b = await link(m, await supplier("Supplier B"));
    await pg.query(`select set_preferred_supplier($1, $2)`, [m, b.id]);
    expect((await linkRow(a.id)).is_preferred).toBe(false);
    expect((await linkRow(b.id)).is_preferred).toBe(true);
    const n = await one(`select count(*)::int n from raw_material_suppliers where raw_material_id = $1 and is_preferred`, [m]);
    expect(n.n).toBe(1);
  });

  it("set_preferred_supplier rejects an archived link or one from another material, and changes nothing", async () => {
    const m1 = await material("Material One");
    const m2 = await material("Material Two");
    const sa = await supplier("Supplier A");
    const a = await link(m1, sa);
    const b = await link(m1, await supplier("Supplier B"));
    const other = await link(m2, sa);
    await pg.query(`update raw_material_suppliers set archived_at = now() where id = $1`, [b.id]);
    await failsWith(() => pg.query(`select set_preferred_supplier($1, $2)`, [m1, b.id]), /not found for this raw material, or it is archived/);
    await failsWith(() => pg.query(`select set_preferred_supplier($1, $2)`, [m1, other.id]), /not found for this raw material/);
    expect((await linkRow(a.id)).is_preferred).toBe(true);
  });
});

describe("unique active pair", () => {
  it("one active link per material and supplier; a new one is allowed after archiving", async () => {
    const m = await material("Material One");
    const s = await supplier("Supplier A");
    const first = await link(m, s);
    await failsWith(() => link(m, s), /rms_active_pair_unique|duplicate key/);
    await pg.query(`update raw_material_suppliers set archived_at = now() where id = $1`, [first.id]);
    const again = await link(m, s);
    expect(again.id).not.toBe(first.id);
  });

  it("supplier names are unique ignoring case and spaces", async () => {
    await supplier("Supplier A");
    await failsWith(() => supplier("  supplier a "), /suppliers_name_unique|duplicate key/);
  });
});

describe("validation", () => {
  it("links and websites must be http(s) and at most 2000 characters", async () => {
    const m = await material("Material One");
    const s = await supplier("Supplier A", { website_url: "https://supplier-a.example.test" });
    for (const bad of ["javascript:alert(1)", "ftp://files.example.test", "supplier-a.example.test", "https://has space.example.test", `https://example.test/${"a".repeat(2000)}`]) {
      await failsWith(() => link(m, s, { product_url: bad }), /rms_product_url_ok/);
      await failsWith(() => supplier(`Bad ${bad.slice(0, 20)}`, { website_url: bad }), /suppliers_website_url_ok/);
    }
    const ok = await link(m, s, { product_url: "http://supplier-a.example.test/item?id=1" });
    expect(ok.product_url).toContain("http://");
  });

  it("emails must look like an email", async () => {
    await failsWith(() => supplier("Supplier B", { contact_email: "not-an-email" }), /suppliers_contact_email_ok/);
    await failsWith(() => supplier("Supplier C", { contact_email: "a@b" }), /suppliers_contact_email_ok/);
    expect(await supplier("Supplier D", { contact_email: "orders@supplier-d.example.test" })).toBeTruthy();
  });

  it("text limits, payment methods, payment terms and COA policy", async () => {
    await failsWith(() => supplier("Supplier B", { ordering_notes: "x".repeat(2001) }), /suppliers_ordering_notes_len/);
    await failsWith(() => supplier("Supplier C", { city: "x".repeat(201) }), /suppliers_address_len/);
    await failsWith(() => supplier("Supplier D", { payment_methods: ["credit_card", "bitcoin"] }), /suppliers_payment_methods_ok/);
    await failsWith(() => supplier("Supplier E", { default_po_payment_terms: "Net 90" }), /suppliers_default_po_payment_terms_ok/);
    await failsWith(() => supplier("", {}), /suppliers_name_len/);
    const s = await supplier("Supplier F", { payment_methods: ["credit_card", "po_required"], default_po_payment_terms: "Net 30" });
    const m = await material("Material One");
    await failsWith(() => link(m, s, { coa_policy: "sometimes" }), /rms_coa_policy_ok/);
    await failsWith(() => link(m, s, { notes: "x".repeat(2001) }), /rms_notes_len/);
    expect((await link(m, s)).coa_policy).toBe("unknown");
  });
});

describe("link_updated_at", () => {
  it("is set when a link is added, kept on other edits, updated when the link changes, cleared when removed", async () => {
    const m = await material("Material One");
    const s = await supplier("Supplier A");
    const noLink = await link(m, s);
    expect(noLink.link_updated_at).toBeNull();

    const m2 = await material("Material Two");
    const l = await link(m2, s, { product_url: "https://supplier-a.example.test/one" });
    expect(l.link_updated_at).not.toBeNull();
    const t0 = new Date(l.link_updated_at).getTime();

    await new Promise((r) => setTimeout(r, 15));
    await pg.query(`update raw_material_suppliers set notes = 'Order by noon', link_updated_at = '2000-01-01' where id = $1`, [l.id]);
    const afterNotes = await linkRow(l.id);
    expect(new Date(afterNotes.link_updated_at).getTime()).toBe(t0);
    expect(new Date(afterNotes.updated_at).getTime()).toBeGreaterThan(new Date(l.updated_at).getTime());

    await new Promise((r) => setTimeout(r, 15));
    await pg.query(`update raw_material_suppliers set product_url = 'https://supplier-a.example.test/two' where id = $1`, [l.id]);
    expect(new Date((await linkRow(l.id)).link_updated_at).getTime()).toBeGreaterThan(t0);

    await pg.query(`update raw_material_suppliers set product_url = null where id = $1`, [l.id]);
    expect((await linkRow(l.id)).link_updated_at).toBeNull();
  });
});

describe("archive", () => {
  it("archiving the preferred link clears its star and promotes nobody", async () => {
    const m = await material("Material One");
    const a = await link(m, await supplier("Supplier A"));
    const b = await link(m, await supplier("Supplier B"));
    await pg.query(`update raw_material_suppliers set archived_at = now() where id = $1`, [a.id]);
    expect((await linkRow(a.id)).is_preferred).toBe(false);
    expect((await linkRow(b.id)).is_preferred).toBe(false);
  });

  it("archive_supplier archives the supplier and all its active links", async () => {
    const m1 = await material("Material One");
    const m2 = await material("Material Two");
    const s = await supplier("Supplier A");
    const l1 = await link(m1, s);
    const l2 = await link(m2, s);
    const n = await one(`select archive_supplier($1, 'Test Person') n`, [s]);
    expect(n.n).toBe(2);
    expect((await linkRow(l1.id)).archived_at).not.toBeNull();
    expect((await linkRow(l2.id)).is_preferred).toBe(false);
    const sup = await one(`select archived_at, updated_by_name from suppliers where id = $1`, [s]);
    expect(sup.archived_at).not.toBeNull();
    expect(sup.updated_by_name).toBe("Test Person");
    await failsWith(() => pg.query(`select archive_supplier($1, 'Test Person')`, [s]), /already archived/);
  });

  it("suppliers and links are never hard-deleted", async () => {
    const m = await material("Material One");
    const s = await supplier("Supplier A");
    const l = await link(m, s);
    await failsWith(() => pg.query(`delete from suppliers where id = $1`, [s]), /never deleted/);
    await failsWith(() => pg.query(`delete from raw_material_suppliers where id = $1`, [l.id]), /never deleted/);
  });

  it("deleting a raw material on the Raw Materials page takes its links with it", async () => {
    const m = await material("Material One");
    const s = await supplier("Supplier A");
    await link(m, s);
    await pg.query(`delete from inventory_items where id = $1`, [m]);
    expect((await one(`select count(*)::int n from raw_material_suppliers`)).n).toBe(0);
    expect((await one(`select count(*)::int n from suppliers`)).n).toBe(1);
  });
});

describe("row level security", () => {
  it("only active employees with the Purchase Orders feature can read; nobody writes from the browser", async () => {
    const m = await material("Material One");
    const s = await supplier("Supplier A");
    await link(m, s);
    await addEmployee(pg, { roles: ["Admin"], email: "admin1@example.test" });
    await applyPolicies(pg);
    // applyPolicies re-grants all tables to authenticated (test helper); put this migration's grants back.
    await pg.exec(migration("procurement_suppliers.sql"));

    await asOwner(pg);
    const roleId = (await one<{ id: string }>(`insert into roles (name) values ('Raw only') returning id`)).id;
    await pg.query(`insert into role_features (role_id, feature_key) values ($1, 'inventory.raw_materials')`, [roleId]);
    const warehouse = await addEmployee(pg, { roles: ["Warehouse Operations"], email: "wh1@example.test" });
    const rawOnly = await addEmployee(pg, { roles: ["Raw only"], email: "raw1@example.test" });
    const gone = await addEmployee(pg, { roles: ["Warehouse Operations"], status: "deactivated", email: "gone1@example.test" });

    await asUser(pg, warehouse.userId);
    expect((await rows(`select id from suppliers`)).length).toBe(1);
    expect((await rows(`select id from raw_material_suppliers`)).length).toBe(1);
    await failsWith(() => pg.query(`insert into suppliers (name) values ('Supplier Z')`), /permission denied/);
    await failsWith(() => pg.query(`update suppliers set name = 'Supplier Y'`), /permission denied/);
    await failsWith(() => pg.query(`select set_preferred_supplier($1, $1)`, [m]), /permission denied/);

    await asUser(pg, rawOnly.userId);
    expect((await rows(`select id from suppliers`)).length).toBe(0);
    expect((await rows(`select id from raw_material_suppliers`)).length).toBe(0);

    await asUser(pg, gone.userId);
    expect((await rows(`select id from suppliers`)).length).toBe(0);

    await asAnon(pg);
    await failsWith(() => pg.query(`select id from suppliers`), /permission denied/);
    await asOwner(pg);
  });
});
