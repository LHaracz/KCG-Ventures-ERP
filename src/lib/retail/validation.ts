/**
 * Retail input checks, shared by the browser (errors beside fields and in
 * the summary at the top of a form) and the server routes (the input is
 * never trusted). The database checks again with constraints.
 */
import Decimal from "decimal.js";
import { isIsoDate } from "./dueDate";
import { normalizeOrderNumber } from "./orderNumber";
import { validateTerms, type Terms } from "./terms";
import { INVOICE_PREFIX_RE } from "./invoiceNumber";
import { INVOICE_UNITS, type Address } from "./types";

export type FieldErrors = Record<string, string>;
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function isHttpUrl(v: string): boolean {
  if (v.length > 2000 || !/^https?:\/\/[^\s]+$/i.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}
export const isEmail = (v: string) => v.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** A 13-19 digit number that passes the Luhn check (looks like a card number). */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

function str(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function maxLen(errors: FieldErrors, key: string, v: string | null, n: number) {
  if (v && v.length > n) errors[key] = `Keep this under ${n + 1} characters.`;
}
function noteField(errors: FieldErrors, key: string, v: string | null, n: number) {
  maxLen(errors, key, v, n);
  if (!errors[key] && v && looksLikeCardNumber(v)) errors[key] = "This looks like a card number. Do not store card numbers here.";
}

/** A decimal typed by a person ("12.5", "$1,299.50"). Blank -> null. */
export function parseDecimal(
  input: unknown,
  opts: { maxDecimals: number; maxIntegerDigits: number; min: "zero" | "positive"; label: string },
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null };
  const s = (typeof input === "number" ? String(input) : typeof input === "string" ? input : "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (s === "") return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: `Enter ${opts.label} as a number.` };
  const [i, f = ""] = s.split(".");
  if (f.length > opts.maxDecimals) return { ok: false, error: `Use at most ${opts.maxDecimals} decimals.` };
  if (i.replace(/^0+(?=\d)/, "").length > opts.maxIntegerDigits) return { ok: false, error: `That ${opts.label} is too large.` };
  const d = new Decimal(s);
  if (opts.min === "positive" && d.lte(0)) return { ok: false, error: `${opts.label[0].toUpperCase()}${opts.label.slice(1)} must be greater than 0.` };
  return { ok: true, value: d.toFixed() };
}

/** Price list cells: positive, at most 4 decimals, or blank. */
export const parseListPrice = (v: unknown) => parseDecimal(v, { maxDecimals: 4, maxIntegerDigits: 8, min: "positive", label: "the price" });

// --- Retailers ------------------------------------------------------------------------
export type RetailerValues = {
  name: string;
  legal_name: string | null;
  description: string | null;
  website_url: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_line1: string | null;
  billing_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  billing_country: string | null;
  shipping_same_as_billing: boolean;
  shipping_name: string | null;
  shipping_line1: string | null;
  shipping_line2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_zip: string | null;
  shipping_country: string | null;
  tax_exempt: boolean;
  resale_certificate_number: string | null;
  notes: string | null;
};

const ADDR = ["line1", "line2", "city", "state", "zip", "country"] as const;
const REQUIRED_ADDR: Record<string, string> = { line1: "Address line 1", city: "City", state: "State", zip: "ZIP" };

export function validateRetailer(input: unknown): Checked<RetailerValues> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: FieldErrors = {};
  const name = str(raw, "name");
  if (!name) errors.name = "Retailer name is required.";
  maxLen(errors, "name", name, 200);
  const legal_name = str(raw, "legal_name");
  maxLen(errors, "legal_name", legal_name, 200);
  const description = str(raw, "description");
  noteField(errors, "description", description, 4000);
  const website_url = str(raw, "website_url");
  if (website_url && !isHttpUrl(website_url)) errors.website_url = "Enter a full web address starting with http:// or https://.";
  const contact_name = str(raw, "contact_name");
  maxLen(errors, "contact_name", contact_name, 200);
  const contact_email = str(raw, "contact_email");
  if (contact_email && !isEmail(contact_email)) errors.contact_email = "Enter a valid email address.";
  const contact_phone = str(raw, "contact_phone");
  maxLen(errors, "contact_phone", contact_phone, 50);

  const v: Record<string, string | null> = {};
  for (const part of ADDR) {
    const key = `billing_${part}`;
    v[key] = str(raw, key);
    maxLen(errors, key, v[key], 200);
    if (REQUIRED_ADDR[part] && !v[key]) errors[key] = `Billing ${REQUIRED_ADDR[part].toLowerCase()} is required.`;
  }
  if (!v.billing_country) v.billing_country = "United States";
  const shipping_same_as_billing = raw.shipping_same_as_billing !== false;
  v.shipping_name = str(raw, "shipping_name");
  maxLen(errors, "shipping_name", v.shipping_name, 200);
  for (const part of ADDR) {
    const key = `shipping_${part}`;
    v[key] = shipping_same_as_billing ? null : str(raw, key);
    maxLen(errors, key, v[key], 200);
    if (!shipping_same_as_billing && REQUIRED_ADDR[part] && !v[key]) errors[key] = `Shipping ${REQUIRED_ADDR[part].toLowerCase()} is required.`;
  }
  if (!shipping_same_as_billing && !v.shipping_country) v.shipping_country = "United States";
  if (shipping_same_as_billing) v.shipping_name = null;

  const tax_exempt = raw.tax_exempt === true;
  const resale_certificate_number = tax_exempt ? str(raw, "resale_certificate_number") : null;
  maxLen(errors, "resale_certificate_number", resale_certificate_number, 100);
  const notes = str(raw, "notes");
  noteField(errors, "notes", notes, 4000);

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name!,
      legal_name,
      description,
      website_url,
      contact_name,
      contact_email,
      contact_phone,
      billing_line1: v.billing_line1,
      billing_line2: v.billing_line2,
      billing_city: v.billing_city,
      billing_state: v.billing_state,
      billing_zip: v.billing_zip,
      billing_country: v.billing_country,
      shipping_same_as_billing,
      shipping_name: v.shipping_name,
      shipping_line1: v.shipping_line1,
      shipping_line2: v.shipping_line2,
      shipping_city: v.shipping_city,
      shipping_state: v.shipping_state,
      shipping_zip: v.shipping_zip,
      shipping_country: v.shipping_country,
      tax_exempt,
      resale_certificate_number,
      notes,
    },
  };
}

