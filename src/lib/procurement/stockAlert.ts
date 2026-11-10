/**
 * Stock alerts for raw materials on the Procurement page, and the order
 * quantity suggested when a Purchase Order is started from it. Pure
 * functions (decimal.js, no rounding surprises), shared by the page, the
 * server prefill and the tests.
 */
import Decimal from "decimal.js";

export type StockState = "out" | "below" | "ok" | "no_par";

export type StockAlert = {
  state: StockState;
  /** par - on hand, only for "below". */
  shortBy: Decimal | null;
  label: string;
};

type Num = number | string | Decimal | null | undefined;

function toDecimal(v: Num): Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** "12.5", "3", "0.125": no trailing zeros, no exponent. */
export function formatQuantity(v: Num): string {
  const d = toDecimal(v);
  if (!d) return "";
  return d.toDecimalPlaces(3).toFixed().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function stockAlert(onHand: Num, parLevel: Num, unit: string | null | undefined): StockAlert {
  const qty = toDecimal(onHand) ?? new Decimal(0);
  const par = toDecimal(parLevel);
  if (qty.lte(0)) return { state: "out", shortBy: null, label: "Out of stock" };
  if (!par || par.lte(0)) return { state: "no_par", shortBy: null, label: "No par level set" };
  if (qty.lt(par)) {
    const shortBy = par.minus(qty);
    const u = (unit ?? "").trim();
    return { state: "below", shortBy, label: `Below par: short by ${formatQuantity(shortBy)}${u ? ` ${u}` : ""}` };
  }
  return { state: "ok", shortBy: null, label: "OK" };
}

const GROUP_ORDER: Record<StockState, number> = { out: 0, below: 1, ok: 2, no_par: 3 };

export type SortableMaterial = { name: string; quantity_on_hand: Num; par_level: Num; unit?: string | null };

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name);

/**
 * Comparator for the Procurement table: out, below, ok, no par.
 * Out: largest par first, then name. Below: lowest on hand / par first (worst
 * shortage), then name. OK and no par: by name.
 */
export function compareByStockAlert(a: SortableMaterial, b: SortableMaterial): number {
  const sa = stockAlert(a.quantity_on_hand, a.par_level, a.unit).state;
  const sb = stockAlert(b.quantity_on_hand, b.par_level, b.unit).state;
  if (sa !== sb) return GROUP_ORDER[sa] - GROUP_ORDER[sb];
  if (sa === "out") {
    const pa = toDecimal(a.par_level) ?? new Decimal(0);
    const pb = toDecimal(b.par_level) ?? new Decimal(0);
    const c = pb.comparedTo(pa);
    if (c !== 0) return c;
  }
  if (sa === "below") {
    const ra = toDecimal(a.quantity_on_hand)!.div(toDecimal(a.par_level)!);
    const rb = toDecimal(b.quantity_on_hand)!.div(toDecimal(b.par_level)!);
    const c = ra.comparedTo(rb);
    if (c !== 0) return c;
  }
  return byName(a, b);
}

export function sortByStockAlert<T extends SortableMaterial>(rows: readonly T[]): T[] {
  return [...rows].sort(compareByStockAlert);
}

/** Out of stock or below par. */
export const isShortage = (state: StockState) => state === "out" || state === "below";

/**
 * Quantity to order to get back to par: par - max(on hand, 0), rounded UP to
 * 3 decimals. Null when there is no par (the user types it) or nothing to order.
 */
export function suggestedQuantity(onHand: Num, parLevel: Num): Decimal | null {
  const par = toDecimal(parLevel);
  if (!par || par.lte(0)) return null;
  const qty = Decimal.max(toDecimal(onHand) ?? new Decimal(0), 0);
  const need = Decimal.max(par.minus(qty), 0).toDecimalPlaces(3, Decimal.ROUND_UP);
  return need.isZero() ? null : need;
}
