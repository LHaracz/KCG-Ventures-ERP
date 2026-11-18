/**
 * Ingredient planning for a launch's test batch: stock on hand, stock in
 * transit and supplier lead times turned into "order by" dates and the
 * earliest possible test batch date. Quantities use decimal.js and are in
 * each raw material's own unit. Dates are date-only.
 */
import Decimal from "decimal.js";
import { addDays, diffDays, maxDate } from "./dates";

export type IngredientStatus = "pending" | "ordered" | "arrived" | "skipped";
export type PlanState = "skipped" | "enough" | "to_order" | "ordered_short" | "ordered" | "arrived" | "no_lead_time";

export type PlanRowInput = {
  needed: Decimal.Value;
  onHand: Decimal.Value | null;
  /** Counts only while the row is 'ordered'. */
  qtyOrdered: Decimal.Value | null;
  status: IngredientStatus;
  orderedAt: string | null;
  expectedArrival: string | null;
  leadTimeDays: number | null;
};

export type PlanRow = {
  needed: string;
  onHand: string;
  inTransit: string;
  shortfall: string;
  state: PlanState;
  /** to_order / no_lead_time rows: last day to order (null when the lead time or planned date is unknown). */
  orderBy: string | null;
  lateByDays: number;
  /** to_order rows with a known lead time. */
  arrivalIfOrderedToday: string | null;
  /** ordered / ordered_short rows. */
  expectedArrivalDate: string | null;
};

export type Plan = {
  rows: PlanRow[];
  earliestTestBatchDate: string;
  slipDays: number | null;
  hasUnknownLeadTimes: boolean;
};

const dec = (v: Decimal.Value | null | undefined) => {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  const d = new Decimal(v);
  return d.isFinite() ? d : new Decimal(0);
};
const knownLead = (n: number | null) => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function planRow(row: PlanRowInput, ctx: { today: string; plannedTestBatchDate: string | null; bufferDays: number }): PlanRow {
  const needed = dec(row.needed);
  const onHand = Decimal.max(dec(row.onHand), 0);
  const inTransit = row.status === "ordered" ? Decimal.max(dec(row.qtyOrdered), 0) : new Decimal(0);
  const shortfall = Decimal.max(needed.minus(onHand).minus(inTransit), 0);
  const base = {
    needed: needed.toFixed(),
    onHand: onHand.toFixed(),
    inTransit: inTransit.toFixed(),
    shortfall: shortfall.toFixed(),
    orderBy: null as string | null,
    lateByDays: 0,
    arrivalIfOrderedToday: null as string | null,
    expectedArrivalDate: null as string | null,
  };
  if (row.status === "skipped") return { ...base, state: "skipped" };

  if (row.status === "ordered") {
    const expected = row.expectedArrival ?? (row.orderedAt && knownLead(row.leadTimeDays) ? addDays(row.orderedAt, row.leadTimeDays!) : null);
    return { ...base, state: shortfall.gt(0) ? "ordered_short" : "ordered", expectedArrivalDate: expected };
  }
  if (shortfall.isZero()) return { ...base, state: row.status === "arrived" ? "arrived" : "enough" };

  // Still short and not ordered (pending, or arrived but not enough).
  if (!knownLead(row.leadTimeDays)) return { ...base, state: "no_lead_time" };
  const lead = row.leadTimeDays!;
  const orderBy = ctx.plannedTestBatchDate ? addDays(ctx.plannedTestBatchDate, -(lead + ctx.bufferDays)) : null;
  return {
    ...base,
    state: "to_order",
    orderBy,
    lateByDays: orderBy ? Math.max(diffDays(orderBy, ctx.today), 0) : 0,
    arrivalIfOrderedToday: addDays(ctx.today, lead),
  };
}

export function planIngredients(input: {
  today: string;
  plannedTestBatchDate: string | null;
  bufferDays: number;
  rows: PlanRowInput[];
}): Plan {
  const ctx = { today: input.today, plannedTestBatchDate: input.plannedTestBatchDate, bufferDays: input.bufferDays };
  const rows = input.rows.map((r) => planRow(r, ctx));
  const dates = rows.flatMap((r) =>
    r.state === "to_order" ? [r.arrivalIfOrderedToday] : r.state === "ordered" || r.state === "ordered_short" ? [r.expectedArrivalDate] : [],
  );
  const latest = maxDate(dates);
  const earliestTestBatchDate = latest && latest > input.today ? latest : input.today;
  return {
    rows,
    earliestTestBatchDate,
    slipDays: input.plannedTestBatchDate ? Math.max(diffDays(input.plannedTestBatchDate, earliestTestBatchDate), 0) : null,
    hasUnknownLeadTimes: rows.some(
      (r) => r.state === "no_lead_time" || ((r.state === "ordered" || r.state === "ordered_short") && !r.expectedArrivalDate),
    ),
  };
}

/** Chip shown in the Ingredients table. */
export function stateChip(row: Pick<PlanRow, "state" | "lateByDays">): { label: string; tone: "green" | "amber" | "red" | "blue" | "zinc" } {
  switch (row.state) {
    case "enough":
      return { label: "Enough", tone: "green" };
    case "arrived":
      return { label: "Arrived", tone: "green" };
    case "skipped":
      return { label: "Skipped", tone: "zinc" };
    case "ordered":
      return { label: "Ordered", tone: "blue" };
    case "ordered_short":
      return { label: "Ordered (short)", tone: "amber" };
    case "no_lead_time":
      return { label: "To order (no lead time)", tone: "amber" };
    default:
      return row.lateByDays > 0 ? { label: "Late", tone: "red" } : { label: "To order", tone: "amber" };
  }
}