/** Terms by business: { [company_profile_id]: Terms | null } (null = use the business default). */
export function validateTermsByBusiness(input: unknown, businessIds: readonly string[]): Checked<Record<string, Terms | null>> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: FieldErrors = {};
  const out: Record<string, Terms | null> = {};
  for (const id of Object.keys(raw)) {
    if (!businessIds.includes(id)) {
      errors[`terms.${id}`] = "Unknown business.";
      continue;
    }
    const t = raw[id];
    if (t === null || t === undefined || (typeof t === "object" && (t as Record<string, unknown>).terms_type === "default")) {
      out[id] = null;
      continue;
    }
    const r = validateTerms(t);
    if (r.ok) out[id] = r.value;
    else for (const [k, m] of Object.entries(r.errors)) errors[`terms.${id}.${k}`] = m;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

// --- Invoice settings -----------------------------------------------------------------
export type SettingsValues = {
  invoice_prefix: string;
  payable_to: string | null;
  remit_line1: string | null;
  remit_line2: string | null;
  remit_city: string | null;
  remit_state: string | null;
  remit_zip: string | null;
  remit_country: string | null;
  payment_instructions: string | null;
  default_terms_type: "net" | "due_on_receipt" | "due_on_delivery" | "prepaid";
  default_net_days: number;
  default_tax_rate_percent: string;
  footer_note: string | null;
  product_scope: "botaniqals" | "minileaf" | "all";
};

export function validateSettings(input: unknown): Checked<SettingsValues> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: FieldErrors = {};
  const prefix = (str(raw, "invoice_prefix") ?? "").toUpperCase();
  if (!INVOICE_PREFIX_RE.test(prefix)) errors.invoice_prefix = "Use 1 to 20 letters, numbers or dashes, starting with a letter or number.";
  const payable_to = str(raw, "payable_to");
  maxLen(errors, "payable_to", payable_to, 200);
  const remit: Record<string, string | null> = {};
  for (const part of ADDR) {
    remit[part] = str(raw, `remit_${part}`);
    maxLen(errors, `remit_${part}`, remit[part], 200);
  }
  const payment_instructions = str(raw, "payment_instructions");
  noteField(errors, "payment_instructions", payment_instructions, 2000);
  const type = raw.default_terms_type;
  if (type !== "net" && type !== "due_on_receipt" && type !== "due_on_delivery" && type !== "prepaid") errors.default_terms_type = "Choose default payment terms.";
  const days = typeof raw.default_net_days === "number" ? raw.default_net_days : Number(raw.default_net_days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 180) errors.default_net_days = "Net days must be a whole number from 1 to 180.";
  const tax = parseDecimal(raw.default_tax_rate_percent ?? "0", { maxDecimals: 3, maxIntegerDigits: 3, min: "zero", label: "the tax rate" });
  if (!tax.ok) errors.default_tax_rate_percent = tax.error;
  else if (tax.value && new Decimal(tax.value).gt(100)) errors.default_tax_rate_percent = "The tax rate must be 100 or less.";
  const footer_note = str(raw, "footer_note");
  noteField(errors, "footer_note", footer_note, 500);
  const scope = raw.product_scope ?? "all";
  if (scope !== "botaniqals" && scope !== "minileaf" && scope !== "all") errors.product_scope = "Choose which products this business sells.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      invoice_prefix: prefix,
      payable_to,
      remit_line1: remit.line1,
      remit_line2: remit.line2,
      remit_city: remit.city,
      remit_state: remit.state,
      remit_zip: remit.zip,
      remit_country: remit.country,
      payment_instructions,
      default_terms_type: type as SettingsValues["default_terms_type"],
      default_net_days: days,
      default_tax_rate_percent: tax.ok && tax.value ? tax.value : "0",
      footer_note,
      product_scope: scope as SettingsValues["product_scope"],
    },
  };
}

