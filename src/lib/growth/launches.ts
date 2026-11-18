/**
 * Launch Pipeline server code (service role, after the route's feature check).
 *
 * launchPlanningData() reads only what ingredient planning needs: formula
 * lines (raw material, per-unit quantity), each raw material's name, unit and
 * on-hand quantity, supplier listings' supplier name and lead time, and the
 * latest non-correction Receiving Log date per raw material. It never returns
 * prices, contacts, payment notes or links.
 */
import Decimal from "decimal.js";
import { GrowthError, idOrThrow, isUuid } from "./errors";
import { addDays, diffDays, isIsoDate, nyDateOf, todayNy } from "./dates";
import { planIngredients, type Plan, type PlanRow } from "./plan";
import { defaultLaunchTasks, launchRisk, shiftOpenTasks, type AutoKind, type LaunchRisk, type TaskPhase, type TaskStatus } from "./tasks";
import type { Db } from "./routeHelpers";

// --- Types ------------------------------------------------------------------------------------
export type LaunchStatus = "planning" | "active" | "launched" | "paused" | "cancelled";
export const LAUNCH_STATUSES: Array<{ value: LaunchStatus; label: string }> = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "launched", label: "Launched" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
];

export type Launch = {
  id: string;
  name: string;
  formulation_product_id: string | null;
  status: LaunchStatus;
  target_launch_date: string;
  planned_test_batch_date: string | null;
  test_batch_units: string | number | null;
  buffer_days: number;
  notes: string | null;
  created_by_name: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LaunchTask = {
  id: string;
  launch_id: string;
  title: string;
  phase: TaskPhase;
  auto_kind: AutoKind | null;
  owner_account_id: string | null;
  due_date: string | null;
  status: TaskStatus;
  done_at: string | null;
  done_by_name: string | null;
  notes: string | null;
  sort_order: number;
  archived_at: string | null;
};

export type IngredientRow = {
  id: string;
  launch_id: string;
  raw_material_id: string;
  supplier_link_id: string | null;
  status: "pending" | "ordered" | "arrived" | "skipped";
  qty_ordered: string | number | null;
  ordered_at: string | null;
  expected_arrival: string | null;
  po_reference: string | null;
  arrived_at: string | null;
  arrived_source: "manual" | "receiving_log" | null;
  arrived_entry_id: string | null;
  ignored_receiving_entry_ids: string[];
  in_formula: boolean;
  notes: string | null;
};

export type LaunchEvent = { id: string; event: string; detail: string | null; actor_name: string | null; created_at: string };

/** A supplier listing as the planner sees it: no prices, contacts, links or notes. */
export type PlannerListing = { id: string; supplier_id: string; supplier_name: string; is_preferred: boolean; lead_time_days: number | null; lead_time_note: string | null };
export type PlannerMaterial = {
  id: string;
  name: string;
  unit: string;
  on_hand: string;
  line_type: "inventory_item" | "packaging";
  /** Per 1 unit of finished product, summed over the formula's lines, in the material's own unit. */
  per_unit: string;
  listings: PlannerListing[];
  last_received: { date: string; entry_id: string } | null;
};
export type FormulaSource = { formulation_id: string; version: number; status: "draft" | "final"; label: string } | null;
export type PlanningData = { formula: FormulaSource; materials: PlannerMaterial[] };

const LAUNCH_COLUMNS =
  "id, name, formulation_product_id, status, target_launch_date, planned_test_batch_date, test_batch_units, buffer_days, notes, created_by_name, archived_at, created_at, updated_at";
const TASK_COLUMNS = "id, launch_id, title, phase, auto_kind, owner_account_id, due_date, status, done_at, done_by_name, notes, sort_order, archived_at";
const ING_COLUMNS =
  "id, launch_id, raw_material_id, supplier_link_id, status, qty_ordered, ordered_at, expected_arrival, po_reference, arrived_at, arrived_source, arrived_entry_id, ignored_receiving_entry_ids, in_formula, notes";

function fail(error: { message?: string; code?: string } | null, message: string): never {
  if (error?.code === "23514" || /check constraint/i.test(error?.message ?? "")) throw new GrowthError(`${message} A value is out of range.`, 400);
  throw new GrowthError(message, 500);
}
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : null);
const dateOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : iso(v));

// --- Validation ------------------------------------------------------------------------------
type Errors = Record<string, string>;
const str = (raw: Record<string, unknown>, k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : raw[k] == null ? "" : String(raw[k]).trim());

export type LaunchInput = {
  name: string;
  formulation_product_id: string | null;
  target_launch_date: string;
  planned_test_batch_date: string | null;
  test_batch_units: string | null;
  buffer_days: number;
  status?: LaunchStatus;
  notes?: string | null;
};

