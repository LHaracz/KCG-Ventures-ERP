// receiving_coa_modes.sql against the real migrations in PGlite: the relaxed
// NOT NULLs and the entry_mode check, Amazon inserted once and pinned (and
// when it already exists), a simple receipt through submit_receiving_entry
// (quantity, supplier_id, entry_mode, coa_policy_at_receipt), a payload
// that doesn't match the derived mode is rejected, a correction keeps the
// original mode, list_suppliers_for_receiving returns only id, name,
// is_pinned (and the Listed flag) and rejects users without the features,
// and coa_policies_for_release. Invented data only.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, asAnon, asOwner, asService, asUser, createAccessDb, migration } from "./helpers/accessDb";

let pg: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
const rejects = async (sql: string, params: unknown[], re: RegExp) => {
  let err: unknown = null;
  try {
    await pg.query(sql, params);
  } catch (e) {
    err = e;
  }
  expect(String((err as Error | null)?.message ?? "no error")).toMatch(re);
};

let logTypeId: string;
let matA: string; // Ingredient A (g)
let matB: string; // Ingredient B (pcs)
let supA: string; // policy included for A
let supB: string; // policy not_available for B, unknown for A
let supC: string; // no listing
let supArchived: string;

const withUser = async (roles: string[], features: string[]) => {
  const acc = await addEmployee(pg, { roles });
  if (features.length) {
    const role = (await one<{ id: string }>(`insert into roles (name) values ($1) returning id`, [`Role ${Math.random().toString(36).slice(2, 8)}`])).id;
    for (const f of features) await q(`insert into role_features (role_id, feature_key) values ($1, $2)`, [role, f]);
    await q(`insert into employee_roles (employee_id, role_id) values ($1, $2)`, [acc.accountId, role]);
  }
  return acc.userId;
};

const submit = (payload: Record<string, unknown>) =>
  q<{ r: Record<string, unknown> }>(`select submit_receiving_entry($1::jsonb) as r`, [
    JSON.stringify({ log_type_id: logTypeId, performed_at: "2026-11-20T15:00:00Z", performed_by_name: "Test Person", values: {}, template_snapshot: {}, ...payload }),
  ]).then((r) => r[0].r);

beforeAll(async () => {
  ({ pg } = await createAccessDb());
  for (const f of ["formulation.sql", "procurement_suppliers.sql"]) await pg.exec(migration(f));
  // A supplier named "amazon" (different case) does not exist yet: the migration inserts it.
  await pg.exec(migration("receiving_coa_modes.sql"));
  await pg.exec(`grant select, insert, update, delete on all tables in schema public to authenticated; grant all on all tables in schema public to service_role;`);
  logTypeId = (await one<{ id: string }>(`select id from log_types where special_type = 'receiving'`)).id;
  matA = (await one<{ id: string }>(`insert into inventory_items (name, unit, quantity_on_hand) values ('Ingredient A', 'g', 100) returning id`)).id;
  matB = (await one<{ id: string }>(`insert into inventory_items (name, unit, quantity_on_hand) values ('Ingredient B', 'pcs', 10) returning id`)).id;
  supA = (await one<{ id: string }>(`insert into suppliers (name, contact_email, payment_notes) values ('Supplier A', 'a@example.test', 'Card on file') returning id`)).id;
  supB = (await one<{ id: string }>(`insert into suppliers (name) values ('Supplier B') returning id`)).id;
  supC = (await one<{ id: string }>(`insert into suppliers (name) values ('Supplier C') returning id`)).id;
  supArchived = (await one<{ id: string }>(`insert into suppliers (name, archived_at) values ('Supplier Old', now()) returning id`)).id;
  await q(`insert into raw_material_suppliers (raw_material_id, supplier_id, coa_policy) values ($1, $2, 'included')`, [matA, supA]);
  await q(`insert into raw_material_suppliers (raw_material_id, supplier_id, coa_policy) values ($1, $2, 'unknown')`, [matA, supB]);
  await q(`insert into raw_material_suppliers (raw_material_id, supplier_id, coa_policy) values ($1, $2, 'not_available')`, [matB, supB]);
});