// --- Invoices -------------------------------------------------------------------------------
export type InvoiceLineInput = {
  product_id: string | null;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  /** Write this line's price to the retailer's price list (non-consignment only). */
  save_to_price_list: boolean;
};

export type InvoiceInput = {
  company_profile_id: string;
  retailer_id: string;
  order_number: string;
  invoice_date: string;
  delivery_date: string;
  retailer_po_number: string | null;
  terms: Terms;
  delivery_fee: string;
  tax_exempt: boolean;
  tax_rate_percent: string;
  bill_to: Address;
  ship_to: Address;
  notes_to_retailer: string | null;
  internal_notes: string | null;
  /** Edit only: replace the business and retailer snapshots with current records. */
  refresh_snapshots: boolean;
  lines: InvoiceLineInput[];
};

export const MAX_INVOICE_LINES = 100;

function address(raw: unknown, prefix: string, label: string, errors: FieldErrors, withContact: boolean): Address {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const a: Address = {
    name: str(r, "name") ?? "",
    line1: str(r, "line1") ?? "",
    line2: str(r, "line2") ?? "",
    city: str(r, "city") ?? "",
    state: str(r, "state") ?? "",
    zip: str(r, "zip") ?? "",
    country: str(r, "country") ?? "",
  };
  if (withContact) {
    a.contact_name = str(r, "contact_name") ?? "";
    a.email = str(r, "email") ?? "";
    a.phone = str(r, "phone") ?? "";
    if (a.email && !isEmail(a.email)) errors[`${prefix}.email`] = `${label} email is not valid.`;
  }
  const req: [keyof Address, string][] = [["name", "name"], ["line1", "address line 1"], ["city", "city"], ["state", "state"], ["zip", "ZIP"]];
  for (const [k, l] of req) if (!a[k]) errors[`${prefix}.${k}`] = `${label} ${l} is required.`;
  for (const [k, v] of Object.entries(a)) if (typeof v === "string" && v.length > 200) errors[`${prefix}.${k}`] = `${label}: keep each field under 201 characters.`;
  return a;
}

