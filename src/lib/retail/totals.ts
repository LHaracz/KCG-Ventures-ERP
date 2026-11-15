/**
 * Invoice money math (decimal.js, round half up). The database computes the
 * stored totals the same way (create_invoice / update_invoice); a test keeps
 * the two in step. The browser's totals are a preview only.
 */
import Decimal from "decimal.js";
import { toDecimal } from "./format";
import type { TermsType } from "./terms";

type Num = number | string | Decimal | null | undefined;
export type TotalsLine = { quantity: Num; unit_price: Num };

export function lineTotal(quantity: Num, unitPrice: Num): Decimal {
  const q = toDecimal(quantity) ?? new Decimal(0);
  const p = toDecimal(unitPrice) ?? new Decimal(0);
  return q.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).times(p.toDecimalPlaces(4, Decimal.ROUND_HALF_UP)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Tax is on the subtotal only (never the delivery fee); 0 when exempt. */
export function computeTotals(lines: readonly TotalsLine[], deliveryFee: Num, taxRatePercent: Num, taxExempt: boolean) {
  const lineTotals = lines.map((l) => lineTotal(l.quantity, l.unit_price));
  const subtotal = lineTotals.reduce((a, b) => a.plus(b), new Decimal(0));
  const fee = (toDecimal(deliveryFee) ?? new Decimal(0)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const rate = toDecimal(taxRatePercent) ?? new Decimal(0);
  const tax = taxExempt ? new Decimal(0) : subtotal.times(rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const total = subtotal.plus(fee).plus(tax);
  return {
    lineTotals: lineTotals.map((d) => d.toFixed(2)),
    subtotal: subtotal.toFixed(2),
    deliveryFee: fee.toFixed(2),
    tax: tax.toFixed(2),
    total: total.toFixed(2),
  };
}

export type RetailerPrice = { wholesale_price: Num; msrp: Num };

/** Consignment invoices use the retailer's MSRP (retail value); all others the wholesale price. Null when not set. */
export function linePriceFor(termsType: TermsType, price: RetailerPrice | null | undefined): string | null {
  const v = toDecimal(termsType === "consignment" ? price?.msrp : price?.wholesale_price);
  return v ? v.toFixed() : null;
}

/** (MSRP - wholesale) / MSRP as a percentage (2 decimals), or null. */
export function retailerMargin(msrp: Num, wholesale: Num): string | null {
  const m = toDecimal(msrp);
  const w = toDecimal(wholesale);
  if (!m || !w || m.isZero()) return null;
  return m.minus(w).div(m).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