export function validateLaunch(input: unknown, opts: { partial?: boolean } = {}): { ok: true; value: Partial<LaunchInput> } | { ok: false; errors: Errors } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Errors = {};
  const out: Partial<LaunchInput> = {};
  const has = (k: string) => !opts.partial || k in raw;
  if (has("name")) {
    const name = str(raw, "name");
    if (!name) errors.name = "Enter a launch name.";
    else if (name.length > 200) errors.name = "Keep the name under 200 characters.";
    out.name = name;
  }
  if (has("formulation_product_id")) {
    const v = raw.formulation_product_id;
    if (v === null || v === undefined || v === "") out.formulation_product_id = null;
    else if (!isUuid(v)) errors.formulation_product_id = "Choose a product from the list.";
    else out.formulation_product_id = v;
  }
  if (has("target_launch_date")) {
    const v = str(raw, "target_launch_date");
    if (!isIsoDate(v)) errors.target_launch_date = "Enter the target launch date.";
    out.target_launch_date = v;
  }
  if (has("planned_test_batch_date")) {
    const v = str(raw, "planned_test_batch_date");
    if (v && !isIsoDate(v)) errors.planned_test_batch_date = "Enter a valid date.";
    out.planned_test_batch_date = v || null;
  }
  if (has("test_batch_units")) {
    const v = str(raw, "test_batch_units");
    if (v) {
      let d: Decimal | null = null;
      try {
        d = new Decimal(v);
      } catch {
        d = null;
      }
      if (!d || !d.isFinite() || d.lte(0) || d.decimalPlaces() > 3 || d.gte(1e11)) errors.test_batch_units = "Enter a number of units greater than 0 (up to 3 decimals).";
      else out.test_batch_units = d.toFixed();
    } else out.test_batch_units = null;
  }
  if (has("buffer_days")) {
    const v = str(raw, "buffer_days");
    const n = v === "" ? 2 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 30) errors.buffer_days = "Buffer days must be a whole number from 0 to 30.";
    out.buffer_days = n;
  }
  if ("status" in raw) {
    const v = str(raw, "status");
    if (!LAUNCH_STATUSES.some((s) => s.value === v)) errors.status = "Choose a status.";
    out.status = v as LaunchStatus;
  }
  if ("notes" in raw) {
    const v = str(raw, "notes");
    if (v.length > 4000) errors.notes = "Keep notes under 4000 characters.";
    out.notes = v || null;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

export type TaskInput = { title: string; phase: TaskPhase; owner_account_id: string | null; due_date: string | null; status: TaskStatus; notes: string | null };
const PHASE_KEYS = ["formulation", "ingredients", "test_batch", "production", "content", "retail", "launch", "other"];
const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];

