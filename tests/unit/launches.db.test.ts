// Launch Pipeline server code against the real migrations in PGlite: create
// from the default checklist, sync from the formula (draft before final),
// shortfalls, order-by dates and the earliest test batch date, shifting
// dates, marking ordered and arrived, automatic arrival from the Receiving
// Log with Undo, automatic tasks, duplicate, Create PO with the explicit
// quantity, and no supplier prices in planning data. Invented data only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  createLaunch,
  ingredientAction,
  launchPlanningData,
  listLaunches,
  loadLaunchDetail,
  shiftLaunchTasks,
  syncFromFormula,
  tasksDue,
  updateLaunch,
  updateTask,
} from "@/lib/growth/launches";
import { loadLaunchPoPrefill } from "@/lib/procurement/service";
import { GrowthError } from "@/lib/growth/errors";
import type { Db } from "@/lib/growth/routeHelpers";

let pg: PGlite;
let db: Db;
const TODAY = "2026-11-17";
let fp: string;
let matA: string;
let matB: string;
let pack: string;
let supA: string;
let supB: string;
let linkA: string;
let linkB: string;

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0];
const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect((err as Error).message).toMatch(re);
  return err as GrowthError;
};

async function receive(materialId: string, performedAt: string, correctsId: string | null = null) {
  const type = await one<{ id: string }>(`select id from log_types order by name limit 1`);
  const e = await one<{ id: string }>(
    `insert into log_entries (log_type_id, performed_at, performed_by_name, corrects_entry_id) values ($1, $2, 'Test Person', $3) returning id`,
    [type.id, performedAt, correctsId],
  );
  await pg.query(
    `insert into receiving_details (log_entry_id, raw_material_id, supplier, supplier_lot_number, internal_lot_id, quantity_added_in_material_unit, material_unit_at_receipt, packaging_intact, identity_verified, coa_received)
     values ($1, $2, 'Supplier A', 'LOT-1', 'INT-1', 1, 'kg', true, true, true)`,
    [e.id, materialId],
  );
  return e.id;
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
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "procurement_equipment_prices.sql", "retail_invoices.sql", "marketing_sales.sql"]) await pg.exec(migration(f));
  await pg.exec(`alter table suppliers add column if not exists is_pinned boolean not null default false;`); // receiving_coa_modes.sql
  db = pgliteSupabase(pg) as unknown as Db;

  fp = (await one<{ id: string }>(`insert into formulation_products (name) values ('Product A') returning id`)).id;
  matA = (await one<{ id: string }>(`insert into inventory_items (name, unit, quantity_on_hand, par_level) values ('Material A', 'g', 100, 500) returning id`)).id;
  matB = (await one<{ id: string }>(`insert into inventory_items (name, unit, quantity_on_hand, par_level) values ('Material B', 'kg', 0, 5) returning id`)).id;
  pack = (await one<{ id: string }>(`insert into inventory_items (name, unit, quantity_on_hand) values ('Tube A', 'each', 1000) returning id`)).id;
  supA = (await one<{ id: string }>(`insert into suppliers (name, contact_email, payment_notes) values ('Supplier A', 'orders@supplier-a.example.test', 'SECRET-PAY') returning id`)).id;
  supB = (await one<{ id: string }>(`insert into suppliers (name) values ('Supplier B') returning id`)).id;
  linkA = (await one<{ id: string }>(
    `insert into raw_material_suppliers (raw_material_id, supplier_id, is_preferred, lead_time_days, price, product_url) values ($1, $2, true, 14, 12.5, 'https://supplier-a.example.test/a') returning id`,
    [matA, supA],
  )).id;
  linkB = (await one<{ id: string }>(`insert into raw_material_suppliers (raw_material_id, supplier_id, is_preferred, lead_time_days) values ($1, $2, true, 30) returning id`, [matB, supB])).id;
  // Final v1 and a live draft v2 (draft wins).
  const v1 = await one<{ id: string }>(`insert into formulations (formulation_product_id, version_number, status) values ($1, 1, 'final') returning id`, [fp]);
  await pg.query(`insert into formulation_lines (formulation_id, raw_material_id, qty_per_unit) values ($1, $2, 1)`, [v1.id, matA]);
  const v2 = await one<{ id: string }>(`insert into formulations (formulation_product_id, version_number, status) values ($1, 2, 'draft') returning id`, [fp]);
  await pg.query(
    `insert into formulation_lines (formulation_id, raw_material_id, qty_per_unit, line_type) values ($1, $2, 1.5, 'inventory_item'), ($1, $2, 0.25, 'inventory_item'), ($1, $3, 0.02, 'inventory_item'), ($1, $4, 1, 'packaging')`,
    [v2.id, matA, matB, pack],
  );
}, 120_000);

