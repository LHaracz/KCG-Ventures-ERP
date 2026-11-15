/**
 * Invoice snapshots and small invoice helpers. Pure (tested). An invoice
 * keeps the business letterhead and retailer details as they were when it
 * was created, unless the user asks to refresh them on edit.
 */
import { orderNumberForFilename } from "./orderNumber";
import type { Address, Business, CompanySnapshot, Invoice, InvoiceSettings, Retailer, RetailerSnapshot } from "./types";

export function buildCompanySnapshot(b: Business, s: InvoiceSettings | null): CompanySnapshot {
  return {
    display_name: b.display_name,
    legal_name: b.legal_name,
    address_line1: b.address_line1,
    address_line2: b.address_line2,
    city: b.city,
    state: b.state,
    zip: b.zip,
    country: b.country,
    phone: b.phone,
    email: b.email,
    website: b.website,
    logo_path: b.logo_path,
    accent_color: b.accent_color,
    invoice_prefix: s?.invoice_prefix ?? "KCG-INV",
    payable_to: s?.payable_to ?? null,
    remit_line1: s?.remit_line1 ?? null,
    remit_line2: s?.remit_line2 ?? null,
    remit_city: s?.remit_city ?? null,
    remit_state: s?.remit_state ?? null,
    remit_zip: s?.remit_zip ?? null,
    remit_country: s?.remit_country ?? null,
    payment_instructions: s?.payment_instructions ?? null,
    footer_note: s?.footer_note ?? null,
  };
}

export function buildRetailerSnapshot(r: Retailer): RetailerSnapshot {
  return {
    name: r.name,
    legal_name: r.legal_name,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    contact_phone: r.contact_phone,
    billing_line1: r.billing_line1,
    billing_line2: r.billing_line2,
    billing_city: r.billing_city,
    billing_state: r.billing_state,
    billing_zip: r.billing_zip,
    billing_country: r.billing_country,
    tax_exempt: r.tax_exempt,
    resale_certificate_number: r.resale_certificate_number,
  };
}

const s = (v: string | null | undefined) => v ?? "";

export function billToFromRetailer(r: Retailer): Address {
  return {
    name: r.legal_name || r.name,
    contact_name: s(r.contact_name),
    line1: s(r.billing_line1),
    line2: s(r.billing_line2),
    city: s(r.billing_city),
    state: s(r.billing_state),
    zip: s(r.billing_zip),
    country: s(r.billing_country),
    phone: s(r.contact_phone),
    email: s(r.contact_email),
  };
}

export function shipToFromRetailer(r: Retailer): Address {
  if (r.shipping_same_as_billing) {
    return { name: r.name, line1: s(r.billing_line1), line2: s(r.billing_line2), city: s(r.billing_city), state: s(r.billing_state), zip: s(r.billing_zip), country: s(r.billing_country) };
  }
  return {
    name: r.shipping_name || r.name,
    line1: s(r.shipping_line1),
    line2: s(r.shipping_line2),
    city: s(r.shipping_city),
    state: s(r.shipping_state),
    zip: s(r.shipping_zip),
    country: s(r.shipping_country),
  };
}

/** Removes characters that are unsafe in file names (and quotes), and tidies spaces. */
export function safeFilenamePart(v: string): string {
  return v
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/[^\p{L}\p{N} .,'&()_-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

/** "KCG-INV-2026-001 - Order 2552 - Retailer A.pdf" */
export function invoiceFilename(invoiceNumber: string, orderNumber: string, retailerName: string): string {
  const parts = [safeFilenamePart(invoiceNumber), `Order ${safeFilenamePart(orderNumberForFilename(orderNumber))}`, safeFilenamePart(retailerName)].filter(
    (p) => p && p !== "Order ",
  );
  return `${parts.join(" - ")}.pdf`;
}

/** ASCII fallback for the Content-Disposition filename (the UTF-8 name goes in filename*). */
export const asciiFilename = (name: string) => name.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "");

/** True when the invoice changed after it was last downloaded, or was never downloaded. */
export function editedSinceDownload(inv: Pick<Invoice, "updated_at" | "last_downloaded_at">): boolean {
  if (!inv.last_downloaded_at) return true;
  return new Date(inv.updated_at).getTime() > new Date(inv.last_downloaded_at).getTime();
}