export function validateTask(input: unknown): { ok: true; value: Partial<TaskInput> } | { ok: false; errors: Errors } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Errors = {};
  const out: Partial<TaskInput> = {};
  if ("title" in raw) {
    const t = str(raw, "title");
    if (!t) errors.title = "Enter a task.";
    else if (t.length > 200) errors.title = "Keep the task under 200 characters.";
    out.title = t;
  }
  if ("phase" in raw) {
    const p = str(raw, "phase");
    if (!PHASE_KEYS.includes(p)) errors.phase = "Choose a phase.";
    out.phase = p as TaskPhase;
  }
  if ("owner_account_id" in raw) {
    const v = raw.owner_account_id;
    if (v === null || v === "" || v === undefined) out.owner_account_id = null;
    else if (!isUuid(v)) errors.owner_account_id = "Choose an owner from the list.";
    else out.owner_account_id = v;
  }
  if ("due_date" in raw) {
    const v = str(raw, "due_date");
    if (v && !isIsoDate(v)) errors.due_date = "Enter a valid date.";
    out.due_date = v || null;
  }
  if ("status" in raw) {
    const v = str(raw, "status");
    if (!TASK_STATUSES.includes(v)) errors.status = "Choose a status.";
    out.status = v as TaskStatus;
  }
  if ("notes" in raw) {
    const v = str(raw, "notes");
    if (v.length > 2000) errors.notes = "Keep notes under 2000 characters.";
    out.notes = v || null;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

// --- Loading ---------------------------------------------------------------------------------
async function getLaunch(db: Db, id: unknown): Promise<Launch> {
  const lid = idOrThrow(id, "launch");
  const { data, error } = await db.from("launches").select(LAUNCH_COLUMNS).eq("id", lid).maybeSingle();
  if (error) fail(error, "Could not load the launch.");
  if (!data) throw new GrowthError("Unknown launch.", 404);
  return normalizeLaunch(data);
}
const normalizeLaunch = (l: Launch): Launch => ({
  ...l,
  target_launch_date: iso(l.target_launch_date)!,
  planned_test_batch_date: dateOrNull(l.planned_test_batch_date),
});
const normalizeTask = (t: LaunchTask): LaunchTask => ({ ...t, due_date: dateOrNull(t.due_date) });
const normalizeIng = (r: IngredientRow): IngredientRow => ({
  ...r,
  ordered_at: dateOrNull(r.ordered_at),
  expected_arrival: dateOrNull(r.expected_arrival),
  arrived_at: dateOrNull(r.arrived_at),
  ignored_receiving_entry_ids: r.ignored_receiving_entry_ids ?? [],
});

async function tasksOf(db: Db, launchIds: string[]): Promise<LaunchTask[]> {
  if (launchIds.length === 0) return [];
  const { data, error } = await db.from("launch_tasks").select(TASK_COLUMNS).in("launch_id", launchIds).is("archived_at", null);
  if (error) fail(error, "Could not load tasks.");
  return ((data ?? []) as LaunchTask[]).map(normalizeTask).sort((a, b) => a.sort_order - b.sort_order);
}
async function ingredientsOf(db: Db, launchId: string): Promise<IngredientRow[]> {
  const { data, error } = await db.from("launch_ingredients").select(ING_COLUMNS).eq("launch_id", launchId);
  if (error) fail(error, "Could not load ingredients.");
  return ((data ?? []) as IngredientRow[]).map(normalizeIng);
}

async function logEvent(db: Db, launchId: string, event: string, detail: string | null, actor: string | null) {
  await db.from("launch_events").insert({ launch_id: launchId, event, detail: detail ? detail.slice(0, 500) : null, actor_name: actor });
}

/** The formula used for ingredient needs: the current draft, else the latest final. */
export async function formulaSource(db: Db, formulationProductId: string | null): Promise<FormulaSource> {
  if (!formulationProductId) return null;
  const { data, error } = await db.from("formulations").select("id, version_number, status").eq("formulation_product_id", formulationProductId);
  if (error) fail(error, "Could not load the formula.");
  const rows = (data ?? []) as Array<{ id: string; version_number: number; status: "draft" | "final" }>;
  const draft = rows.find((r) => r.status === "draft");
  const pick = draft ?? rows.filter((r) => r.status === "final").sort((a, b) => b.version_number - a.version_number)[0];
  if (!pick) return null;
  return { formulation_id: pick.id, version: pick.version_number, status: pick.status, label: pick.status === "draft" ? `Draft v${pick.version_number} (live)` : `Final v${pick.version_number}` };
}

/** Whether the product's latest formulation (highest version) is final. */
export async function latestFormulationIsFinal(db: Db, formulationProductId: string | null): Promise<boolean> {
  if (!formulationProductId) return false;
  const { data, error } = await db.from("formulations").select("version_number, status").eq("formulation_product_id", formulationProductId);
  if (error) fail(error, "Could not load the formula.");
  const rows = ((data ?? []) as Array<{ version_number: number; status: string }>).sort((a, b) => b.version_number - a.version_number);
  return rows.length > 0 && rows[0].status === "final";
}

/** Server-only planning reads (see the file comment for what is never returned). */
export async function launchPlanningData(db: Db, launch: Pick<Launch, "formulation_product_id">, extraMaterialIds: string[] = []): Promise<PlanningData> {
  const formula = await formulaSource(db, launch.formulation_product_id);
  const perUnit = new Map<string, { qty: Decimal; type: "inventory_item" | "packaging" }>();
  if (formula) {
    const { data, error } = await db.from("formulation_lines").select("raw_material_id, qty_per_unit, line_type").eq("formulation_id", formula.formulation_id);
    if (error) fail(error, "Could not load the formula lines.");
    for (const l of (data ?? []) as Array<{ raw_material_id: string; qty_per_unit: number | string; line_type: "inventory_item" | "packaging" }>) {
      if (!l.raw_material_id) continue;
      const cur = perUnit.get(l.raw_material_id);
      const q = new Decimal(l.qty_per_unit ?? 0);
      perUnit.set(l.raw_material_id, { qty: (cur?.qty ?? new Decimal(0)).plus(q), type: cur?.type === "inventory_item" ? "inventory_item" : l.line_type ?? "inventory_item" });
    }
  }
  const ids = [...new Set([...perUnit.keys(), ...extraMaterialIds])];
  if (ids.length === 0) return { formula, materials: [] };

  const [m, l, rd] = await Promise.all([
    db.from("inventory_items").select("id, name, unit, quantity_on_hand").in("id", ids),
    db.from("raw_material_suppliers").select("id, raw_material_id, supplier_id, is_preferred, lead_time_days, lead_time_note").in("raw_material_id", ids).is("archived_at", null),
    db.from("receiving_details").select("log_entry_id, raw_material_id").in("raw_material_id", ids),
  ]);
  if (m.error) fail(m.error, "Could not load raw materials.");
  if (l.error) fail(l.error, "Could not load supplier listings.");
  if (rd.error) fail(rd.error, "Could not load the Receiving Log.");
  const links = (l.data ?? []) as Array<{ id: string; raw_material_id: string; supplier_id: string; is_preferred: boolean; lead_time_days: number | null; lead_time_note: string | null }>;
  const supplierIds = [...new Set(links.map((x) => x.supplier_id))];
  const names = new Map<string, string>();
  if (supplierIds.length) {
    const s = await db.from("suppliers").select("id, name, archived_at").in("id", supplierIds);
    if (s.error) fail(s.error, "Could not load suppliers.");
    for (const x of (s.data ?? []) as Array<{ id: string; name: string; archived_at: string | null }>) if (!x.archived_at) names.set(x.id, x.name);
  }
  const details = (rd.data ?? []) as Array<{ log_entry_id: string; raw_material_id: string }>;
  const entries = new Map<string, { performed_at: string; corrects_entry_id: string | null }>();
  if (details.length) {
    const e = await db.from("log_entries").select("id, performed_at, corrects_entry_id").in("id", details.map((d) => d.log_entry_id));
    if (e.error) fail(e.error, "Could not load the Receiving Log.");
    for (const x of (e.data ?? []) as Array<{ id: string; performed_at: string; corrects_entry_id: string | null }>) entries.set(x.id, x);
  }
  const lastReceived = new Map<string, { date: string; entry_id: string; at: string }>();
  for (const d of details) {
    const entry = entries.get(d.log_entry_id);
    if (!entry || entry.corrects_entry_id) continue;
    const at = new Date(entry.performed_at).toISOString();
    const cur = lastReceived.get(d.raw_material_id);
    if (!cur || at > cur.at) lastReceived.set(d.raw_material_id, { date: nyDateOf(at), entry_id: d.log_entry_id, at });
  }
  const materials = ((m.data ?? []) as Array<{ id: string; name: string; unit: string | null; quantity_on_hand: number | string | null }>).map(
    (row): PlannerMaterial => ({
      id: row.id,
      name: row.name,
      unit: (row.unit ?? "").trim(),
      on_hand: new Decimal(row.quantity_on_hand ?? 0).toFixed(),
      line_type: perUnit.get(row.id)?.type ?? "inventory_item",
      per_unit: (perUnit.get(row.id)?.qty ?? new Decimal(0)).toFixed(),
      listings: links
        .filter((x) => x.raw_material_id === row.id && names.has(x.supplier_id))
        .map((x) => ({ id: x.id, supplier_id: x.supplier_id, supplier_name: names.get(x.supplier_id)!, is_preferred: x.is_preferred, lead_time_days: x.lead_time_days, lead_time_note: x.lead_time_note }))
        .sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred) || a.supplier_name.localeCompare(b.supplier_name)),
      last_received: lastReceived.get(row.id) ? { date: lastReceived.get(row.id)!.date, entry_id: lastReceived.get(row.id)!.entry_id } : null,
    }),
  );
  return { formula, materials: materials.sort((a, b) => a.name.localeCompare(b.name)) };
}