async function newLaunch(over: Record<string, unknown> = {}) {
  const l = await createLaunch(
    db,
    { launch: { name: "Launch A", formulation_product_id: fp, target_launch_date: "2027-01-15", planned_test_batch_date: "2026-12-18", test_batch_units: "200", buffer_days: 2, ...over } },
    "Test Person",
  );
  return l.id;
}

describe("planning data", () => {
  it("uses the live draft, sums lines per material, and never returns prices, contacts or links", async () => {
    const p = await launchPlanningData(db, { formulation_product_id: fp });
    expect(p.formula?.label).toBe("Draft v2 (live)");
    expect(p.materials.map((m) => [m.name, m.per_unit, m.line_type])).toEqual([
      ["Material A", "1.75", "inventory_item"],
      ["Material B", "0.02", "inventory_item"],
      ["Tube A", "1", "packaging"],
    ]);
    const json = JSON.stringify(p);
    for (const secret of ["12.5", "supplier-a.example.test", "SECRET-PAY", "orders@", "price", "product_url", "payment"]) expect(json).not.toContain(secret);
    await pg.query(`update formulations set status = 'final' where version_number = 2`);
    expect((await launchPlanningData(db, { formulation_product_id: fp })).formula?.label).toBe("Final v2");
  });
});

describe("launches", () => {
  it("create from the default checklist, sync, plan, shift and the slip", async () => {
    const id = await newLaunch();
    let d = await loadLaunchDetail(db, id, { actor: "Test Person", today: TODAY });
    expect(d.tasks).toHaveLength(18);
    // Longest preferred lead time (30) + buffer 2 before the planned test batch.
    expect(d.tasks.find((t) => t.title === "Order test batch ingredients")?.due_date).toBe("2026-11-16");
    expect(d.ingredients).toEqual([]);

    expect(await syncFromFormula(db, id, "Test Person")).toMatchObject({ added: 3, removed: 0 });
    d = await loadLaunchDetail(db, id, { actor: "Test Person", today: TODAY });
    const row = (name: string) => d.ingredients.find((r) => r.material?.name === name)!;
    expect(row("Material A").plan).toMatchObject({ needed: "350", onHand: "100", shortfall: "250", state: "to_order", orderBy: "2026-12-02", arrivalIfOrderedToday: "2026-12-01" });
    expect(row("Material B").plan).toMatchObject({ needed: "4", shortfall: "4", orderBy: "2026-11-16", lateByDays: 1, arrivalIfOrderedToday: "2026-12-17" });
    expect(row("Tube A").plan?.state).toBe("enough");
    expect(row("Material A").supplier?.supplier_name).toBe("Supplier A");
    expect(d.plan.earliestTestBatchDate).toBe("2026-12-17");
    expect(d.plan.slipDays).toBe(0);
    expect(d.risk).toBe("late"); // "Order test batch ingredients" was due yesterday

    // Plan a test batch sooner: it slips; shift the open tasks.
    await updateLaunch(db, id, { planned_test_batch_date: "2026-12-10" }, "Test Person");
    d = await loadLaunchDetail(db, id, { actor: "Test Person", today: TODAY });
    expect(d.plan.slipDays).toBe(7);
    const before = d.tasks.find((t) => t.title === "Launch day posts live")!.due_date;
    const r = await shiftLaunchTasks(db, id, { days: 7, planned_test_batch_date: "2026-12-17" }, "Test Person");
    expect(r.moved).toBe(18);
    d = await loadLaunchDetail(db, id, { actor: "Test Person", today: TODAY });
    expect(d.tasks.find((t) => t.title === "Launch day posts live")!.due_date).toBe("2027-01-22");
    expect(before).toBe("2027-01-15");
    expect(d.launch.planned_test_batch_date).toBe("2026-12-17");
    expect(d.events.map((e) => e.event)).toEqual(expect.arrayContaining(["created", "synced_formula", "dates_shifted", "test_batch_date_changed"]));
  });

  it("mark ordered and arrived; automatic arrival from the Receiving Log with Undo; automatic tasks", async () => {
    const id = await newLaunch();
    await syncFromFormula(db, id, null);
    let d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    const rowId = (name: string) => d.ingredients.find((r) => r.material?.name === name)!.id;
    await rejects(() => ingredientAction(db, id, rowId("Material A"), { action: "ordered", ordered_at: "2026-11-17", qty_ordered: "0" }, null), /greater than 0/);
    await ingredientAction(db, id, rowId("Material A"), { action: "ordered", ordered_at: "2026-11-17", qty_ordered: "250", po_reference: "PO-1" }, "Test Person");
    await ingredientAction(db, id, rowId("Material B"), { action: "ordered", ordered_at: "2026-11-17", qty_ordered: "2" }, "Test Person");
    d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    const a = d.ingredients.find((r) => r.material?.name === "Material A")!;
    expect(a.plan).toMatchObject({ state: "ordered", inTransit: "250", shortfall: "0", expectedArrivalDate: "2026-12-01" });
    expect(d.ingredients.find((r) => r.material?.name === "Material B")!.plan).toMatchObject({ state: "ordered_short", shortfall: "2" });
    expect(d.tasks.find((t) => t.auto_kind === "ingredients_ready")!.status).toBe("todo");

    // A receiving entry dated before the order is ignored; one after it marks the row arrived.
    await receive(matA, "2026-11-10T15:00:00Z");
    d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    expect(d.ingredients.find((r) => r.material?.name === "Material A")!.status).toBe("ordered");
    const entry = await receive(matA, "2026-11-20T03:30:00Z"); // Nov 19, 10:30 pm in New York
    await receive(matA, "2026-11-21T15:00:00Z", entry); // a correction entry is never used
    d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    const arrived = d.ingredients.find((r) => r.material?.name === "Material A")!;
    expect(arrived).toMatchObject({ status: "arrived", arrived_source: "receiving_log", arrived_at: "2026-11-19" });
    // Idempotent.
    d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    expect(d.events.filter((e) => e.event === "ingredient_arrived")).toHaveLength(1);
    // Undo: back to ordered, and that entry is never applied again.
    await ingredientAction(db, id, arrived.id, { action: "undo" }, "Test Person");
    d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    expect(d.ingredients.find((r) => r.material?.name === "Material A")!.status).toBe("ordered");

    // A arrives by hand; B's order is undone and skipped: everything is covered and the automatic task checks itself.
    await pg.query(`update inventory_items set quantity_on_hand = 400 where id = $1`, [matA]);
    await ingredientAction(db, id, rowId("Material A"), { action: "arrived", arrived_at: "2026-11-25" }, null);
    await ingredientAction(db, id, rowId("Material B"), { action: "undo" }, null);
    await ingredientAction(db, id, rowId("Material B"), { action: "skip" }, null);
    d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    const ready = d.tasks.find((t) => t.auto_kind === "ingredients_ready")!;
    expect(ready).toMatchObject({ status: "done", done_by_name: "Automatic" });
    await rejects(() => updateTask(db, id, ready.id, { status: "todo" }, null), /automatic/i);

    // formula_final follows the latest formulation.
    expect(d.tasks.find((t) => t.auto_kind === "formula_final")!.status).toBe("todo");
    await pg.query(`update formulations set status = 'final' where version_number = 2`);
    d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    expect(d.tasks.find((t) => t.auto_kind === "formula_final")!.status).toBe("done");
  });

  it("rows no longer in the formula are kept but left out of the plan", async () => {
    const id = await newLaunch();
    await syncFromFormula(db, id, null);
    await pg.query(`delete from formulation_lines where raw_material_id = $1`, [matB]);
    expect(await syncFromFormula(db, id, null)).toMatchObject({ added: 0, removed: 1 });
    const d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    const b = d.ingredients.find((r) => r.material?.name === "Material B")!;
    expect(b.in_formula).toBe(false);
    expect(b.plan).toBeNull();
    expect(d.plan.rows).toHaveLength(2);
  });

  it("duplicate shifts dates to the new target and clears done states and owners; blank has no tasks", async () => {
    const src = await newLaunch();
    const d0 = await loadLaunchDetail(db, src, { actor: null, today: TODAY });
    const photo = d0.tasks.find((t) => t.title === "Product photos")!;
    const acc = await addEmployee(pg, { roles: [], first: "Owner", last: "One" });
    await updateTask(db, src, photo.id, { status: "done", owner_account_id: acc.accountId }, "Test Person");
    const dup = await createLaunch(db, { launch: { name: "Launch B", target_launch_date: "2027-02-15", test_batch_units: "10" }, start_from: "duplicate", duplicate_from_id: src }, null);
    const d = await loadLaunchDetail(db, dup.id, { actor: null, today: TODAY });
    expect(d.launch.planned_test_batch_date).toBe("2027-01-18");
    const p = d.tasks.find((t) => t.title === "Product photos")!;
    expect(p).toMatchObject({ due_date: "2027-02-01", status: "todo", owner_account_id: null });
    const blank = await createLaunch(db, { launch: { name: "Launch C", target_launch_date: "2027-03-01" }, start_from: "blank" }, null);
    expect((await loadLaunchDetail(db, blank.id, { actor: null, today: TODAY })).tasks).toEqual([]);
  });

  it("list, My tasks and tasks due", async () => {
    const id = await newLaunch();
    const acc = { id: (await addEmployee(pg, { roles: [], first: "Owner", last: "Two" })).accountId };
    const d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    await updateTask(db, id, d.tasks.find((t) => t.title === "Confirm ingredient list and suppliers")!.id, { owner_account_id: acc.id }, null);
    const list = await listLaunches(db, { accountId: acc.id, today: TODAY });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ done: 0, total: 18, mine: true, product_name: "Product A" });
    expect(list.myTasks.map((t) => t.title)).toEqual(["Confirm ingredient list and suppliers"]);
    expect(list.products.map((p) => p.name)).toEqual(["Product A"]);
    const due = await tasksDue(db, { accountId: acc.id, today: "2026-12-04" });
    expect(due[0]).toMatchObject({ title: "Confirm ingredient list and suppliers", mine: true, overdue: false });
    expect(due.length).toBeLessThanOrEqual(10);
    await updateLaunch(db, id, { status: "cancelled" }, null);
    expect(await tasksDue(db, { accountId: acc.id, today: "2026-12-04" })).toEqual([]);
  });
});

describe("Create PO from a launch", () => {
  it("one supplier's rows, quantity = shortfall from the server; mismatched rows are refused", async () => {
    const id = await newLaunch();
    await syncFromFormula(db, id, null);
    const d = await loadLaunchDetail(db, id, { actor: null, today: TODAY });
    const a = d.ingredients.find((r) => r.material?.name === "Material A")!;
    const b = d.ingredients.find((r) => r.material?.name === "Material B")!;
    const pre = await loadLaunchPoPrefill(db, supA, id, [a.id]);
    expect(pre.prefill.lines).toEqual([expect.objectContaining({ description: "Material A", quantity: "250", unit: "g", unit_price: "" })]);
    expect(pre.prefill.vendor_name).toBe("Supplier A");
    await rejects(() => loadLaunchPoPrefill(db, supA, id, [b.id]), /isn't set to this supplier/);
    const other = await newLaunch({ name: "Launch Other" });
    await rejects(() => loadLaunchPoPrefill(db, supA, other, [a.id]), /Unknown ingredient/);
    await rejects(() => loadLaunchPoPrefill(db, supA, id, ["not-an-id"]), /Unknown ingredient/);
    expect(linkA && linkB).toBeTruthy();
  });
});
