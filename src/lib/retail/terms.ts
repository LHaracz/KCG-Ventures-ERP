/**
 * Payment terms for retail invoices, including consignment (terms and a
 * document only: the ERP does not track consignment stock, sales or
 * settlements). Pure and tested.
 */
import Decimal from "decimal.js";
import { formatPercent, toDecimal } from "./format";
import { isValidNetDays } from "./dueDate";

export const TERMS_TYPES = ["net", "due_on_receipt", "due_on_delivery", "prepaid", "consignment"] as const;
export type TermsType = (typeof TERMS_TYPES)[number];
export const DEFAULT_TERMS_TYPES = ["net", "due_on_receipt", "due_on_delivery", "prepaid"] as const;
export type DefaultTermsType = (typeof DEFAULT_TERMS_TYPES)[number];
export type TermsStart = "invoice_date" | "delivery_date";
export type ConsignmentSchedule = "biweekly" | "monthly";

export type Terms = {
  terms_type: TermsType;
  net_days: number | null;
  terms_start: TermsStart;
  consignment_our_share_percent: number | string | null;
  consignment_schedule: ConsignmentSchedule | null;
  consignment_days_to_pay: number | null;
  consignment_extra_terms: string | null;
};

export const NET_DAY_CHOICES = [15, 30, 45, 60] as const;
export const DEFAULT_DAYS_TO_PAY = 15;

/** "Net 30", "Due on receipt", "Due on delivery", "Prepaid (payment due before delivery)", "Consignment". */
export function termsLabel(t: Pick<Terms, "terms_type" | "net_days">): string {
  switch (t.terms_type) {
    case "net":
      return `Net ${t.net_days ?? ""}`.trim();
    case "due_on_receipt":
      return "Due on receipt";
    case "due_on_delivery":
      return "Due on delivery";
    case "prepaid":
      return "Prepaid (payment due before delivery)";
    case "consignment":
      return "Consignment";
  }
}

/** Short form for tables: "Net 30", "Consignment 70%, monthly". */
export function termsSummary(t: Terms): string {
  if (t.terms_type === "prepaid") return "Prepaid";
  if (t.terms_type !== "consignment") return termsLabel(t);
  const share = formatPercent(t.consignment_our_share_percent);
  return `Consignment${share ? ` ${share}%` : ""}${t.consignment_schedule ? `, ${t.consignment_schedule === "biweekly" ? "every two weeks" : "monthly"}` : ""}`;
}

/** The retailer's share: 100 minus our share, trailing zeros trimmed ("30", "33.33"). */
export function retailerSharePercent(ourShare: number | string | null | undefined): string {
  const d = toDecimal(ourShare);
  return d ? formatPercent(new Decimal(100).minus(d)) : "";
}

/** The printed consignment terms, built only from the structured fields. */
export function consignmentTermsText(t: Terms, legalName: string): string[] {
  const share = formatPercent(t.consignment_our_share_percent);
  const lines = [
    `${legalName} receives ${share}% of the retail price of each unit sold. The retailer retains ${retailerSharePercent(t.consignment_our_share_percent)}%.`,
    `Sales are reported and settled ${t.consignment_schedule === "biweekly" ? "every two weeks" : "monthly"}.`,
    `Payment is due ${t.consignment_days_to_pay} days after each settlement statement.`,
  ];
  const extra = (t.consignment_extra_terms ?? "").trim();
  if (extra) lines.push(extra);
  return lines;
}

export type InvoiceSettingsDefaults = { default_terms_type: DefaultTermsType; default_net_days: number };

/**
 * The retailer's terms for the chosen business when they exist (with every
 * consignment field), otherwise the business defaults from invoice settings.
 */
export function resolveDefaultTerms(
  retailerTerms: Terms | null | undefined,
  settings: InvoiceSettingsDefaults | null | undefined,
): Terms & { source: "retailer" | "business_default" } {
  if (retailerTerms) {
    return {
      terms_type: retailerTerms.terms_type,
      net_days: retailerTerms.terms_type === "net" ? retailerTerms.net_days : null,
      terms_start: retailerTerms.terms_start ?? "invoice_date",
      consignment_our_share_percent: retailerTerms.consignment_our_share_percent,
      consignment_schedule: retailerTerms.consignment_schedule,
      consignment_days_to_pay: retailerTerms.consignment_days_to_pay,
      consignment_extra_terms: retailerTerms.consignment_extra_terms,
      source: "retailer",
    };
  }
  const type: DefaultTermsType = settings?.default_terms_type ?? "net";
  return {
    terms_type: type,
    net_days: type === "net" ? settings?.default_net_days ?? 30 : null,
    terms_start: "invoice_date",
    consignment_our_share_percent: null,
    consignment_schedule: null,
    consignment_days_to_pay: null,
    consignment_extra_terms: null,
    source: "business_default",
  };
}

export type TermsErrors = Record<string, string>;

/**
 * Checks and normalizes terms (client and server). Fields that don't apply
 * to the chosen type are cleared, so stored rows never carry stale values.
 */
export function validateTerms(input: unknown): { ok: true; value: Terms } | { ok: false; errors: TermsErrors } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: TermsErrors = {};
  const type = raw.terms_type as TermsType;
  if (!TERMS_TYPES.includes(type)) {
    return { ok: false, errors: { terms_type: "Choose payment terms." } };
  }
  const intOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  let net_days: number | null = null;
  let terms_start: TermsStart = "invoice_date";
  if (type === "net") {
    const n = intOf(raw.net_days);
    if (!isValidNetDays(n)) errors.net_days = "Net days must be a whole number from 1 to 180.";
    else net_days = n;
    terms_start = raw.terms_start === "delivery_date" ? "delivery_date" : "invoice_date";
  }
  let share: string | null = null;
  let schedule: ConsignmentSchedule | null = null;
  let days: number | null = null;
  let extra: string | null = null;
  if (type === "consignment") {
    const s = typeof raw.consignment_our_share_percent === "number" ? String(raw.consignment_our_share_percent) : String(raw.consignment_our_share_percent ?? "").trim();
    const d = /^\d+(\.\d{1,2})?$/.test(s) ? new Decimal(s) : null;
    if (!d || d.lte(0) || d.gte(100)) errors.consignment_our_share_percent = "Enter our share as a number greater than 0 and less than 100, with at most 2 decimals.";
    else share = d.toFixed();
    if (raw.consignment_schedule === "biweekly" || raw.consignment_schedule === "monthly") schedule = raw.consignment_schedule;
    else errors.consignment_schedule = "Choose a settlement schedule.";
    const n = intOf(raw.consignment_days_to_pay);
    if (!isValidNetDays(n)) errors.consignment_days_to_pay = "Days to pay must be a whole number from 1 to 180.";
    else days = n;
    const e = typeof raw.consignment_extra_terms === "string" ? raw.consignment_extra_terms.trim() : "";
    if (e.length > 1000) errors.consignment_extra_terms = "Keep this under 1000 characters.";
    extra = e || null;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      terms_type: type,
      net_days,
      terms_start,
      consignment_our_share_percent: share,
      consignment_schedule: schedule,
      consignment_days_to_pay: days,
      consignment_extra_terms: extra,
    },
  };
}
