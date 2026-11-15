/**
 * Due dates by whole calendar days on date-only "YYYY-MM-DD" values. UTC
 * date arithmetic only, so daylight saving changes can never shift a date.
 */
import type { TermsStart, TermsType } from "./terms";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function addDays(iso: string, days: number): string {
  if (!isIsoDate(iso)) throw new Error(`Not a date: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export const isValidNetDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 180;

/**
 * net: start date + net days. Due on receipt and prepaid: invoice date
 * (prepaid is shown as "Due before delivery"). Due on delivery: delivery
 * date. Consignment: null (no due date).
 */
export function computeDueDate(
  invoiceDate: string,
  deliveryDate: string,
  termsType: TermsType,
  netDays: number | null | undefined,
  termsStart: TermsStart = "invoice_date",
): string | null {
  switch (termsType) {
    case "net": {
      if (!isValidNetDays(netDays)) throw new Error("Net days must be a whole number from 1 to 180.");
      return addDays(termsStart === "delivery_date" ? deliveryDate : invoiceDate, netDays);
    }
    case "due_on_receipt":
    case "prepaid":
      return isIsoDate(invoiceDate) ? invoiceDate : (() => { throw new Error(`Not a date: ${invoiceDate}`); })();
    case "due_on_delivery":
      return isIsoDate(deliveryDate) ? deliveryDate : (() => { throw new Error(`Not a date: ${deliveryDate}`); })();
    case "consignment":
      return null;
  }
}