describe("schema", () => {
  it("relaxed NOT NULLs, the entry_mode check, and Amazon inserted once and pinned", async () => {
    const cols = await q<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns where table_name = 'receiving_details'
       and column_name in ('supplier_lot_number', 'packaging_intact', 'identity_verified', 'coa_received', 'supplier', 'internal_lot_id') order by column_name`,
    );
    expect(Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]))).toEqual({
      coa_received: "YES",
      identity_verified: "YES",
      internal_lot_id: "NO",
      packaging_intact: "YES",
      supplier: "NO",
      supplier_lot_number: "YES",
    });
    const entry = (await one<{ id: string }>(`insert into log_entries (log_type_id, performed_at, performed_by_name) values ($1, now(), 'Test Person') returning id`, [logTypeId])).id;
    await rejects(
      `insert into receiving_details (log_entry_id, raw_material_id, supplier, internal_lot_id, quantity_added_in_material_unit, material_unit_at_receipt, entry_mode) values ($1, $2, 'X', 'RM-1', 1, 'g', 'quick')`,
      [entry, matA],
      /receiving_details_entry_mode_ok/,
    );
    expect(await q(`select name, website_url, is_pinned from suppliers where lower(name) = 'amazon'`)).toEqual([{ name: "Amazon", website_url: "https://www.amazon.com", is_pinned: true }]);
    await pg.exec(migration("receiving_coa_modes.sql"));
    expect((await one<{ n: number }>(`select count(*)::int as n from suppliers where lower(name) = 'amazon'`)).n).toBe(1);
    expect((await one<{ n: number }>(`select count(*)::int as n from suppliers where is_pinned`)).n).toBe(1);
  });

  it("when Amazon already exists it is only pinned, and no other supplier changes", async () => {
    const { pg: other } = await createAccessDb();
    for (const f of ["formulation.sql", "procurement_suppliers.sql"]) await other.exec(migration(f));
    await other.query(`insert into suppliers (name, contact_name) values ('AMAZON', 'Contact A'), ('Supplier D', null)`);
    await other.exec(migration("receiving_coa_modes.sql"));
    expect((await other.query(`select name, contact_name, website_url, is_pinned from suppliers order by name`)).rows).toEqual([
      { name: "AMAZON", contact_name: "Contact A", website_url: null, is_pinned: true },
      { name: "Supplier D", contact_name: null, website_url: null, is_pinned: false },
    ]);
  });
});

describe("submit_receiving_entry", () => {
  it("a simple receipt adds the quantity in the material's unit and stores supplier_id, entry_mode and the policy", async () => {
    await asService(pg);
    const r = await submit({ raw_material_id: matB, supplier_id: supB, entry_mode: "simple", quantity_added: 24, material_unit_at_receipt: "pcs", po_or_invoice_number: "INV-1", files: [] });
    await asOwner(pg);
    expect(r).toMatchObject({ entryMode: "simple" });
    expect(await one(`select supplier, supplier_id, entry_mode, coa_policy_at_receipt, supplier_lot_number, coa_received, quantity_received_grams, quantity_added_in_material_unit::float as q from receiving_details where log_entry_id = $1`, [r.entryId])).toEqual({
      supplier: "Supplier B",
      supplier_id: supB,
      entry_mode: "simple",
      coa_policy_at_receipt: "not_available",
      supplier_lot_number: null,
      coa_received: null,
      quantity_received_grams: null,
      q: 24,
    });
    expect((await one<{ q: number }>(`select quantity_on_hand::float as q from inventory_items where id = $1`, [matB])).q).toBe(34);
    expect((await one(`select values->>'supplier' as s from log_entries where id = $1`, [r.entryId]))).toEqual({ s: "Supplier B" });
  });

  it("no listing is simple; a full-policy pair needs the full payload; a mismatched payload is rejected", async () => {
    await asService(pg);
    const noListing = await submit({ raw_material_id: matA, supplier_id: supC, entry_mode: "simple", quantity_added: 5, material_unit_at_receipt: "g" });
    expect(noListing).toMatchObject({ entryMode: "simple" });
    await rejects(`select submit_receiving_entry($1::jsonb)`, [JSON.stringify({ log_type_id: logTypeId, performed_at: "2026-11-20T15:00:00Z", raw_material_id: matA, supplier_id: supA, entry_mode: "simple", quantity_added: 5, material_unit_at_receipt: "g" })], /expected the full form/);
    await rejects(`select submit_receiving_entry($1::jsonb)`, [JSON.stringify({ log_type_id: logTypeId, performed_at: "2026-11-20T15:00:00Z", raw_material_id: matB, supplier_id: supB, entry_mode: "full", quantity_added: 5, material_unit_at_receipt: "pcs", supplier_lot_number: "L1", packaging_intact: true, identity_verified: true, coa_received: false })], /expected the simple form/);
    await rejects(`select submit_receiving_entry($1::jsonb)`, [JSON.stringify({ log_type_id: logTypeId, performed_at: "2026-11-20T15:00:00Z", raw_material_id: matB, supplier_id: supB, entry_mode: "simple", quantity_added: 5, material_unit_at_receipt: "pcs", coa_received: true })], /simple receipt has no lot number/);
    await rejects(`select submit_receiving_entry($1::jsonb)`, [JSON.stringify({ log_type_id: logTypeId, performed_at: "2026-11-20T15:00:00Z", raw_material_id: matA, supplier_id: supArchived, entry_mode: "simple", quantity_added: 5, material_unit_at_receipt: "g" })], /Choose a supplier from the list/);
    const forced = await submit({ raw_material_id: matB, supplier_id: supB, entry_mode: "full", forced_full: true, quantity_added: 2, material_unit_at_receipt: "pcs", supplier_lot_number: "L2", packaging_intact: true, identity_verified: true, coa_received: true, files: [] });
    expect(forced).toMatchObject({ entryMode: "full" });
    const full = await submit({ raw_material_id: matA, supplier_id: supA, entry_mode: "full", quantity_added: 0.5, quantity_received_grams: 500, material_unit_at_receipt: "kg", supplier_lot_number: "L3", packaging_intact: true, identity_verified: true, coa_received: true, files: [] });
    await asOwner(pg);
    expect(await one(`select entry_mode, coa_policy_at_receipt, supplier_lot_number from receiving_details where log_entry_id = $1`, [full.entryId])).toEqual({ entry_mode: "full", coa_policy_at_receipt: "included", supplier_lot_number: "L3" });
  });

  it("a correction keeps the original mode, supplier and lot ID, and adjusts by the difference", async () => {
    await asService(pg);
    const orig = await submit({ raw_material_id: matB, supplier_id: supB, entry_mode: "simple", quantity_added: 10, material_unit_at_receipt: "pcs" });
    const before = (await one<{ q: number }>(`select quantity_on_hand::float as q from inventory_items where id = $1`, [matB])).q;
    // Even if the listing now says "included", the correction stays simple.
    await asOwner(pg);
    await q(`update raw_material_suppliers set coa_policy = 'included' where raw_material_id = $1 and supplier_id = $2`, [matB, supB]);
    await asService(pg);
    await rejects(`select submit_receiving_entry($1::jsonb)`, [JSON.stringify({ log_type_id: logTypeId, performed_at: "2026-11-20T15:00:00Z", corrects_entry_id: orig.entryId, correction_reason: "Miscount", entry_mode: "full", quantity_added: 12, material_unit_at_receipt: "pcs", supplier_lot_number: "L", packaging_intact: true, identity_verified: true, coa_received: true })], /expected the simple form/);
    const fix = await submit({ corrects_entry_id: orig.entryId, correction_reason: "Miscount", entry_mode: "simple", quantity_added: 12, original_quantity_added: 10, material_unit_at_receipt: "pcs" });
    await asOwner(pg);
    expect(await one(`select entry_mode, supplier_id, internal_lot_id = $2 as same_lot from receiving_details where log_entry_id = $1`, [fix.entryId, orig.internalLotId])).toEqual({ entry_mode: "simple", supplier_id: supB, same_lot: true });
    expect((await one<{ q: number }>(`select quantity_on_hand::float as q from inventory_items where id = $1`, [matB])).q).toBe(before + 2);
    await q(`update raw_material_suppliers set coa_policy = 'not_available' where raw_material_id = $1 and supplier_id = $2`, [matB, supB]);
  });

  it("an old receipt (no mode) is corrected as a full receipt and keeps a null mode", async () => {
    const entry = (await one<{ id: string }>(`insert into log_entries (log_type_id, performed_at, performed_by_name) values ($1, now(), 'Test Person') returning id`, [logTypeId])).id;
    await q(
      `insert into receiving_details (log_entry_id, raw_material_id, supplier, supplier_lot_number, internal_lot_id, quantity_added_in_material_unit, material_unit_at_receipt, packaging_intact, identity_verified, coa_received)
       values ($1, $2, 'Typed supplier', 'OLD-1', 'RM-20260101-001', 3, 'g', true, true, true)`,
      [entry, matA],
    );
    await asService(pg);
    const fix = await submit({ corrects_entry_id: entry, correction_reason: "Typo", entry_mode: "full", quantity_added: 4, original_quantity_added: 3, material_unit_at_receipt: "g", packaging_intact: true, identity_verified: true, coa_received: true });
    await asOwner(pg);
    expect(await one(`select entry_mode, supplier, supplier_lot_number from receiving_details where log_entry_id = $1`, [fix.entryId])).toEqual({ entry_mode: null, supplier: "Typed supplier", supplier_lot_number: "OLD-1" });
  });
});

describe("lookups", () => {
  it("list_suppliers_for_receiving: only id, name, is_pinned and Listed, pinned first, non-archived; feature-checked", async () => {
    const logsUser = await withUser([], ["compliance.logs"]);
    const rawUser = await withUser([], ["inventory.raw_materials"]);
    const outsider = await withUser([], ["growth.marketing"]);
    await asUser(pg, logsUser);
    const rows = await q(`select * from list_suppliers_for_receiving($1)`, [matA]);
    expect(Object.keys(rows[0]).sort()).toEqual(["id", "is_pinned", "listed_for", "name"]);
    expect(rows.map((r) => [r.name, r.is_pinned, r.listed_for])).toEqual([
      ["Amazon", true, false],
      ["Supplier A", false, true],
      ["Supplier B", false, true],
      ["Supplier C", false, false],
    ]);
    expect(await q(`select coa_policy_for($1, $2) as p`, [matA, supA])).toEqual([{ p: "included" }]);
    expect(await q(`select coa_policy_for($1, $2) as p`, [matA, supC])).toEqual([{ p: null }]);
    await asUser(pg, rawUser);
    expect((await q(`select * from list_suppliers_for_receiving()`)).length).toBe(4);
    await asUser(pg, outsider);
    await rejects(`select * from list_suppliers_for_receiving()`, [], /do not have access/);
    await rejects(`select coa_policy_for($1, $2)`, [matA, supA], /do not have access/);
    await asAnon(pg);
    await rejects(`select * from list_suppliers_for_receiving()`, [], /permission denied|do not have access/);
    await asOwner(pg);
  });

  it("coa_policies_for_release: preferred active listing only, two columns, feature-checked, at most 200 ids", async () => {
    const matC = (await one<{ id: string }>(`insert into inventory_items (name, unit) values ('Ingredient C', 'g') returning id`)).id;
    // Ingredient A: Supplier A (its first listing) is preferred automatically; Supplier B's listing is not.
    const planner = await withUser([], ["production.planner"]);
    const logsUser = await withUser([], ["compliance.logs"]);
    const rawUser = await withUser([], ["inventory.raw_materials"]);
    const outsider = await withUser([], ["growth.marketing"]);
    for (const u of [planner, logsUser, rawUser]) {
      await asUser(pg, u);
      const rows = await q(`select * from coa_policies_for_release($1::uuid[]) order by raw_material_id`, [[matA, matB, matC]]);
      expect(Object.keys(rows[0]).sort()).toEqual(["coa_policy", "raw_material_id"]);
      expect(Object.fromEntries(rows.map((r) => [r.raw_material_id, r.coa_policy]))).toEqual({ [matA]: "included", [matB]: "not_available", [matC]: null });
    }
    await asOwner(pg);
    const linkB = (await one<{ id: string }>(`select id from raw_material_suppliers where raw_material_id = $1 and supplier_id = $2`, [matA, supB])).id;
    await q(`select set_preferred_supplier($1, $2)`, [matA, linkB]);
    await asUser(pg, planner);
    // Supplier A's "included" listing is no longer preferred, so only Supplier B's counts.
    expect((await one(`select coa_policy from coa_policies_for_release($1::uuid[])`, [[matA]])).coa_policy).toBe("unknown");
    await asOwner(pg);
    await q(`update raw_material_suppliers set archived_at = now() where raw_material_id = $1 and supplier_id = $2`, [matB, supB]);
    await asUser(pg, planner);
    expect((await one(`select coa_policy from coa_policies_for_release($1::uuid[])`, [[matB]])).coa_policy).toBeNull(); // archived listings are ignored
    const many = Array.from({ length: 201 }, () => matA);
    await rejects(`select * from coa_policies_for_release($1::uuid[])`, [many], /at most 200/);
    await asUser(pg, outsider);
    await rejects(`select * from coa_policies_for_release($1::uuid[])`, [[matA]], /do not have access/);
    await asAnon(pg);
    await rejects(`select * from coa_policies_for_release($1::uuid[])`, [[matA]], /permission denied|do not have access/);
    await asOwner(pg);
  });
});