// --- Plan for a launch ----------------------------------------------------------------------
export type IngredientView = IngredientRow & {
  material: Pick<PlannerMaterial, "id" | "name" | "unit" | "line_type" | "last_received"> | null;
  listings: PlannerListing[];
  supplier: PlannerListing | null;
  plan: PlanRow | null;
};

export function buildPlan(launch: Launch, rows: IngredientRow[], planning: PlanningData, today: string): { plan: Plan; ingredients: IngredientView[] } {
  const byId = new Map(planning.materials.map((m) => [m.id, m]));
  const units = launch.test_batch_units === null || launch.test_batch_units === undefined ? null : new Decimal(launch.test_batch_units);
  const planned = rows.filter((r) => r.in_formula);
  const inputs = planned.map((r) => {
    const mat = byId.get(r.raw_material_id);
    const supplier = mat?.listings.find((x) => x.id === r.supplier_link_id) ?? null;
    return {
      row: r,
      input: {
        needed: units && mat ? new Decimal(mat.per_unit).times(units).toFixed() : "0",
        onHand: mat?.on_hand ?? "0",
        qtyOrdered: r.qty_ordered,
        status: r.status,
        orderedAt: r.ordered_at,
        expectedArrival: r.expected_arrival,
        leadTimeDays: supplier?.lead_time_days ?? null,
      },
    };
  });
  const plan = planIngredients({ today, plannedTestBatchDate: launch.planned_test_batch_date, bufferDays: launch.buffer_days, rows: inputs.map((i) => i.input) });
  const planById = new Map(inputs.map((i, n) => [i.row.id, plan.rows[n]]));
  const ingredients = rows
    .map((r): IngredientView => {
      const mat = byId.get(r.raw_material_id) ?? null;
      const listings = mat?.listings ?? [];
      return {
        ...r,
        material: mat ? { id: mat.id, name: mat.name, unit: mat.unit, line_type: mat.line_type, last_received: mat.last_received } : null,
        listings,
        supplier: listings.find((x) => x.id === r.supplier_link_id) ?? null,
        plan: planById.get(r.id) ?? null,
      };
    })
    .sort((a, b) => Number(b.in_formula) - Number(a.in_formula) || (a.material?.name ?? "").localeCompare(b.material?.name ?? ""));
  return { plan, ingredients };
}

/** ingredients_ready: at least one planned row and none still to order or on its way. */
export function ingredientsReady(ingredients: Pick<IngredientView, "in_formula" | "plan">[]): boolean {
  const planned = ingredients.filter((i) => i.in_formula && i.plan);
  return planned.length > 0 && !planned.some((i) => ["to_order", "no_lead_time", "ordered_short", "ordered"].includes(i.plan!.state));
}

// --- Reconcile (runs when the detail page loads; idempotent) ----------------------------------
/**
 * Ordered rows become arrived when a non-correction Receiving Log entry for
 * the raw material exists on or after the order date (New York date), unless
 * that entry was dismissed with Undo.
 */
export async function reconcileLaunchArrivals(db: Db, launchId: string, planning: PlanningData, actor: string | null): Promise<number> {
  const rows = await ingredientsOf(db, launchId);
  const byId = new Map(planning.materials.map((m) => [m.id, m]));
  let n = 0;
  for (const r of rows) {
    if (r.status !== "ordered" || !r.ordered_at) continue;
    const last = byId.get(r.raw_material_id)?.last_received;
    if (!last || last.date < r.ordered_at || r.ignored_receiving_entry_ids.includes(last.entry_id)) continue;
    const { error } = await db
      .from("launch_ingredients")
      .update({ status: "arrived", arrived_at: last.date, arrived_source: "receiving_log", arrived_entry_id: last.entry_id })
      .eq("id", r.id)
      .eq("status", "ordered");
    if (error) fail(error, "Could not update an ingredient.");
    await logEvent(db, launchId, "ingredient_arrived", `${byId.get(r.raw_material_id)?.name ?? "Ingredient"} arrived (from the Receiving Log, ${last.date}).`, actor ?? "Automatic");
    n++;
  }
  return n;
}

async function reconcileAutoTasks(db: Db, launch: Launch, tasks: LaunchTask[], ingredients: IngredientView[]): Promise<LaunchTask[]> {
  const formulaFinal = await latestFormulationIsFinal(db, launch.formulation_product_id);
  const ready = ingredientsReady(ingredients);
  const out: LaunchTask[] = [];
  for (const t of tasks) {
    if (!t.auto_kind) {
      out.push(t);
      continue;
    }
    const done = t.auto_kind === "formula_final" ? formulaFinal : ready;
    if (done === (t.status === "done")) {
      out.push(t);
      continue;
    }
    const patch = done
      ? { status: "done", done_at: new Date().toISOString(), done_by_name: "Automatic" }
      : { status: "todo", done_at: null, done_by_name: null };
    const { data, error } = await db.from("launch_tasks").update(patch).eq("id", t.id).select(TASK_COLUMNS).single();
    if (error) fail(error, "Could not update an automatic task.");
    out.push(normalizeTask(data));
  }
  return out;
}

// --- Detail and list ------------------------------------------------------------------------
export type LaunchDetail = {
  launch: Launch;
  product: { id: string; name: string } | null;
  formula: FormulaSource;
  tasks: LaunchTask[];
  ingredients: IngredientView[];
  plan: Plan;
  risk: LaunchRisk;
  events: LaunchEvent[];
  today: string;
};

