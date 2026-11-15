/**
 * The retail invoice PDF (@react-pdf/renderer, server-side only: Node
 * runtime, fonts and logo read from disk/storage, no network). One component
 * serves the in-app preview, the view page and the download. It renders
 * from the invoice's OWN snapshots, so a reprint matches what was sent.
 *
 * Same page size, margins, Inter fonts (kerning off, see the PO PDF for the
 * "7." glyph issue), accent color and contrast helper as the Purchase Order
 * PDF. Like the PO, the line table is paginated MANUALLY (paginateInvoice):
 * each page is rendered explicitly with its own table header row, so the
 * header repeats and a row is never split across pages; the totals, payment
 * box and notes are kept on the same page as the last rows, so they are
 * never alone on a page.
 */
import React from "react";
import { Document, Font, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import path from "path";
import { mixWithWhite, pickReadableTextColor } from "@/lib/colorContrast";
import { formatLongDate, formatMoney, formatPercent, formatQuantity, formatUnitPrice, toDecimal } from "@/lib/retail/format";
import { consignmentTermsText, termsLabel } from "@/lib/retail/terms";
import type { Address, InvoiceLine, InvoiceWithLines } from "@/lib/retail/types";

// ---- Fonts (local files, no CDN) ----------------------------------------------
let fontsRegistered = false;
export function registerInvoiceFonts() {
  if (fontsRegistered) return;
  const dir = path.join(process.cwd(), "src/fonts/inter");
  Font.register({
    family: "Inter",
    fonts: [
      { src: path.join(dir, "Inter-Regular.ttf"), fontWeight: 400 },
      { src: path.join(dir, "Inter-Medium.ttf"), fontWeight: 500 },
      { src: path.join(dir, "Inter-SemiBold.ttf"), fontWeight: 600 },
      { src: path.join(dir, "Inter-Bold.ttf"), fontWeight: 700 },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

// ---- Layout --------------------------------------------------------------------------
const PAGE = { width: 612, height: 792 };
const MARGIN = { top: 36, bottom: 54, left: 40, right: 40 };
const W = PAGE.width - MARGIN.left - MARGIN.right; // 532
const H = PAGE.height - MARGIN.top - MARGIN.bottom; // 702

const COLS = { qty: W * 0.1, unit: W * 0.1, description: W * 0.42, price: W * 0.18, amount: W * 0.2 };
const INK = "#18181b";
const MUTED = "#3f3f46";
const HAIRLINE = "#d4d4d8";

const ROW_FONT = 8;
const ROW_LINE = 10.5; // Inter natural line height is about 1.21 x font size; estimate a little high
const ROW_PAD = 8;
const AVG_CHAR = 0.55; // conservative average glyph width for Inter, x font size
const TABLE_HEADER = 20;
const CONT_HEADER = 40;

function wrapLines(text: string, width: number, fontSize: number): number {
  const perLine = Math.max(4, Math.floor(width / (fontSize * AVG_CHAR)));
  return (text || "")
    .split("\n")
    .reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

function rowHeight(l: InvoiceLine): number {
  const lines = Math.max(wrapLines(l.description, COLS.description - 10, ROW_FONT), wrapLines(String(l.unit ?? ""), COLS.unit - 10, ROW_FONT), 1);
  return lines * ROW_LINE + ROW_PAD;
}

const isConsignment = (inv: InvoiceWithLines) => inv.terms_type === "consignment";
const addressLines = (a: Partial<Address> | null | undefined): string[] => {
  if (!a) return [];
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.line1, a.line2, cityLine, a.country].filter((x): x is string => !!x && x.trim() !== "");
};

function companyAddress(inv: InvoiceWithLines): string[] {
  const c = inv.company_snapshot;
  return addressLines({ line1: c.address_line1 ?? "", line2: c.address_line2 ?? "", city: c.city ?? "", state: c.state ?? "", zip: c.zip ?? "", country: c.country ?? "" });
}

function headerHeight(inv: InvoiceWithLines): number {
  const right = 27 + (isConsignment(inv) ? 12 : 0) + 18 + wrapLines(`Order ${inv.order_number}`, 220, 9) * 12 + 12 + (inv.retailer_po_number ? 12 : 0);
  const c = inv.company_snapshot;
  const left = 52 + (c.legal_name && c.legal_name !== c.display_name ? 12 : 0) + 14;
  return Math.max(right, left) + 14; // + rule and gap
}

const ADDRESS_COL = (W - 24) / 3;
function addressBlockHeight(inv: InvoiceWithLines): number {
  const c = inv.company_snapshot;
  const from = [c.display_name, ...companyAddress(inv), c.phone, c.email, c.website].filter(Boolean) as string[];
  const b = inv.bill_to;
  const bill = [b.name, b.contact_name, ...addressLines(b), b.phone, b.email].filter(Boolean) as string[];
  const ship = [inv.ship_to.name, ...addressLines(inv.ship_to)].filter(Boolean) as string[];
  const count = (ls: string[]) => ls.reduce((n, l) => n + wrapLines(l, ADDRESS_COL - 4, 8.5), 0);
  return 18 + Math.max(count(from), count(bill), count(ship)) * 11.5 + 12;
}

const DETAILS_HEIGHT = 46;

function totalsRows(inv: InvoiceWithLines): [string, string][] {
  const rows: [string, string][] = [["Subtotal", formatMoney(inv.subtotal)]];
  if ((toDecimal(inv.delivery_fee)?.gt(0)) ?? false) rows.push(["Delivery fee", formatMoney(inv.delivery_fee)]);
  if (inv.tax_exempt) rows.push(["Tax exempt (resale)", formatMoney(0)]);
  else if ((toDecimal(inv.tax_rate_percent)?.gt(0)) ?? false) rows.push([`Tax (${formatPercent(inv.tax_rate_percent)}%)`, formatMoney(inv.tax_amount)]);
  return rows;
}

function paymentLeftLines(inv: InvoiceWithLines): string[] {
  if (isConsignment(inv)) {
    return ["No payment is due on delivery.", ...consignmentTermsText(inv, inv.company_snapshot.legal_name)];
  }
  return [`Payment Due: ${dueText(inv, true)}`];
}

function remitLines(inv: InvoiceWithLines): string[] {
  const c = inv.company_snapshot;
  return addressLines({ line1: c.remit_line1 ?? "", line2: c.remit_line2 ?? "", city: c.remit_city ?? "", state: c.remit_state ?? "", zip: c.remit_zip ?? "", country: c.remit_country ?? "" });
}

function tailHeight(inv: InvoiceWithLines): number {
  const totals = 10 + totalsRows(inv).length * 15 + 26;
  const leftW = W * 0.58 - 20;
  const rightW = W * 0.42 - 20;
  const left = 14 + paymentLeftLines(inv).reduce((n, l) => n + wrapLines(l, leftW, 8.5), 0) * 11.5;
  const right = (remitLines(inv).length ? 14 + remitLines(inv).length * 11.5 : 0) + 14 + wrapLines(payableTo(inv), rightW, 8.5) * 11.5;
  const instructions = inv.company_snapshot.payment_instructions ? 10 + wrapLines(inv.company_snapshot.payment_instructions, W - 24, 8) * 10.5 : 0;
  const payment = 22 + Math.max(left, right) + instructions;
  const notes = inv.notes_to_retailer ? 30 + wrapLines(inv.notes_to_retailer, W - 24, 8.5) * 11.5 : 0;
  return totals + 12 + payment + (notes ? 10 + notes : 0) + 6;
}

export type InvoicePageLayout = { first: boolean; rows: InvoiceLine[]; tail: boolean };

/**
 * Splits the lines into pages. Page 1 holds the header, addresses and
 * details strip; later pages a short continuation header. Every page has
 * the table header row. The totals, payment box and notes (the tail) go on
 * the page with the last rows; if they don't fit, rows move to a new page
 * with them, so the tail is never alone. Heights are estimated
 * conservatively from text length (Inter at these sizes).
 */
export function paginateInvoice(inv: InvoiceWithLines): InvoicePageLayout[] {
  const firstBudget = H - headerHeight(inv) - addressBlockHeight(inv) - DETAILS_HEIGHT - TABLE_HEADER - 8;
  const contBudget = H - CONT_HEADER - TABLE_HEADER - 8;
  const tail = tailHeight(inv);
  const pages: { rows: InvoiceLine[]; used: number; budget: number }[] = [{ rows: [], used: 0, budget: firstBudget }];
  for (const line of inv.lines) {
    const h = rowHeight(line);
    let p = pages[pages.length - 1];
    if (p.rows.length > 0 && p.used + h > p.budget) {
      p = { rows: [], used: 0, budget: contBudget };
      pages.push(p);
    }
    p.rows.push(line);
    p.used += h;
  }
  // Keep the tail with the last rows: if it doesn't fit, the last row moves
  // to a new page with it (one row is enough to never leave it alone).
  const last = pages[pages.length - 1];
  if (last.used + tail > last.budget) {
    const r = last.rows.pop();
    if (r) {
      const h = rowHeight(r);
      last.used -= h;
      if (last.rows.length === 0 && pages.length > 1) pages.pop();
      pages.push({ rows: [r], used: h, budget: contBudget });
    }
  }
  return pages.map((p, i) => ({ first: i === 0, rows: p.rows, tail: i === pages.length - 1 }));
}

// ---- Text helpers -------------------------------------------------------------------------
/**
 * Long unbroken words (emails, web addresses, long order or PO numbers)
 * would run past their column, because hyphenation is off. Any word wider
 * than the column is split into pieces that fit (preferring to split after
 * "@", ".", "/", "-" or "_"), joined with line breaks. Nothing visible is
 * added. Widths use a conservative average glyph width for Inter.
 */
export function breakable(text: string | null | undefined, width: number, fontSize = 8.5): string {
  const max = Math.max(4, Math.floor(width / (fontSize * 0.64)));
  return (text ?? "").replace(/\S+/g, (word) => {
    if (word.length <= max) return word;
    const pieces: string[] = [];
    let rest = word;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      const cut = Math.max(window.lastIndexOf("@"), window.lastIndexOf("."), window.lastIndexOf("/"), window.lastIndexOf("-"), window.lastIndexOf("_"));
      const at = cut >= Math.floor(max / 2) ? cut + 1 : max;
      pieces.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    pieces.push(rest);
    return pieces.join("\n");
  });
}

/** Due date text: "December 15, 2026"; prepaid is due before delivery; consignment has none. */
function dueText(inv: InvoiceWithLines, long: boolean): string {
  if (inv.terms_type === "consignment") return "Not applicable";
  const date = formatLongDate(inv.due_date);
  if (inv.terms_type === "prepaid") return long ? `Before delivery (${date})` : "Before delivery";
  return date;
}
const payableTo = (inv: InvoiceWithLines) => `Payable to: ${inv.company_snapshot.payable_to?.trim() || inv.company_snapshot.legal_name}`;

// ---- Styles -------------------------------------------------------------------------------------
const styles = StyleSheet.create({
  page: {
    paddingTop: MARGIN.top,
    paddingBottom: MARGIN.bottom,
    paddingLeft: MARGIN.left,
    paddingRight: MARGIN.right,
    fontFamily: "Inter",
    fontSize: 8.5,
    color: INK,
    fontFeatureSettings: { kern: false },
  },
  label: { fontSize: 7, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" },
});

type Palette = { accent: string; onAccent: string; tint: string; soft: string };
function palette(accent: string): Palette {
  const valid = /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#1a472a";
  return { accent: valid, onAccent: pickReadableTextColor(valid), tint: mixWithWhite(valid, 0.07), soft: mixWithWhite(valid, 0.04) };
}
/** Accent-colored text on white must stay readable: very light accents fall back to near-black. */
function accentText(p: Palette): string {
  return pickReadableTextColor(p.accent) === "#ffffff" ? p.accent : INK;
}

// ---- Pieces ----------------------------------------------------------------------------------------
function Header({ inv, logo, p }: { inv: InvoiceWithLines; logo: string | null; p: Palette }) {
  const c = inv.company_snapshot;
  const showLegal = !!c.legal_name && c.legal_name !== c.display_name;
  const accentInk = accentText(p);
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ width: W - 240, paddingRight: 12 }}>
          {logo ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={logo} style={{ height: 48, maxWidth: 170, objectFit: "contain", marginBottom: 6, alignSelf: "flex-start" }} />
          ) : (
            <Text style={{ fontSize: 16, fontWeight: 700, color: accentInk, marginBottom: 4 }}>{c.display_name}</Text>
          )}
          {logo ? <Text style={{ fontSize: 10, fontWeight: 700 }}>{c.display_name}</Text> : null}
          {showLegal ? <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 1 }}>{c.legal_name}</Text> : null}
        </View>
        <View style={{ width: 240, alignItems: "flex-end" }}>
          <Text style={{ fontSize: 22, fontWeight: 700, color: accentInk, letterSpacing: 1.5 }}>INVOICE</Text>
          {isConsignment(inv) ? (
            <Text style={{ ...styles.label, color: accentInk, marginTop: 1, letterSpacing: 2 }}>Consignment</Text>
          ) : null}
          <Text style={{ fontSize: 14, fontWeight: 700, marginTop: 5, textAlign: "right" }}>{inv.invoice_number}</Text>
          <Text style={{ fontSize: 9, fontWeight: 600, marginTop: 2, textAlign: "right", maxWidth: 240 }}>Order {breakable(inv.order_number, 234, 9)}</Text>
          <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 2 }}>{formatLongDate(inv.invoice_date)}</Text>
          {inv.retailer_po_number ? <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 1, textAlign: "right", maxWidth: 240 }}>Retailer PO {breakable(inv.retailer_po_number, 234)}</Text> : null}
        </View>
      </View>
      <View style={{ height: 2, backgroundColor: p.accent, marginTop: 10, marginBottom: 12 }} />
    </View>
  );
}

