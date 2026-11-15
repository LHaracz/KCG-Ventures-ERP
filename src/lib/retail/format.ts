/**
 * Number and date formatting for Retail screens and the invoice PDF.
 * decimal.js for money and quantities; dates are date-only "YYYY-MM-DD"
 * strings (never timestamps), and "today" is the America/New_York date.
 */
import Decimal from "decimal.js";

type Num = number | string | Decimal | null | undefined;

export function toDecimal(v: Num): Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

const group = (intPart: string) => intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "$1,234.56" (round half up to cents). "$0.00" for null. */
export function formatMoney(v: Num): string {
  const d = toDecimal(v) ?? new Decimal(0);
  const fixed = d.abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const [i, f] = fixed.split(".");
  return `${d.isNegative() && !d.isZero() ? "-" : ""}$${group(i)}.${f}`;
}

/** Unit prices: at least 2 and up to 4 decimals ("$12.50", "$0.0245"). */
export function formatUnitPrice(v: Num): string {
  const d = toDecimal(v);
  if (!d) return "";
  const [i, fRaw = ""] = d.abs().toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4).split(".");
  const f = fRaw.replace(/0+$/, "").padEnd(2, "0");
  return `${d.isNegative() ? "-" : ""}$${group(i)}.${f}`;
}

/** Quantities: thousands separators, up to 3 decimals, trailing zeros trimmed ("1,250", "2.5"). */
export function formatQuantity(v: Num): string {
  const d = toDecimal(v);
  if (!d) return "";
  const [i, fRaw = ""] = d.abs().toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3).split(".");
  const f = fRaw.replace(/0+$/, "");
  return `${d.isNegative() ? "-" : ""}${group(i)}${f ? `.${f}` : ""}`;
}

/** Percentages with trailing zeros trimmed: 70, 66.67, 7.5. */
export function formatPercent(v: Num): string {
  const d = toDecimal(v);
  if (!d) return "";
  return d.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string | null | undefined): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "December 15, 2026" from "2026-12-15". */
export function formatLongDate(iso: string | null | undefined): string {
  const p = parts(iso);
  return p ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : "";
}

/** "Dec 15, 2026" from "2026-12-15". */
export function formatShortDate(iso: string | null | undefined): string {
  const p = parts(iso);
  return p ? `${SHORT[p[1] - 1]} ${p[2]}, ${p[0]}` : "";
}

/** Today's date in America/New_York as "YYYY-MM-DD". */
export function todayNy(now: Date = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(now);
}
