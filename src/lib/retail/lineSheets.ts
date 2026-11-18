/**
 * Line sheets: pure helpers (tested). Prices, margin, validation, the file
 * name and the PDF page layout. A line sheet keeps its own copy of the
 * business letterhead and every line's prices from when it was saved;
 * "Refresh prices" in the builder replaces them with the current ones.
 */
import Decimal from "decimal.js";
import { safeFilenamePart } from "./snapshots";
import { retailerMargin } from "./totals";

export const MAX_LINE_SHEET_LINES = 60;
export const DEFAULT_WHOLESALE_PERCENT = 50;
export const NO_PRICE_TEXT = "No price set";
export type PriceBasis = "retailer" | "standard";

export type LineSheetLineInput = {
  product_id: string | null;
  name: string;
  description: string;
  size_text: string;
  case_pack_text: string;
  wholesale_price: string;
  msrp: string;
  photo_asset_id: string | null;
};

export type LineSheetLine = {
  line_number: number;
  product_id: string | null;
  name: string;
  description: string | null;
  size_text: string | null;
  case_pack_text: string | null;
  wholesale_price: string | number | null;
  msrp: string | number | null;
  photo_asset_id: string | null;
};

export type LineSheetCompany = {
  display_name: string;
  legal_name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_path: string | null;
  accent_color: string;
};

export type LineSheet = {
  id: string;
  name: string;
  company_profile_id: string;
  retailer_id: string | null;
  prepared_for: string | null;
  price_basis: PriceBasis;
  standard_wholesale_percent: string | number | null;
  show_margin: boolean;
  minimum_order_text: string | null;
  lead_time_text: string | null;
  payment_terms_text: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  company_snapshot: LineSheetCompany;
  prices_saved_at: string;
  created_by_name: string | null;
  deleted_at: string | null;
  last_downloaded_at: string | null;
  created_at: string;
  updated_at: string;
};
export type LineSheetWithLines = LineSheet & { lines: LineSheetLine[] };

const dec = (v: unknown): Decimal | null => {
  if (v === null || v === undefined || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(/[$,\s]/g, ""));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};

