/**
 * Input checks for suppliers and supplier links. The same rules run in the
 * browser (to show errors next to fields) and in the server routes (the
 * input is never trusted). The database enforces them again with CHECK
 * constraints (procurement_suppliers.sql).
 */
import { COA_POLICY_VALUES, PAYMENT_METHOD_VALUES, SUPPLIER_PAYMENT_TERMS } from "./types";

export const LIMITS = { name: 200, url: 2000, email: 254, phone: 50, account: 100, notes: 2000, address: 200, short: 200 } as const;

export type SupplierValues = {
  name: string;
  website_url: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  account_number: string | null;
  payment_methods: string[];
  payment_notes: string | null;
  ordering_notes: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  default_po_payment_terms: string | null;
};

export type LinkValues = {
  product_url: string | null;
  supplier_item: string | null;
  pack_info: string | null;
  coa_policy: string;
  notes: string | null;
};

export type Errors = Record<string, string>;
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: Errors };

export const SUPPLIER_TEXT_FIELDS = [
  "name", "website_url", "contact_name", "contact_email", "contact_phone", "account_number", "payment_notes",
  "ordering_notes", "address_line1", "address_line2", "city", "state", "zip", "country", "default_po_payment_terms",
] as const;

export const EMPTY_SUPPLIER: SupplierValues = {
  name: "", website_url: null, contact_name: null, contact_email: null, contact_phone: null, account_number: null,
  payment_methods: [], payment_notes: null, ordering_notes: null, address_line1: null, address_line2: null, city: null,
  state: null, zip: null, country: null, default_po_payment_terms: null,
};
export const EMPTY_LINK: LinkValues = { product_url: null, supplier_item: null, pack_info: null, coa_policy: "unknown", notes: null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** http(s) only, no spaces, at most 2000 characters. */
export function isHttpUrl(v: string): boolean {
  if (v.length > LIMITS.url || !/^https?:\/\/[^\s]+$/i.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

export const isEmail = (v: string) => v.length <= LIMITS.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** A 13-19 digit number (spaces or dashes allowed) that passes the Luhn check. */
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

function text(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function noteCheck(errors: Errors, key: string, v: string | null) {
  if (!v) return;
  if (v.length > LIMITS.notes) errors[key] = `Keep this under ${LIMITS.notes} characters.`;
  else if (looksLikeCardNumber(v)) errors[key] = "This looks like a card number. Do not store card numbers here.";
}

export function validateSupplier(input: unknown): Checked<SupplierValues> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Errors = {};
  const name = text(raw, "name");
  if (!name) errors.name = "Supplier name is required.";
  else if (name.length > LIMITS.name) errors.name = `Keep the name under ${LIMITS.name} characters.`;

  const website_url = text(raw, "website_url");
  if (website_url && !isHttpUrl(website_url)) errors.website_url = "Enter a full web address starting with http:// or https://.";

  const contact_email = text(raw, "contact_email");
  if (contact_email && !isEmail(contact_email)) errors.contact_email = "Enter a valid email address.";

  const contact_name = text(raw, "contact_name");
  if (contact_name && contact_name.length > LIMITS.short) errors.contact_name = `Keep this under ${LIMITS.short} characters.`;
  const contact_phone = text(raw, "contact_phone");
  if (contact_phone && contact_phone.length > LIMITS.phone) errors.contact_phone = `Keep this under ${LIMITS.phone} characters.`;
  const account_number = text(raw, "account_number");
  if (account_number && account_number.length > LIMITS.account) errors.account_number = `Keep this under ${LIMITS.account} characters.`;

  let payment_methods: string[] = [];
  if (raw.payment_methods !== undefined && raw.payment_methods !== null) {
    if (!Array.isArray(raw.payment_methods) || raw.payment_methods.some((m) => typeof m !== "string" || !PAYMENT_METHOD_VALUES.includes(m))) {
      errors.payment_methods = "Choose payment methods from the list.";
    } else {
      payment_methods = PAYMENT_METHOD_VALUES.filter((m) => (raw.payment_methods as string[]).includes(m));
    }
  }

  const payment_notes = text(raw, "payment_notes");
  noteCheck(errors, "payment_notes", payment_notes);
  const ordering_notes = text(raw, "ordering_notes");
  noteCheck(errors, "ordering_notes", ordering_notes);

  const address: Record<string, string | null> = {};
  for (const k of ["address_line1", "address_line2", "city", "state", "zip", "country"]) {
    const v = text(raw, k);
    if (v && v.length > LIMITS.address) errors[k] = `Keep this under ${LIMITS.address} characters.`;
    address[k] = v;
  }

  const default_po_payment_terms = text(raw, "default_po_payment_terms");
  if (default_po_payment_terms && !SUPPLIER_PAYMENT_TERMS.includes(default_po_payment_terms)) {
    errors.default_po_payment_terms = "Choose payment terms from the list.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name!,
      website_url,
      contact_name,
      contact_email,
      contact_phone,
      account_number,
      payment_methods,
      payment_notes,
      ordering_notes,
      address_line1: address.address_line1,
      address_line2: address.address_line2,
      city: address.city,
      state: address.state,
      zip: address.zip,
      country: address.country,
      default_po_payment_terms,
    },
  };
}

export function validateLink(input: unknown): Checked<LinkValues> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Errors = {};
  const product_url = text(raw, "product_url");
  if (product_url && !isHttpUrl(product_url)) errors.product_url = "Enter a full product link starting with http:// or https://.";
  const supplier_item = text(raw, "supplier_item");
  if (supplier_item && supplier_item.length > LIMITS.short) errors.supplier_item = `Keep this under ${LIMITS.short} characters.`;
  const pack_info = text(raw, "pack_info");
  if (pack_info && pack_info.length > LIMITS.short) errors.pack_info = `Keep this under ${LIMITS.short} characters.`;
  const coa = text(raw, "coa_policy") ?? "unknown";
  if (!COA_POLICY_VALUES.includes(coa)) errors.coa_policy = "Choose a COA policy from the list.";
  const notes = text(raw, "notes");
  noteCheck(errors, "notes", notes);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { product_url, supplier_item, pack_info, coa_policy: coa, notes } };
}