export async function loadLaunchDetail(db: Db, id: unknown, opts: { actor: string | null; today?: string }): Promise<LaunchDetail> {
  const today = opts.today ?? todayNy();
  const launch = await getLaunch(db, id);
  let rows = await ingredientsOf(db, launch.id);
  const planning = await launchPlanningData(db, launch, rows.map((r) => r.raw_material_id));
  if (await reconcileLaunchArrivals(db, launch.id, planning, null)) rows = await ingredientsOf(db, launch.id);
  const { plan, ingredients } = buildPlan(launch, rows, planning, today);
  const tasks = await reconcileAutoTasks(db, launch, await tasksOf(db, [launch.id]), ingredients);
  const [p, e] = await Promise.all([
    launch.formulation_product_id ? db.from("formulation_products").select("id, name").eq("id", launch.formulation_product_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    db.from("launch_events").select("id, event, detail, actor_name, created_at").eq("launch_id", launch.id).order("created_at", { ascending: false }),
  ]);
  return {
    launch,
    product: p.data ? { id: p.data.id, name: p.data.name } : null,
    formula: planning.formula,
    tasks,
    ingredients,
    plan,
    risk: launchRisk({ tasks, plan, today }),
    events: ((e.data ?? []) as LaunchEvent[]).slice(0, 200),
    today,
  };
}

export type LaunchListRow = {
  launch: Launch;
  product_name: string | null;
  done: number;
  total: number;
  next_task: { title: string; due_date: string } | null;
  earliest_test_batch_date: string;
  slip_days: number | null;
  risk: LaunchRisk;
  mine: boolean;
};
export type MyTask = LaunchTask & { launch_name: string; overdue: boolean };

export async function listLaunches(db: Db, opts: { accountId: string | null; today?: string }) {
  const today = opts.today ?? todayNy();
  const { data, error } = await db.from("launches").select(LAUNCH_COLUMNS).is("archived_at", null);
  if (error) fail(error, "Could not load launches.");
  const launches = ((data ?? []) as Launch[]).map(normalizeLaunch);
  const tasks = await tasksOf(db, launches.map((l) => l.id));
  const fp = await db.from("formulation_products").select("id, name, status, deleted_at");
  if (fp.error) fail(fp.error, "Could not load products.");
  const products = ((fp.data ?? []) as Array<{ id: string; name: string; status: string; deleted_at: string | null }>);
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const rows: LaunchListRow[] = [];
  for (const launch of launches) {
    const lt = tasks.filter((t) => t.launch_id === launch.id);
    const ing = await ingredientsOf(db, launch.id);
    const planning = await launchPlanningData(db, launch, ing.map((r) => r.raw_material_id));
    const { plan } = buildPlan(launch, ing, planning, today);
    const open = lt.filter((t) => t.status !== "done" && t.due_date).sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));
    rows.push({
      launch,
      product_name: launch.formulation_product_id ? productName.get(launch.formulation_product_id) ?? null : null,
      done: lt.filter((t) => t.status === "done").length,
      total: lt.length,
      next_task: open[0] ? { title: open[0].title, due_date: open[0].due_date! } : null,
      earliest_test_batch_date: plan.earliestTestBatchDate,
      slip_days: plan.slipDays,
      risk: launchRisk({ tasks: lt, plan, today }),
      mine: !!opts.accountId && lt.some((t) => t.owner_account_id === opts.accountId),
    });
  }
  rows.sort((a, b) => (a.launch.target_launch_date < b.launch.target_launch_date ? -1 : a.launch.target_launch_date > b.launch.target_launch_date ? 1 : 0));
  const launchName = new Map(launches.map((l) => [l.id, l.name]));
  const myTasks: MyTask[] = opts.accountId
    ? tasks
        .filter((t) => t.owner_account_id === opts.accountId && t.status !== "done")
        .map((t) => ({ ...t, launch_name: launchName.get(t.launch_id) ?? "", overdue: !!t.due_date && t.due_date < today }))
        .sort((a, b) => (a.due_date ?? "9999") .localeCompare(b.due_date ?? "9999"))
    : [];
  return {
    rows,
    myTasks,
    products: products.filter((p) => !p.deleted_at).map((p) => ({ id: p.id, name: p.name, in_development: p.status === "in_development" })).sort((a, b) => a.name.localeCompare(b.name)),
    today,
  };
}