/** Checks and normalizes an invoice from the form. Errors are keyed by field for the summary list. */
export function validateInvoiceInput(input: unknown): Checked<InvoiceInput> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: FieldErrors = {};
  const company_profile_id = raw.company_profile_id;
  if (!isUuid(company_profile_id)) errors.company_profile_id = "Choose a business.";
  const retailer_id = raw.retailer_id;
  if (!isUuid(retailer_id)) errors.retailer_id = "Choose a retailer.";
  const order = normalizeOrderNumber(raw.order_number);
  if (!order.ok) errors.order_number = order.error;

  const invoice_date = raw.invoice_date;
  if (!isIsoDate(invoice_date)) errors.invoice_date = "Enter the invoice date.";
  const delivery_date = raw.delivery_date;
  if (!isIsoDate(delivery_date)) errors.delivery_date = "Enter the delivery date.";
  else if (isIsoDate(invoice_date) && delivery_date < invoice_date) errors.delivery_date = "The delivery date must be on or after the invoice date.";
  const retailer_po_number = str(raw, "retailer_po_number");
  maxLen(errors, "retailer_po_number", retailer_po_number, 100);

  const terms = validateTerms(raw.terms);
  if (!terms.ok) for (const [k, m] of Object.entries(terms.errors)) errors[`terms.${k}`] = m;

  const fee = parseDecimal(raw.delivery_fee ?? "0", { maxDecimals: 2, maxIntegerDigits: 8, min: "zero", label: "the delivery fee" });
  if (!fee.ok) errors.delivery_fee = fee.error;
  const tax_exempt = raw.tax_exempt === true;
  const tax = parseDecimal(tax_exempt ? "0" : raw.tax_rate_percent ?? "0", { maxDecimals: 3, maxIntegerDigits: 3, min: "zero", label: "the tax rate" });
  if (!tax.ok) errors.tax_rate_percent = tax.error;
  else if (tax.value && new Decimal(tax.value).gt(100)) errors.tax_rate_percent = "The tax rate must be 100 or less.";

  const bill_to = address(raw.bill_to, "bill_to", "Bill to", errors, true);
  const ship_to = address(raw.ship_to, "ship_to", "Ship to", errors, false);
  const notes_to_retailer = str(raw, "notes_to_retailer");
  noteField(errors, "notes_to_retailer", notes_to_retailer, 2000);
  const internal_notes = str(raw, "internal_notes");
  noteField(errors, "internal_notes", internal_notes, 2000);

  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  if (rawLines.length < 1) errors.lines = "Add at least one line.";
  if (rawLines.length > MAX_INVOICE_LINES) errors.lines = `An invoice can have at most ${MAX_INVOICE_LINES} lines.`;
  const consignment = terms.ok && terms.value.terms_type === "consignment";
  const lines: InvoiceLineInput[] = rawLines.slice(0, MAX_INVOICE_LINES).map((l, i) => {
    const r = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
    const n = i + 1;
    const product_id = r.product_id === null || r.product_id === undefined || r.product_id === "" ? null : r.product_id;
    if (product_id !== null && !isUuid(product_id)) errors[`lines.${n}.product_id`] = `Line ${n}: unknown product.`;
    const description = str(r, "description") ?? "";
    if (!description) errors[`lines.${n}.description`] = `Line ${n}: description is required.`;
    else if (description.length > 500) errors[`lines.${n}.description`] = `Line ${n}: keep the description under 501 characters.`;
    const q = parseDecimal(r.quantity, { maxDecimals: 3, maxIntegerDigits: 11, min: "positive", label: "the quantity" });
    if (!q.ok || !q.value) errors[`lines.${n}.quantity`] = `Line ${n}: ${q.ok ? "quantity is required" : q.error.toLowerCase().replace(/\.$/, "")}.`;
    const unit = str(r, "unit") ?? "";
    if (!unit) errors[`lines.${n}.unit`] = `Line ${n}: unit is required.`;
    else if (unit.length > 30) errors[`lines.${n}.unit`] = `Line ${n}: keep the unit under 31 characters.`;
    const p = parseDecimal(r.unit_price, { maxDecimals: 4, maxIntegerDigits: 8, min: "zero", label: "the unit price" });
    if (!p.ok || !p.value) errors[`lines.${n}.unit_price`] = `Line ${n}: ${p.ok ? `${consignment ? "retail price" : "unit price"} is required` : p.error.toLowerCase().replace(/\.$/, "")}.`;
    return {
      product_id: product_id as string | null,
      description,
      quantity: q.ok && q.value ? q.value : "",
      unit: INVOICE_UNITS.includes(unit.toLowerCase() as never) ? unit.toLowerCase() : unit,
      unit_price: p.ok && p.value ? p.value : "",
      save_to_price_list: !consignment && product_id !== null && r.save_to_price_list === true,
    };
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      company_profile_id: company_profile_id as string,
      retailer_id: retailer_id as string,
      order_number: (order as { value: string }).value,
      invoice_date: invoice_date as string,
      delivery_date: delivery_date as string,
      retailer_po_number,
      terms: (terms as { value: Terms }).value,
      delivery_fee: (fee.ok && fee.value) || "0",
      tax_exempt,
      tax_rate_percent: (tax.ok && tax.value) || "0",
      bill_to,
      ship_to,
      notes_to_retailer,
      internal_notes,
      refresh_snapshots: raw.refresh_snapshots === true,
      lines,
    },
  };
}