function ContinuationHeader({ inv, p }: { inv: InvoiceWithLines; p: Palette }) {
  return (
    <View style={{ height: CONT_HEADER - 8, marginBottom: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
        <Text style={{ fontSize: 10, fontWeight: 700, maxWidth: W - 250 }}>{inv.company_snapshot.display_name}</Text>
        <Text style={{ fontSize: 8.5, fontWeight: 600, maxWidth: 250, textAlign: "right" }}>
          Invoice {inv.invoice_number} · Order {breakable(inv.order_number, 200)} (continued)
        </Text>
      </View>
      <View style={{ height: 1, backgroundColor: p.accent, marginTop: 6 }} />
    </View>
  );
}

function AddressColumn({ label, lines, bold, p }: { label: string; lines: string[]; bold: string; p: Palette }) {
  return (
    <View style={{ width: ADDRESS_COL }}>
      <Text style={{ ...styles.label, color: accentText(p) }}>{label}</Text>
      <View style={{ height: 0.75, backgroundColor: HAIRLINE, marginTop: 3, marginBottom: 5 }} />
      <Text style={{ fontWeight: 600 }}>{breakable(bold, ADDRESS_COL - 2)}</Text>
      {lines.map((l, i) => (
        <Text key={i} style={{ color: MUTED }}>
          {breakable(l, ADDRESS_COL - 2)}
        </Text>
      ))}
    </View>
  );
}

function Addresses({ inv, p }: { inv: InvoiceWithLines; p: Palette }) {
  const c = inv.company_snapshot;
  const b = inv.bill_to;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
      <AddressColumn label="From" bold={c.display_name} lines={[...companyAddress(inv), c.phone ?? "", c.email ?? "", c.website ?? ""].filter(Boolean)} p={p} />
      <AddressColumn label="Bill to" bold={b.name} lines={[b.contact_name ? `Attn: ${b.contact_name}` : "", ...addressLines(b), b.phone ?? "", b.email ?? ""].filter(Boolean)} p={p} />
      <AddressColumn label="Ship to" bold={inv.ship_to.name} lines={addressLines(inv.ship_to)} p={p} />
    </View>
  );
}

function DetailsStrip({ inv, p }: { inv: InvoiceWithLines; p: Palette }) {
  const cells: [string, string][] = [
    ["Invoice Date", formatLongDate(inv.invoice_date)],
    ["Delivery Date", formatLongDate(inv.delivery_date)],
    ["Payment Terms", inv.terms_type === "prepaid" ? "Prepaid" : termsLabel(inv)],
    ["Due Date", dueText(inv, false)],
  ];
  if (inv.retailer_po_number) cells.push(["Retailer PO #", inv.retailer_po_number]);
  return (
    <View style={{ flexDirection: "row", borderWidth: 0.75, borderColor: HAIRLINE, borderRadius: 2, marginBottom: 12, minHeight: DETAILS_HEIGHT - 12 }}>
      {cells.map(([k, v], i) => (
        <View key={k} style={{ flex: 1, paddingVertical: 6, paddingHorizontal: 8, borderLeftWidth: i === 0 ? 0 : 0.75, borderLeftColor: HAIRLINE, backgroundColor: i % 2 === 0 ? p.soft : "#ffffff" }}>
          <Text style={{ ...styles.label, fontSize: 6.5, color: MUTED }}>{k}</Text>
          <Text style={{ fontSize: 8.5, fontWeight: 600, marginTop: 3 }}>{breakable(v, W / cells.length - 18)}</Text>
        </View>
      ))}
    </View>
  );
}

const cell = { paddingVertical: 4, paddingHorizontal: 5 } as const;

function TableHeaderRow({ inv, p }: { inv: InvoiceWithLines; p: Palette }) {
  const t = { fontSize: 7.5, fontWeight: 700, color: p.onAccent, letterSpacing: 0.6, textTransform: "uppercase" } as const;
  const c = isConsignment(inv);
  return (
    <View style={{ flexDirection: "row", backgroundColor: p.accent, minHeight: TABLE_HEADER, alignItems: "center" }} wrap={false}>
      <Text style={{ ...t, ...cell, width: COLS.qty, textAlign: "right" }}>Qty</Text>
      <Text style={{ ...t, ...cell, width: COLS.unit }}>Unit</Text>
      <Text style={{ ...t, ...cell, width: COLS.description }}>Description</Text>
      <Text style={{ ...t, ...cell, width: COLS.price, textAlign: "right" }}>{c ? "Retail Price" : "Unit Price"}</Text>
      <Text style={{ ...t, ...cell, width: COLS.amount, textAlign: "right" }}>{c ? "Retail Value" : "Amount"}</Text>
    </View>
  );
}

function TableRow({ line, zebra, p }: { line: InvoiceLine; zebra: boolean; p: Palette }) {
  const t = { fontSize: ROW_FONT } as const;
  return (
    <View style={{ flexDirection: "row", backgroundColor: zebra ? p.tint : "#ffffff", borderBottomWidth: 0.5, borderBottomColor: "#ececee" }} wrap={false}>
      <Text style={{ ...t, ...cell, width: COLS.qty, textAlign: "right" }}>{formatQuantity(line.quantity)}</Text>
      <Text style={{ ...t, ...cell, width: COLS.unit }}>{breakable(line.unit, COLS.unit - 10, ROW_FONT)}</Text>
      <Text style={{ ...t, ...cell, width: COLS.description }}>{breakable(line.description, COLS.description - 10, ROW_FONT)}</Text>
      <Text style={{ ...t, ...cell, width: COLS.price, textAlign: "right" }}>{formatUnitPrice(line.unit_price)}</Text>
      <Text style={{ ...t, ...cell, width: COLS.amount, textAlign: "right", fontWeight: 600 }}>{formatMoney(line.line_total)}</Text>
    </View>
  );
}

function Totals({ inv, p }: { inv: InvoiceWithLines; p: Palette }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 10 }} wrap={false}>
      <View style={{ width: W * 0.42 }}>
        {totalsRows(inv).map(([k, v]) => (
          <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, paddingHorizontal: 8, borderBottomWidth: 0.5, borderBottomColor: "#ececee" }}>
            <Text style={{ color: MUTED }}>{k}</Text>
            <Text>{v}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: p.accent, paddingVertical: 6, paddingHorizontal: 8, marginTop: 4 }}>
          <Text style={{ fontSize: isConsignment(inv) ? 7.5 : 9, fontWeight: 700, color: p.onAccent, letterSpacing: 0.4 }}>
            {isConsignment(inv) ? "TOTAL CONSIGNED VALUE (RETAIL)" : "TOTAL (USD)"}
          </Text>
          <Text style={{ fontSize: 11, fontWeight: 700, color: p.onAccent }}>{formatMoney(inv.total)}</Text>
        </View>
      </View>
    </View>
  );
}

