// The invoice PDF: file names, page layout and rendering (consignment,
// deleted/VOID, many lines). Invented data only.
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { InvoicePdfDocument, breakable, paginateInvoice } from "@/lib/pdf/invoicePdf";
import { computeTotals } from "@/lib/retail/totals";
import { computeDueDate } from "@/lib/retail/dueDate";
import { asciiFilename, invoiceFilename } from "@/lib/retail/snapshots";
import type { InvoiceWithLines } from "@/lib/retail/types";

const company = (over: Partial<InvoiceWithLines["company_snapshot"]> = {}): InvoiceWithLines["company_snapshot"] => ({
  display_name: "BotanIQals",
  legal_name: "KCG Ventures LLC",
  address_line1: "100 Example Street",
  address_line2: "Suite 2",
  city: "Testville",
  state: "DE",
  zip: "19700",
  country: "United States",
  phone: "(555) 010-0100",
  email: "orders@company-a.example.test",
  website: "https://company-a.example.test",
  logo_path: "sample",
  accent_color: "#1a472a",
  invoice_prefix: "KCG-INV",
  payable_to: null,
  remit_line1: "PO Box 100",
  remit_line2: null,
  remit_city: "Testville",
  remit_state: "DE",
  remit_zip: "19700",
  remit_country: "United States",
  payment_instructions: null,
  footer_note: null,
  ...over,
});

const PRODUCTS = ["Product A Toothpaste 4 oz", "Product B Mouth Rinse 8 fl oz", "Product C Breath Drops", "Product D Gum (12-pack)", "Product E Travel Kit"];

function inv(over: Partial<InvoiceWithLines> & { lineCount?: number; longDesc?: boolean } = {}): InvoiceWithLines {
  const n = over.lineCount ?? 3;
  const lines = Array.from({ length: n }, (_, i) => ({
    line_number: i + 1,
    product_id: null,
    description:
      over.longDesc && i % 7 === 3
        ? `${PRODUCTS[i % PRODUCTS.length]} — assorted display carton with shelf talker, tester units and a printed planogram card for the endcap (sample long description that wraps)`
        : PRODUCTS[i % PRODUCTS.length],
    quantity: String(((i % 4) + 1) * (i % 3 === 0 ? 12 : 6) + (i % 5 === 4 ? 0.5 : 0)),
    unit: i % 6 === 5 ? "case" : "each",
    unit_price: String([6.5, 4.25, 0.0245, 12.99, 1250][i % 5]),
    line_total: "0",
  }));
  const termsType = over.terms_type ?? "net";
  const fee = over.delivery_fee ?? "0";
  const taxExempt = over.tax_exempt ?? false;
  const rate = over.tax_rate_percent ?? "0";
  const t = computeTotals(lines, fee, rate, taxExempt);
  lines.forEach((l, i) => (l.line_total = t.lineTotals[i]));
  const base: InvoiceWithLines = {
    id: "sample",
    invoice_number: "KCG-INV-2026-001",
    prefix: "KCG-INV",
    year: 2026,
    sequence: 1,
    order_number: "#2552",
    company_profile_id: "p",
    company_snapshot: company(),
    retailer_id: "r",
    retailer_snapshot: { name: "Retailer A", legal_name: null, contact_name: "Pat Example", contact_email: "buyer@retailer-a.example.test", contact_phone: "(555) 010-0200", billing_line1: "1 Market Way", billing_line2: null, billing_city: "Shopton", billing_state: "PA", billing_zip: "19100", billing_country: "United States", tax_exempt: taxExempt, resale_certificate_number: null },
    bill_to: { name: "Retailer A", contact_name: "Pat Example", line1: "1 Market Way", line2: "", city: "Shopton", state: "PA", zip: "19100", country: "United States", phone: "(555) 010-0200", email: "buyer@retailer-a.example.test" },
    ship_to: { name: "Retailer A (receiving dock)", line1: "1 Market Way, Dock 3", line2: "", city: "Shopton", state: "PA", zip: "19100", country: "United States" },
    invoice_date: "2026-11-15",
    delivery_date: "2026-11-20",
    terms_type: termsType,
    net_days: termsType === "net" ? 30 : null,
    terms_start: "invoice_date",
    consignment_our_share_percent: null,
    consignment_schedule: null,
    consignment_days_to_pay: null,
    consignment_extra_terms: null,
    due_date: null,
    retailer_po_number: null,
    delivery_fee: t.deliveryFee,
    tax_exempt: taxExempt,
    tax_rate_percent: rate,
    subtotal: t.subtotal,
    tax_amount: t.tax,
    total: t.total,
    notes_to_retailer: null,
    internal_notes: "Never printed",
    deleted_at: null,
    last_downloaded_at: null,
    created_at: "",
    updated_at: "",
    created_by_name: "Test Person",
    lines,
  };
  const merged = { ...base, ...over, lines: base.lines, delivery_fee: t.deliveryFee, subtotal: t.subtotal, tax_amount: t.tax, total: t.total } as InvoiceWithLines;
  merged.due_date = computeDueDate(merged.invoice_date, merged.delivery_date, merged.terms_type, merged.net_days, merged.terms_start);
  return merged;
}