/** Standard pricing: wholesale is a percent of MSRP (the product's sale price), rounded to 4 decimals. */
export function standardWholesale(msrp: unknown, percent: unknown): string | null {
  const m = dec(msrp);
  const p = dec(percent);
  if (!m || !p) return null;
  return m.mul(p).div(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();
}

/** The retailer's margin at MSRP (retailerMargin, the price list's helper) as "50%" or "33.33%", or null. */
export function marginPercent(wholesale: unknown, msrp: unknown): string | null {
  const m = retailerMargin(dec(msrp)?.toFixed() ?? null, dec(wholesale)?.toFixed() ?? null);
  return m === null ? null : `${m.replace(/\.?0+$/, "")}%`;
}

/** "Line Sheet - Spring Wholesale.pdf" */
export function lineSheetFilename(name: string): string {
  const n = safeFilenamePart(name) || "Untitled";
  return `Line Sheet - ${n}.pdf`;
}

/** Prepared-for line: free text wins, else the retailer's name. */
export const preparedForText = (s: Pick<LineSheet, "prepared_for">, retailerName: string | null | undefined) => s.prepared_for?.trim() || retailerName?.trim() || "";

type Errors = Record<string, string>;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type ValidLineSheet = {
  sheet: Omit<LineSheet, "id" | "company_snapshot" | "prices_saved_at" | "created_by_name" | "deleted_at" | "last_downloaded_at" | "created_at" | "updated_at">;
  lines: LineSheetLine[];
};

/** Validates the builder form. Field keys match the form ("lines.3.name"). */
export function validateLineSheet(raw: Record<string, unknown>): { ok: true; value: ValidLineSheet } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const text = (k: string, max: number, label: string) => {
    const v = str(raw[k]);
    if (v.length > max) errors[k] = `${label}: keep it under ${max} characters.`;
    return v || null;
  };
  const name = str(raw.name);
  if (!name) errors.name = "Name the line sheet.";
  else if (name.length > 200) errors.name = "Keep the name under 200 characters.";
  const company_profile_id = str(raw.company_profile_id);
  if (!UUID.test(company_profile_id)) errors.company_profile_id = "Choose a business.";
  const retailer_id = str(raw.retailer_id) || null;
  if (retailer_id && !UUID.test(retailer_id)) errors.retailer_id = "Choose a retailer from the list.";
  const price_basis = str(raw.price_basis) === "retailer" ? "retailer" : "standard";
  if (price_basis === "retailer" && !retailer_id) errors.retailer_id = "Choose the retailer whose price list to use.";
  let standard_wholesale_percent: string | null = null;
  if (price_basis === "standard") {
    const p = dec(raw.standard_wholesale_percent ?? DEFAULT_WHOLESALE_PERCENT);
    if (!p || p.lte(0) || p.gt(100)) errors.standard_wholesale_percent = "Enter a percent between 1 and 100.";
    else standard_wholesale_percent = p.toDecimalPlaces(2).toFixed();
  }
  const contact_email = text("contact_email", 320, "Email");
  if (contact_email && !EMAIL.test(contact_email)) errors.contact_email = "Enter a valid email.";
  const sheet = {
    name,
    company_profile_id,
    retailer_id,
    prepared_for: text("prepared_for", 200, "Prepared for"),
    price_basis: price_basis as PriceBasis,
    standard_wholesale_percent,
    show_margin: raw.show_margin === true,
    minimum_order_text: text("minimum_order_text", 300, "Minimum order"),
    lead_time_text: text("lead_time_text", 300, "Lead time"),
    payment_terms_text: text("payment_terms_text", 300, "Payment terms"),
    contact_name: text("contact_name", 200, "Contact"),
    contact_email,
    contact_phone: text("contact_phone", 50, "Phone"),
    notes: text("notes", 2000, "Notes"),
  };
  const rawLines = Array.isArray(raw.lines) ? (raw.lines as Array<Record<string, unknown>>) : [];
  if (rawLines.length === 0) errors.lines = "Add at least one product.";
  if (rawLines.length > MAX_LINE_SHEET_LINES) errors.lines = `A line sheet can have at most ${MAX_LINE_SHEET_LINES} products.`;
  const lines: LineSheetLine[] = rawLines.slice(0, MAX_LINE_SHEET_LINES).map((l, i) => {
    const k = (f: string) => `lines.${i}.${f}`;
    const lname = str(l.name);
    if (!lname) errors[k("name")] = "Enter the product name.";
    else if (lname.length > 200) errors[k("name")] = "Keep it under 200 characters.";
    const description = str(l.description);
    if (description.length > 500) errors[k("description")] = "Keep the description under 500 characters.";
    const size_text = str(l.size_text);
    if (size_text.length > 100) errors[k("size_text")] = "Keep it under 100 characters.";
    const case_pack_text = str(l.case_pack_text);
    if (case_pack_text.length > 100) errors[k("case_pack_text")] = "Keep it under 100 characters.";
    const price = (f: "wholesale_price" | "msrp") => {
      const v = str(l[f]);
      if (!v) return null;
      const d = dec(v);
      if (!d || d.lt(0)) {
        errors[k(f)] = "Enter a price of 0 or more.";
        return null;
      }
      return d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();
    };
    const product_id = str(l.product_id) || null;
    const photo_asset_id = str(l.photo_asset_id) || null;
    if ((product_id && !UUID.test(product_id)) || (photo_asset_id && !UUID.test(photo_asset_id))) errors[k("name")] = "Unknown product or photo.";
    return {
      line_number: i + 1,
      product_id,
      name: lname,
      description: description || null,
      size_text: size_text || null,
      case_pack_text: case_pack_text || null,
      wholesale_price: price("wholesale_price"),
      msrp: price("msrp"),
      photo_asset_id,
    };
  });
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { sheet, lines } };
}

// ---- PDF layout (estimated heights, conservative, same approach as the invoice) ----------------
export const LS = {
  pageH: 792,
  marginTop: 36,
  marginBottom: 54,
  contentW: 532,
  photo: 72, // 1 inch
  rowPad: 10,
  tableHeader: 20,
  contHeader: 40,
  avgChar: 0.55,
};
const BODY_H = LS.pageH - LS.marginTop - LS.marginBottom; // 702

