/**
 * Launch checklist helpers: the default task list, shifting open task dates,
 * and the launch risk badge. Dates are date-only.
 */
import { addDays, diffDays } from "./dates";
import type { Plan } from "./plan";

export type TaskPhase = "formulation" | "ingredients" | "test_batch" | "production" | "content" | "retail" | "launch" | "other";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type AutoKind = "formula_final" | "ingredients_ready";

export const PHASES: Array<{ key: TaskPhase; label: string }> = [
  { key: "formulation", label: "Formulation" },
  { key: "ingredients", label: "Ingredients" },
  { key: "test_batch", label: "Test batch" },
  { key: "production", label: "Production" },
  { key: "content", label: "Content" },
  { key: "retail", label: "Retail" },
  { key: "launch", label: "Launch" },
  { key: "other", label: "Other" },
];

export type DefaultTask = { title: string; phase: TaskPhase; auto_kind: AutoKind | null; due_date: string; sort_order: number };

export const DEFAULT_TEST_BATCH_OFFSET = -28;

/**
 * The starting checklist. Due dates are the target date plus an offset in
 * days, except the two ingredient tasks, which follow the planned test batch
 * date. Suggestions only: the user edits them freely.
 * longestLeadTimeDays: the longest known supplier lead time (null if none).
 */
export function defaultLaunchTasks(
  targetLaunchDate: string,
  plannedTestBatchDate: string | null,
  opts: { longestLeadTimeDays?: number | null; bufferDays?: number } = {},
): DefaultTask[] {
  const t = (offset: number) => addDays(targetLaunchDate, offset);
  const testBatch = plannedTestBatchDate ?? t(DEFAULT_TEST_BATCH_OFFSET);
  const lead = opts.longestLeadTimeDays;
  const orderIngredients =
    plannedTestBatchDate && typeof lead === "number" && lead >= 0 ? addDays(plannedTestBatchDate, -(lead + (opts.bufferDays ?? 0))) : t(-40);
  const rows: Array<Omit<DefaultTask, "sort_order">> = [
    { title: "Finalize the formula for the test batch", phase: "formulation", auto_kind: "formula_final", due_date: t(-42) },
    { title: "Confirm ingredient list and suppliers", phase: "formulation", auto_kind: null, due_date: t(-41) },
    { title: "Order test batch ingredients", phase: "ingredients", auto_kind: null, due_date: orderIngredients },
    { title: "Ingredients arrived", phase: "ingredients", auto_kind: "ingredients_ready", due_date: addDays(testBatch, -1) },
    { title: "Make the test batch", phase: "test_batch", auto_kind: null, due_date: testBatch },
    { title: "Evaluate the test batch (texture, flavor, stability notes)", phase: "test_batch", auto_kind: null, due_date: t(-25) },
    { title: "Approve the formula or start a new iteration", phase: "test_batch", auto_kind: null, due_date: t(-24) },
    { title: "Order full production ingredients and packaging", phase: "production", auto_kind: null, due_date: t(-23) },
    { title: "Packaging and labels ready", phase: "production", auto_kind: null, due_date: t(-14) },
    { title: "Write or update the production SOP", phase: "production", auto_kind: null, due_date: t(-14) },
    { title: "Product photos", phase: "content", auto_kind: null, due_date: t(-14) },
    { title: "Draft claims and submit for approval", phase: "content", auto_kind: null, due_date: t(-12) },
    { title: "Film and edit reels", phase: "content", auto_kind: null, due_date: t(-10) },
    { title: "Schedule posts in the content calendar", phase: "content", auto_kind: null, due_date: t(-7) },
    { title: "Create the line sheet", phase: "retail", auto_kind: null, due_date: t(-7) },
    { title: "Prepare the retailer outreach list", phase: "retail", auto_kind: null, due_date: t(-7) },
    { title: "Launch day posts live", phase: "launch", auto_kind: null, due_date: t(0) },
    { title: "First retailer visits", phase: "launch", auto_kind: null, due_date: t(3) },
  ];
  return rows.map((r, i) => ({ ...r, sort_order: i + 1 }));
}

export type ShiftableTask = { id: string; status: TaskStatus; due_date: string | null };

/** Adds days to the due date of every task that is not done and has one. */
export function shiftOpenTasks<T extends ShiftableTask>(tasks: readonly T[], days: number): T[] {
  return tasks.map((t) => (t.status !== "done" && t.due_date ? { ...t, due_date: addDays(t.due_date, days) } : t));
}

export type LaunchRisk = "on_track" | "at_risk" | "late";

export function launchRisk(input: {
  tasks: ReadonlyArray<{ status: TaskStatus; due_date: string | null }>;
  plan: Pick<Plan, "slipDays" | "hasUnknownLeadTimes"> | null;
  today: string;
}): LaunchRisk {
  if (input.tasks.some((t) => t.status !== "done" && t.due_date && diffDays(t.due_date, input.today) > 0)) return "late";
  if (input.plan && ((input.plan.slipDays ?? 0) > 0 || input.plan.hasUnknownLeadTimes)) return "at_risk";
  return "on_track";
}

export const RISK_LABEL: Record<LaunchRisk, string> = { on_track: "On track", at_risk: "At risk", late: "Late" };