function PaymentBox({ inv, p }: { inv: InvoiceWithLines; p: Palette }) {
  const remit = remitLines(inv);
  const left = paymentLeftLines(inv);
  return (
    <View style={{ marginTop: 12, borderWidth: 0.75, borderColor: HAIRLINE, backgroundColor: p.soft, padding: 10, borderRadius: 2 }} wrap={false}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <View style={{ width: W * 0.58 - 20, paddingRight: 10 }}>
          <Text style={{ fontWeight: 700 }}>Payment Terms: {inv.terms_type === "prepaid" ? "Prepaid (payment due before delivery)" : termsLabel(inv)}</Text>
          {left.map((l, i) => (
            <Text key={i} style={{ marginTop: 3, fontWeight: i === 0 && isConsignment(inv) ? 600 : 400 }}>
              {l}
            </Text>
          ))}
        </View>
        <View style={{ width: W * 0.42 - 20 }}>
          {remit.length > 0 ? (
            <View style={{ marginBottom: 4 }}>
              <Text style={{ fontWeight: 700 }}>Mail checks to:</Text>
              {remit.map((l, i) => (
                <Text key={i} style={{ color: MUTED }}>
                  {breakable(l, W * 0.42 - 22)}
                </Text>
              ))}
            </View>
          ) : null}
          <Text style={{ fontWeight: 600 }}>{breakable(payableTo(inv), W * 0.42 - 22)}</Text>
        </View>
      </View>
      {inv.company_snapshot.payment_instructions ? (
        <View style={{ marginTop: 8, borderTopWidth: 0.5, borderTopColor: HAIRLINE, paddingTop: 6 }}>
          <Text style={{ fontSize: 8 }}>{breakable(inv.company_snapshot.payment_instructions, W - 24, 8)}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Notes({ inv, p }: { inv: InvoiceWithLines; p: Palette }) {
  if (!inv.notes_to_retailer) return null;
  return (
    <View style={{ marginTop: 10, borderWidth: 0.75, borderColor: HAIRLINE, padding: 10, borderRadius: 2 }} wrap={false}>
      <Text style={{ ...styles.label, color: accentText(p), marginBottom: 4 }}>Notes</Text>
      <Text>{breakable(inv.notes_to_retailer, W - 24)}</Text>
    </View>
  );
}

function Footer({ inv }: { inv: InvoiceWithLines }) {
  const c = inv.company_snapshot;
  return (
    <View fixed style={{ position: "absolute", left: MARGIN.left, right: MARGIN.right, bottom: 18 }}>
      <View style={{ height: 0.5, backgroundColor: HAIRLINE, marginBottom: 4 }} />
      <View style={{ flexDirection: "row", justifyContent: "space-between", fontSize: 6.5, color: MUTED }}>
        <Text style={{ width: W * 0.4 }}>
          {c.legal_name} · {inv.invoice_number} · Order {breakable(inv.order_number, W * 0.4, 6.5)}
        </Text>
        <Text style={{ width: W * 0.42, textAlign: "center" }}>{c.email ? breakable(`Questions about this invoice? Contact ${c.email}`, W * 0.42, 6.5) : ""}</Text>
        <Text style={{ width: W * 0.18, textAlign: "right" }} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </View>
      {c.footer_note ? <Text style={{ fontSize: 6.5, color: MUTED, marginTop: 2, textAlign: "center" }}>{c.footer_note}</Text> : null}
    </View>
  );
}

function VoidMark() {
  return (
    <View fixed style={{ position: "absolute", top: 0, left: 0, width: PAGE.width, height: PAGE.height, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: 150, fontWeight: 700, color: "#dc2626", opacity: 0.13, transform: "rotate(-35deg)", letterSpacing: 10 }}>VOID</Text>
    </View>
  );
}

/** The invoice document. logoDataUri is the business logo read on the server (or null). */
export function InvoicePdfDocument({ invoice, logoDataUri }: { invoice: InvoiceWithLines; logoDataUri: string | null }) {
  registerInvoiceFonts();
  const p = palette(invoice.company_snapshot.accent_color);
  const pages = paginateInvoice(invoice);
  let rowIndex = 0;
  return (
    <Document title={`${invoice.invoice_number} - Order ${invoice.order_number}`} author={invoice.company_snapshot.legal_name} subject="Invoice" creator="KCG Ventures ERP" producer="KCG Ventures ERP">
      {pages.map((pg, i) => (
        <Page key={i} size="LETTER" style={styles.page} wrap>
          {pg.first ? (
            <>
              <Header inv={invoice} logo={logoDataUri} p={p} />
              <Addresses inv={invoice} p={p} />
              <DetailsStrip inv={invoice} p={p} />
            </>
          ) : (
            <ContinuationHeader inv={invoice} p={p} />
          )}
          {pg.rows.length > 0 ? <TableHeaderRow inv={invoice} p={p} /> : null}
          {pg.rows.map((line) => {
            const z = rowIndex++ % 2 === 1;
            return <TableRow key={`${line.line_number}-${rowIndex}`} line={line} zebra={z} p={p} />;
          })}
          {pg.tail ? (
            <View wrap={false}>
              <Totals inv={invoice} p={p} />
              <PaymentBox inv={invoice} p={p} />
              <Notes inv={invoice} p={p} />
            </View>
          ) : null}
          <Footer inv={invoice} />
          {invoice.deleted_at ? <VoidMark /> : null}
        </Page>
      ))}
    </Document>
  );
}