export function wrapCount(text: string | null | undefined, width: number, fontSize: number): number {
  const perLine = Math.max(4, Math.floor(width / (fontSize * LS.avgChar)));
  return (text || "").split("\n").reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

export function productColumnWidth(showMargin: boolean): number {
  return LS.contentW - (LS.photo + 12) - 80 - 72 - (showMargin ? 56 : 0);
}

export function lineRowHeight(l: Pick<LineSheetLine, "name" | "description" | "size_text" | "case_pack_text">, showMargin: boolean): number {
  const w = productColumnWidth(showMargin) - 10;
  const meta = [l.size_text, l.case_pack_text ? `Case pack: ${l.case_pack_text}` : null].filter(Boolean).join(" · ");
  const textH = wrapCount(l.name, w, 9.5) * 12.5 + (l.description ? wrapCount(l.description, w, 8) * 10.5 + 2 : 0) + (meta ? wrapCount(meta, w, 7.5) * 10 + 2 : 0);
  return Math.max(LS.photo, textH) + LS.rowPad;
}

export function firstHeaderHeight(s: Pick<LineSheet, "company_snapshot" | "prepared_for">, preparedFor: string): number {
  const c = s.company_snapshot;
  const addr = [c.address_line1, c.address_line2, [c.city, c.state, c.zip].filter(Boolean).join(" "), c.phone, c.email, c.website].filter(Boolean).length;
  const left = 52 + 14 + addr * 11;
  const right = 30 + 16 + (preparedFor ? 12 + wrapCount(preparedFor, 230, 9) * 12 : 0) + 12;
  return Math.max(left, right) + 16;
}

export function termsBoxHeight(s: Pick<LineSheet, "minimum_order_text" | "lead_time_text" | "payment_terms_text" | "contact_name" | "contact_email" | "contact_phone" | "notes" | "price_basis">): number {
  const half = LS.contentW / 2 - 24;
  const rows = [s.minimum_order_text, s.lead_time_text, s.payment_terms_text].filter(Boolean) as string[];
  const contact = [s.contact_name, s.contact_email, s.contact_phone].filter(Boolean) as string[];
  const left = 14 + rows.reduce((n, r) => n + wrapCount(r, half - 70, 8.5) * 11.5 + 2, 0);
  const right = 14 + contact.reduce((n, r) => n + wrapCount(r, half, 8.5) * 11.5, 0);
  const notes = s.notes ? 12 + wrapCount(s.notes, LS.contentW - 24, 8.5) * 11.5 : 0;
  return 14 + 22 + Math.max(left, right, 26) + notes + 18; // gap + padding + price note
}

export type LineSheetPage<T> = { first: boolean; rows: T[]; tail: boolean };

/**
 * Splits rows into pages. Every page repeats the table header; a row never
 * splits; the terms box stays together and on the page with the last rows
 * (rows move with it rather than leaving it alone on a page).
 */
export function paginateLineSheet<T extends Pick<LineSheetLine, "name" | "description" | "size_text" | "case_pack_text">>(
  s: Parameters<typeof termsBoxHeight>[0] & Pick<LineSheet, "company_snapshot" | "prepared_for" | "show_margin">,
  lines: readonly T[],
  preparedFor: string,
): LineSheetPage<T>[] {
  const firstBudget = BODY_H - firstHeaderHeight(s, preparedFor) - LS.tableHeader - 8;
  const contBudget = BODY_H - LS.contHeader - LS.tableHeader - 8;
  const tail = termsBoxHeight(s);
  const pages: { rows: T[]; used: number; budget: number }[] = [{ rows: [], used: 0, budget: firstBudget }];
  for (const line of lines) {
    const h = lineRowHeight(line, s.show_margin);
    let p = pages[pages.length - 1];
    if (p.rows.length > 0 && p.used + h > p.budget) {
      p = { rows: [], used: 0, budget: contBudget };
      pages.push(p);
    }
    p.rows.push(line);
    p.used += h;
  }
  const last = pages[pages.length - 1];
  if (last.used + tail > last.budget) {
    const r = last.rows.pop();
    if (r) {
      const h = lineRowHeight(r, s.show_margin);
      last.used -= h;
      if (last.rows.length === 0 && pages.length > 1) pages.pop();
      pages.push({ rows: [r], used: h, budget: contBudget });
    }
  }
  return pages.map((p, i) => ({ first: i === 0, rows: p.rows, tail: i === pages.length - 1 }));
}
