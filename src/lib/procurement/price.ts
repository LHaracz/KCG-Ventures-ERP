/**
 * Listing prices (USD) for raw material and equipment supplier listings.
 * Pure (decimal.js), shared by the pages, server validation and the PO
 * prefill. Prices are stored as numeric(14,4) and must be greater than 0.
 */
import Decimal from "decimal.js";

type Num = number | string | Decimal | null | undefined;

export const MAX_PRICE_INTEGER_DIGITS = 10; // numeric(14,4)

function toDecimal(v: Num): Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * "$1,299.50", "$0.0245", "$12.00 per 25 kg bag": at least 2 and up to 4
 * decimals (zeros past the second trimmed), thousands separators, then the
 * note. Empty string when there is no price.
 */
export function formatPrice(price: Num, note?: string | null): string {
  const d = toDecimal(price);
  if (!d) return "";
  const [intPart, fracRaw = ""] = d.abs().toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4).split(".");
  const frac = fracRaw.replace(/0+$/, "").padEnd(2, "0");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const n = (note ?? "").trim();
  return `${d.isNegative() ? "-" : ""}$${grouped}.${frac}${n ? ` ${n}` : ""}`;
}

/**
 * Reads a price typed by a person ("12.5", "$1,299.50"). Blank means no
 * price. Otherwise it must be a positive number with at most 4 decimals.
 */
export function parsePrice(input: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input === "number") input = String(input);
  if (typeof input !== "string") return { ok: false, error: "Enter the price as a number, for example 12.50." };
  const t = input.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (t === "") return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: "Enter the price as a number, for example 12.50." };
  const [i, f = ""] = t.split(".");
  if (f.length > 4) return { ok: false, error: "Use at most 4 decimals." };
  if (i.replace(/^0+(?=\d)/, "").length > MAX_PRICE_INTEGER_DIGITS) return { ok: false, error: "That price is too large." };
  const d = new Decimal(t);
  if (d.lte(0)) return { ok: false, error: "The price must be greater than 0." };
  return { ok: true, value: d.toFixed() };
}

/** A plain number string for the PO form's unit price box ("1299.5"), or "" when there is no price. */
export function priceForPoLine(price: Num): string {
  const d = toDecimal(price);
  return d && d.gt(0) ? d.toDecimalPlaces(4).toFixed() : "";
}