/** Dashboard: open tasks due within 7 days or overdue (non-cancelled launches), the signed-in user's first, at most 10. */
export async function tasksDue(db: Db, opts: { accountId: string | null; today?: string }) {
  const today = opts.today ?? todayNy();
  const { data, error } = await db.from("launches").select("id, name, status").is("archived_at", null);
  if (error) fail(error, "Could not load launches.");
  const launches = ((data ?? []) as Array<{ id: string; name: string; status: string }>).filter((l) => l.status !== "cancelled");
  const names = new Map(launches.map((l) => [l.id, l.name]));
  const horizon = addDays(today, 7);
  const tasks = (await tasksOf(db, launches.map((l) => l.id))).filter((t) => t.status !== "done" && t.due_date && t.due_date <= horizon);
  return tasks
    .map((t) => ({ id: t.id, launch_id: t.launch_id, launch_name: names.get(t.launch_id) ?? "", title: t.title, due_date: t.due_date!, mine: !!opts.accountId && t.owner_account_id === opts.accountId, overdue: t.due_date! < today }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || a.due_date.localeCompare(b.due_date))
    .slice(0, 10);
}

// --- Create, update -------------------------------------------------------------------------
export async function createLaunch(db: Db, body: Record<string, unknown>, actor: string | null): Promise<Launch> {
  const v = validateLaunch(body.launch);
  if (!v.ok) throw new GrowthError("Some fields are missing or not valid.", 400, v.errors);
  const value = v.value as LaunchInput;
  if (value.formulation_product_id) {
    const { data } = await db.from("formulation_products").select("id, deleted_at").eq("id", value.formulation_product_id).maybeSingle();
    if (!data || data.deleted_at) throw new GrowthError("Choose a product from the list.", 400, { formulation_product_id: "Choose a product from the list." });
  }
  const planned = value.planned_test_batch_date ?? addDays(value.target_launch_date, -28);
  const startFrom = body.start_from === "duplicate" ? "duplicate" : body.start_from === "blank" ? "blank" : "default";
  let source: Launch | null = null;
  if (startFrom === "duplicate") source = await getLaunch(db, body.duplicate_from_id);

  const { data, error } = await db
    .from("launches")
    .insert({ ...value, planned_test_batch_date: planned, status: "planning", created_by_name: actor })
    .select(LAUNCH_COLUMNS)
    .single();
  if (error) fail(error, "Could not create the launch.");
  const launch = normalizeLaunch(data);

  let tasks: Array<Record<string, unknown>> = [];
  if (startFrom === "default") {
    const planning = await launchPlanningData(db, launch);
    const preferredLeads = planning.materials.map((m) => m.listings.find((x) => x.is_preferred)?.lead_time_days).filter((x): x is number => typeof x === "number");
    tasks = defaultLaunchTasks(launch.target_launch_date, planned, {
      longestLeadTimeDays: preferredLeads.length ? Math.max(...preferredLeads) : null,
      bufferDays: launch.buffer_days,
    }).map((t) => ({ ...t, launch_id: launch.id }));
  } else if (source) {
    const shift = diffDays(source.target_launch_date, launch.target_launch_date);
    const srcTasks = await tasksOf(db, [source.id]);
    tasks = srcTasks.map((t, i) => ({
      launch_id: launch.id,
      title: t.title,
      phase: t.phase,
      auto_kind: t.auto_kind,
      due_date: t.due_date ? addDays(t.due_date, shift) : null,
      notes: t.notes,
      sort_order: i + 1,
    }));
  }
  if (tasks.length) {
    const r = await db.from("launch_tasks").insert(tasks);
    if (r.error) fail(r.error, "Could not create the checklist.");
  }
  await logEvent(db, launch.id, "created", startFrom === "duplicate" && source ? `Created from ${source.name}.` : startFrom === "blank" ? "Created with a blank checklist." : "Created from the default checklist.", actor);
  return launch;
}

export async function updateLaunch(db: Db, id: unknown, body: Record<string, unknown>, actor: string | null): Promise<Launch> {
  const current = await getLaunch(db, id);
  const v = validateLaunch(body, { partial: true });
  if (!v.ok) throw new GrowthError("Some fields are missing or not valid.", 400, v.errors);
  const patch = v.value;
  if (Object.keys(patch).length === 0) return current;
  if (patch.formulation_product_id && patch.formulation_product_id !== current.formulation_product_id) {
    const { data } = await db.from("formulation_products").select("id, deleted_at").eq("id", patch.formulation_product_id).maybeSingle();
    if (!data || data.deleted_at) throw new GrowthError("Choose a product from the list.", 400, { formulation_product_id: "Choose a product from the list." });
  }
  const { data, error } = await db.from("launches").update(patch).eq("id", current.id).select(LAUNCH_COLUMNS).single();
  if (error) fail(error, "Could not save the launch.");
  const next = normalizeLaunch(data);
  if (patch.status && patch.status !== current.status) await logEvent(db, current.id, "status_changed", `Status: ${current.status} → ${patch.status}.`, actor);
  if ("planned_test_batch_date" in patch && next.planned_test_batch_date !== current.planned_test_batch_date) {
    await logEvent(db, current.id, "test_batch_date_changed", `Planned test batch: ${current.planned_test_batch_date ?? "none"} → ${next.planned_test_batch_date ?? "none"}.`, actor);
  }
  return next;
}

/** Adds days to every open task with a due date; optionally moves the planned test batch date too. */
export async function shiftLaunchTasks(db: Db, id: unknown, body: Record<string, unknown>, actor: string | null) {
  const launch = await getLaunch(db, id);
  const days = Number(body.days);
  if (!Number.isInteger(days) || days === 0 || Math.abs(days) > 365) throw new GrowthError("Enter a whole number of days (1 to 365).", 400);
  const tasks = await tasksOf(db, [launch.id]);
  const shifted = shiftOpenTasks(tasks, days);
  let n = 0;
  for (let i = 0; i < tasks.length; i++) {
    if (shifted[i].due_date === tasks[i].due_date) continue;
    const { error } = await db.from("launch_tasks").update({ due_date: shifted[i].due_date }).eq("id", tasks[i].id);
    if (error) fail(error, "Could not move a task.");
    n++;
  }
  await logEvent(db, launch.id, "dates_shifted", `Moved ${n} open task${n === 1 ? "" : "s"} by ${days} day${Math.abs(days) === 1 ? "" : "s"}.`, actor);
  if (body.planned_test_batch_date !== undefined) await updateLaunch(db, launch.id, { planned_test_batch_date: body.planned_test_batch_date }, actor);
  return { moved: n };
}

// --- Tasks ----------------------------------------------------------------------------------
async function getTask(db: Db, launchId: string, taskId: unknown): Promise<LaunchTask> {
  const tid = idOrThrow(taskId, "task");
  const { data, error } = await db.from("launch_tasks").select(TASK_COLUMNS).eq("id", tid).eq("launch_id", launchId).maybeSingle();
  if (error) fail(error, "Could not load the task.");
  if (!data || data.archived_at) throw new GrowthError("Unknown task.", 404);
  return normalizeTask(data);
}

export async function addTask(db: Db, launchId: unknown, body: Record<string, unknown>) {
  const launch = await getLaunch(db, launchId);
  const v = validateTask({ phase: "other", status: "todo", ...body });
  if (!v.ok) throw new GrowthError("Some fields are missing or not valid.", 400, v.errors);
  if (!v.value.title) throw new GrowthError("Enter a task.", 400, { title: "Enter a task." });
  const tasks = await tasksOf(db, [launch.id]);
  const { data, error } = await db
    .from("launch_tasks")
    .insert({ ...v.value, launch_id: launch.id, sort_order: (tasks.at(-1)?.sort_order ?? 0) + 1 })
    .select(TASK_COLUMNS)
    .single();
  if (error) fail(error, "Could not add the task.");
  return normalizeTask(data);
}

export async function updateTask(db: Db, launchId: unknown, taskId: unknown, body: Record<string, unknown>, actor: string | null) {
  const launch = await getLaunch(db, launchId);
  const task = await getTask(db, launch.id, taskId);
  if (body.archive === true) {
    if (task.auto_kind) throw new GrowthError("Automatic tasks can't be removed.", 400);
    const { error } = await db.from("launch_tasks").update({ archived_at: new Date().toISOString() }).eq("id", task.id);
    if (error) fail(error, "Could not remove the task.");
    return null;
  }
  const v = validateTask(body);
  if (!v.ok) throw new GrowthError("Some fields are missing or not valid.", 400, v.errors);
  const patch: Record<string, unknown> = { ...v.value };
  if (task.auto_kind && "status" in patch && patch.status !== task.status) {
    throw new GrowthError("This task is automatic: it is checked off on its own.", 400);
  }
  if (patch.status && patch.status !== task.status) {
    if (patch.status === "done") Object.assign(patch, { done_at: new Date().toISOString(), done_by_name: actor });
    else if (task.status === "done") Object.assign(patch, { done_at: null, done_by_name: null });
  }
  const { data, error } = await db.from("launch_tasks").update(patch).eq("id", task.id).select(TASK_COLUMNS).single();
  if (error) fail(error, "Could not save the task.");
  if (patch.status === "done" && task.status !== "done") await logEvent(db, launch.id, "task_completed", task.title, actor);
  if (task.status === "done" && patch.status && patch.status !== "done") await logEvent(db, launch.id, "task_reopened", task.title, actor);
  return normalizeTask(data);
}

export async function reorderTasks(db: Db, launchId: unknown, ids: unknown) {
  const launch = await getLaunch(db, launchId);
  const tasks = await tasksOf(db, [launch.id]);
  if (!Array.isArray(ids) || ids.length !== tasks.length || new Set(ids).size !== ids.length || !ids.every((x) => tasks.some((t) => t.id === x))) {
    throw new GrowthError("The checklist changed. Reload the page and try again.", 409);
  }
  for (let i = 0; i < ids.length; i++) {
    const { error } = await db.from("launch_tasks").update({ sort_order: i + 1 }).eq("id", ids[i]);
    if (error) fail(error, "Could not reorder the tasks.");
  }
}

// --- Ingredients ----------------------------------------------------------------------------
/** One row per raw material in the formula; rows no longer in it are kept but left out of the plan. */
export async function syncFromFormula(db: Db, launchId: unknown, actor: string | null) {
  const launch = await getLaunch(db, launchId);
  const planning = await launchPlanningData(db, launch);
  if (!planning.formula) throw new GrowthError("This launch has no product with a formula yet. Choose a product with a formula first.", 400);
  const rows = await ingredientsOf(db, launch.id);
  const inFormula = new Set(planning.materials.map((m) => m.id));
  let added = 0;
  let removed = 0;
  for (const m of planning.materials) {
    const existing = rows.find((r) => r.raw_material_id === m.id);
    if (!existing) {
      const preferred = m.listings.find((x) => x.is_preferred) ?? null;
      const { error } = await db.from("launch_ingredients").insert({ launch_id: launch.id, raw_material_id: m.id, supplier_link_id: preferred?.id ?? null, in_formula: true });
      if (error) fail(error, "Could not add an ingredient.");
      added++;
    } else if (!existing.in_formula) {
      const { error } = await db.from("launch_ingredients").update({ in_formula: true }).eq("id", existing.id);
      if (error) fail(error, "Could not update an ingredient.");
    }
  }
  for (const r of rows) {
    if (r.in_formula && !inFormula.has(r.raw_material_id)) {
      const { error } = await db.from("launch_ingredients").update({ in_formula: false }).eq("id", r.id);
      if (error) fail(error, "Could not update an ingredient.");
      removed++;
    }
  }
  await logEvent(db, launch.id, "synced_formula", `Synced from ${planning.formula.label}: ${added} added, ${removed} no longer in the formula.`, actor);
  return { added, removed, formula: planning.formula };
}

async function getIngredient(db: Db, launchId: string, rowId: unknown): Promise<IngredientRow> {
  const rid = idOrThrow(rowId, "ingredient");
  const { data, error } = await db.from("launch_ingredients").select(ING_COLUMNS).eq("id", rid).eq("launch_id", launchId).maybeSingle();
  if (error) fail(error, "Could not load the ingredient.");
  if (!data) throw new GrowthError("Unknown ingredient.", 404);
  return normalizeIng(data);
}

export async function ingredientAction(db: Db, launchId: unknown, rowId: unknown, body: Record<string, unknown>, actor: string | null) {
  const launch = await getLaunch(db, launchId);
  const row = await getIngredient(db, launch.id, rowId);
  const { data: mat } = await db.from("inventory_items").select("name").eq("id", row.raw_material_id).maybeSingle();
  const name = mat?.name ?? "Ingredient";
  const action = body.action;
  let patch: Record<string, unknown> = {};
  let event: [string, string] | null = null;
  const dateField = (k: string, label: string) => {
    const v = typeof body[k] === "string" ? (body[k] as string).trim() : "";
    if (!isIsoDate(v)) throw new GrowthError(`Enter the ${label}.`, 400, { [k]: `Enter the ${label}.` });
    return v;
  };
  switch (action) {
    case "supplier": {
      const lid = body.supplier_link_id;
      if (lid === null || lid === "") {
        patch = { supplier_link_id: null };
        break;
      }
      const { data: link } = await db.from("raw_material_suppliers").select("id, raw_material_id, archived_at").eq("id", idOrThrow(lid, "supplier listing")).maybeSingle();
      if (!link || link.archived_at || link.raw_material_id !== row.raw_material_id) throw new GrowthError("Choose one of this ingredient's suppliers.", 400);
      patch = { supplier_link_id: link.id };
      break;
    }
    case "ordered": {
      const ordered_at = dateField("ordered_at", "order date");
      const q = typeof body.qty_ordered === "string" || typeof body.qty_ordered === "number" ? String(body.qty_ordered).trim() : "";
      let qty: Decimal;
      try {
        qty = new Decimal(q);
      } catch {
        throw new GrowthError("Enter the quantity ordered.", 400, { qty_ordered: "Enter the quantity ordered." });
      }
      if (!qty.isFinite() || qty.lte(0) || qty.decimalPlaces() > 3) throw new GrowthError("Enter a quantity greater than 0 (up to 3 decimals).", 400, { qty_ordered: "Enter a quantity greater than 0 (up to 3 decimals)." });
      const po = typeof body.po_reference === "string" ? body.po_reference.trim() : "";
      if (po.length > 100) throw new GrowthError("Keep the PO reference under 100 characters.", 400, { po_reference: "Keep the PO reference under 100 characters." });
      const exp = typeof body.expected_arrival === "string" && body.expected_arrival.trim() ? dateField("expected_arrival", "expected arrival date") : null;
      patch = { status: "ordered", ordered_at, qty_ordered: qty.toFixed(), po_reference: po || null, expected_arrival: exp, arrived_at: null, arrived_source: null, arrived_entry_id: null };
      event = ["ingredient_ordered", `${name}: ordered ${qty.toFixed()} on ${ordered_at}${po ? ` (PO ${po})` : ""}.`];
      break;
    }
    case "arrived": {
      const arrived_at = dateField("arrived_at", "arrival date");
      patch = { status: "arrived", arrived_at, arrived_source: "manual", arrived_entry_id: null };
      event = ["ingredient_arrived", `${name}: arrived ${arrived_at}.`];
      break;
    }
    case "undo": {
      if (row.status === "arrived") {
        const ignored = row.arrived_source === "receiving_log" && row.arrived_entry_id ? [...row.ignored_receiving_entry_ids, row.arrived_entry_id] : row.ignored_receiving_entry_ids;
        patch = { status: row.ordered_at ? "ordered" : "pending", arrived_at: null, arrived_source: null, arrived_entry_id: null, ignored_receiving_entry_ids: ignored };
        event = ["ingredient_undone", `${name}: arrival undone.`];
      } else if (row.status === "ordered") {
        patch = { status: "pending", ordered_at: null, qty_ordered: null, po_reference: null, expected_arrival: null };
        event = ["ingredient_undone", `${name}: order undone.`];
      } else if (row.status === "skipped") {
        patch = { status: "pending" };
        event = ["ingredient_undone", `${name}: no longer skipped.`];
      } else throw new GrowthError("Nothing to undo.", 400);
      break;
    }
    case "skip":
      patch = { status: "skipped" };
      event = ["ingredient_skipped", `${name}: skipped.`];
      break;
    case "notes": {
      const n = typeof body.notes === "string" ? body.notes.trim() : "";
      if (n.length > 1000) throw new GrowthError("Keep notes under 1000 characters.", 400);
      patch = { notes: n || null };
      break;
    }
    default:
      throw new GrowthError("Unknown action.", 400);
  }
  const { error } = await db.from("launch_ingredients").update(patch).eq("id", row.id);
  if (error) fail(error, "Could not save the ingredient.");
  if (event) await logEvent(db, launch.id, event[0], event[1], actor);
}

/**
 * Create PO from a launch: the rows for one supplier, with the quantity
 * defaulting to each row's shortfall (worked out here, never sent by the
 * browser). Rejects unknown rows, rows from another launch, and rows whose
 * chosen listing isn't this supplier's.
 */
export async function launchPoItems(db: Db, launchId: unknown, rowIds: unknown, supplierId: string, today = todayNy()) {
  const launch = await getLaunch(db, launchId);
  if (!Array.isArray(rowIds) || rowIds.length === 0 || rowIds.length > 100) throw new GrowthError("Choose the ingredients to order.", 400);
  const ids = [...new Set(rowIds)];
  for (const id of ids) idOrThrow(id, "ingredient");
  const rows = await ingredientsOf(db, launch.id);
  const planning = await launchPlanningData(db, launch, rows.map((r) => r.raw_material_id));
  const { ingredients } = buildPlan(launch, rows, planning, today);
  return (ids as string[]).map((id) => {
    const r = ingredients.find((x) => x.id === id);
    if (!r) throw new GrowthError("Unknown ingredient.", 404);
    if (!r.supplier || r.supplier.supplier_id !== supplierId) throw new GrowthError(`${r.material?.name ?? "An ingredient"} isn't set to this supplier.`, 400);
    const shortfall = r.plan ? new Decimal(r.plan.shortfall) : new Decimal(0);
    return { raw_material_id: r.raw_material_id, quantity: shortfall.gt(0) ? shortfall.toFixed() : "" };
  });
}

export const RISK_ORDER: Record<LaunchRisk, number> = { late: 0, at_risk: 1, on_track: 2 };