const render = async (invoice: InvoiceWithLines) => {
  const buf = await renderToBuffer(React.createElement(InvoicePdfDocument, { invoice, logoDataUri: null }) as never);
  const text = buf.toString("latin1");
  return { buf, pages: (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length };
};

describe("file names", () => {
  it('"{invoice number} - Order {order without #} - {retailer}.pdf", with unsafe characters removed', () => {
    expect(invoiceFilename("KCG-INV-2026-001", "#2552", "Retailer A")).toBe("KCG-INV-2026-001 - Order 2552 - Retailer A.pdf");
    expect(invoiceFilename("KCG-INV-2026-002", "WS-1001/A", 'Retailer "B": Shop*')).toBe("KCG-INV-2026-002 - Order WS-1001A - Retailer B Shop.pdf");
    expect(asciiFilename("KCG-INV-2026-003 - Order 1 - Café A.pdf")).toBe("KCG-INV-2026-003 - Order 1 - Caf A.pdf");
  });
});

describe("long words", () => {
  it("splits words wider than the column, preferring separators, and leaves the rest alone", () => {
    expect(breakable("Order #2552", 200)).toBe("Order #2552");
    const out = breakable("accounts.payable.department@retailer-long-name.example.test", 150);
    expect(out.replace(/\n/g, "")).toBe("accounts.payable.department@retailer-long-name.example.test");
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out.split("\n").every((p) => p.length <= Math.floor(150 / (8.5 * 0.64)))).toBe(true);
    expect(breakable(null, 100)).toBe("");
  });
});

describe("pages", () => {
  it("one page for a short invoice; long invoices continue, and the totals never sit alone", () => {
    expect(paginateInvoice(inv({ lineCount: 1 }))).toHaveLength(1);
    const pages = paginateInvoice(inv({ lineCount: 40, longDesc: true }));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.rows)).toHaveLength(40);
    expect(pages.filter((p) => p.tail)).toHaveLength(1);
    const last = pages[pages.length - 1];
    expect(last.tail).toBe(true);
    expect(last.rows.length).toBeGreaterThan(0);
  });

  it("renders standard, consignment and deleted invoices", async () => {
    const short = await render(inv({ lineCount: 3, tax_rate_percent: "6" }));
    expect(short.buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(short.pages).toBe(1);
    const consignment = await render(
      inv({ lineCount: 3, terms_type: "consignment", net_days: null, consignment_our_share_percent: "70", consignment_schedule: "monthly", consignment_days_to_pay: 15 }),
    );
    expect(consignment.pages).toBe(1);
    const long = await render(inv({ lineCount: 40, longDesc: true, deleted_at: "2026-11-16T12:00:00Z" }));
    expect(long.pages).toBe(paginateInvoice(inv({ lineCount: 40, longDesc: true })).length);
  }, 60_000);
});
