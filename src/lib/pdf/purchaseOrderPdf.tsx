/**
 * The Purchase Order PDF — built with @react-pdf/renderer, server-side only
 * (Node runtime; see the download route). Renders from the PO's OWN
 * company_snapshot (the letterhead as it was when the PO was created or
 * last refreshed), never from the live company_profiles row, so a reprint
 * always matches what the vendor originally received.
 *
 * Pagination: react-pdf's automatic flow pagination doesn't have a clean
 * way to repeat a table header at the correct position on every page when
 * variable-height content (the address blocks) precedes the table on page
 * 1 only — a `fixed` element repeats at the position it first renders at,
 * which is wrong for continuation pages. So the line items table is
 * chunked MANUALLY here: chunkLines() decides exactly which rows go on
 * which page using a character-based height estimate (Inter at the sizes
 * below averages ~0.52×fontSize per character), and each resulting page is
 * rendered explicitly with its own copy of the repeating header/footer and
 * the table header row. This guarantees the header repeats and a row is
 * NEVER split across a page, by construction rather than by hoping
 * react-pdf's `fixed`/`wrap` heuristics land right.
 *
 * Totals/special instructions/terms/authorization have no repeating-header
 * requirement, so that section is one ordinary <Page> and is left to
 * react-pdf's native (well-tested) text-flow pagination — terms text can
 * be long enough to need more than one page on its own, and react-pdf
 * handles that natively without any manual chunking from us.
 */
import React from "react";
import { Document, Page, View, Text, Image, Font, StyleSheet } from "@react-pdf/renderer";
import path from "path";
import type { PurchaseOrderWithLines, PoLine } from "@/lib/purchaseOrders";

// ---- Fonts (local files, no CDN) -------------------------------------
let fontsRegistered = false;
function registerFonts() {
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
  // react-pdf's own text-layout step hyphenates long words by default,
  // which looks wrong for item descriptions / addresses on a business
  // document — disable it so a long word just wraps to the next line whole.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

// ---- Layout constants --------------------------------------------------
const PAGE = { width: 612, height: 792 };
const MARGIN = { top: 36, bottom: 40, left: 40, right: 40 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right; // 532
const CONTENT_HEIGHT = PAGE.height - MARGIN.top - MARGIN.bottom; // 716

const HEADER_HEIGHT = 92; // logo/title/PO# block + accent rule
const ADDRESS_BLOCK_HEIGHT = 112; // 3-column From/Vendor/Ship-to row
const ORDER_DETAILS_HEIGHT = 34; // single strip of key order facts
const TABLE_HEADER_HEIGHT = 18;
const FOOTER_RESERVED = 26; // footer is position:absolute within the margin area, but we keep rows clear of it

const ROW_FONT_SIZE = 8;
const ROW_LINE_HEIGHT = 10;
const ROW_V_PADDING = 7; // 3.5 top + 3.5 bottom-ish, rounded
const CHARS_PER_PT = 1 / (ROW_FONT_SIZE * 0.52);

const COLS = {
  item: 45,
  description: 203,
  qty: 42,
  unit: 48,
  unitPrice: 72,
  lineTotal: 78,
};

function estimateRowHeight(line: PoLine): number {
  const descColInnerWidth = COLS.description - 8; // cell padding
  const charsPerLine = Math.max(10, Math.floor(descColInnerWidth * CHARS_PER_PT));
  const wrappedLines = Math.max(1, Math.ceil((line.description || "").length / charsPerLine));
  return wrappedLines * ROW_LINE_HEIGHT + ROW_V_PADDING;
}

/** Splits lines into page-sized chunks. The first chunk gets less room (addresses + order-details strip sit above the table on page 1); every chunk reserves room for the repeating header/footer. */
function chunkLines(lines: PoLine[]): PoLine[][] {
  const firstPageBudget = CONTENT_HEIGHT - HEADER_HEIGHT - ADDRESS_BLOCK_HEIGHT - ORDER_DETAILS_HEIGHT - TABLE_HEADER_HEIGHT - FOOTER_RESERVED;
  const continuationBudget = CONTENT_HEIGHT - HEADER_HEIGHT - TABLE_HEADER_HEIGHT - FOOTER_RESERVED;

  const chunks: PoLine[][] = [];
  let current: PoLine[] = [];
  let budget = firstPageBudget;
  let used = 0;

  for (const line of lines) {
    const h = estimateRowHeight(line);
    if (current.length > 0 && used + h > budget) {
      chunks.push(current);
      current = [];
      used = 0;
      budget = continuationBudget;
    }
    current.push(line);
    used += h;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([]);
  return chunks;
}

// fontFeatureSettings: { kern: false } on the page disables OpenType
// kerning. This Inter build has a corrupt "7."/"7," kerning pair that
// fontkit renders as a near-invisible period (e.g. "27.00" displays as
// "2700") — confirmed with both this project's font file and the
// canonical @fontsource/inter build, so it's a fontkit/font shaping
// issue, not a corrupted file. Disabling kerning entirely is a safe,
// unnoticeable trade-off at these sizes and guarantees every digit and
// decimal point in a dollar amount renders correctly.
const styles = StyleSheet.create({
  page: { paddingTop: MARGIN.top, paddingBottom: MARGIN.bottom, paddingLeft: MARGIN.left, paddingRight: MARGIN.right, fontFamily: "Inter", fontSize: 9, color: "#18181b", fontFeatureSettings: { kern: false } },
  footer: { position: "absolute", bottom: 16, left: MARGIN.left, right: MARGIN.right, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: "#71717a", borderTopWidth: 0.5, borderTopColor: "#d4d4d8", paddingTop: 4 },
});

function AccentBar({ color }: { color: string }) {
  return <View style={{ height: 3, backgroundColor: color, marginBottom: 10 }} />;
}

function DocHeader({ po, logoDataUri }: { po: PurchaseOrderWithLines; logoDataUri: string | null }) {
  const snap = po.company_snapshot;
  return (
    <View style={{ height: HEADER_HEIGHT }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {logoDataUri ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={logoDataUri} style={{ width: 48, height: 48, objectFit: "contain" }} />
          ) : null}
          <View>
            <Text style={{ fontSize: 14, fontWeight: 700 }}>{snap.legal_name}</Text>
            <Text style={{ fontSize: 8, color: "#52525b" }}>{snap.display_name}</Text>
          </View>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontSize: 16, fontWeight: 700, color: snap.accent_color }}>PURCHASE ORDER</Text>
          <Text style={{ fontSize: 10, fontWeight: 600, marginTop: 2 }}>{po.po_number}</Text>
        </View>
      </View>
      <AccentBar color={snap.accent_color} />
    </View>
  );
}

function Footer({ po }: { po: PurchaseOrderWithLines }) {
  const snap = po.company_snapshot;
  return (
    <View style={styles.footer} fixed>
      <Text>
        {snap.legal_name}
        {snap.footer_note ? ` — ${snap.footer_note}` : ""}
      </Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

function AddressColumn({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <View style={{ width: CONTENT_WIDTH / 3 - 8 }}>
      <Text style={{ fontSize: 7, fontWeight: 700, color: "#71717a", marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>{heading}</Text>
      {children}
    </View>
  );
}

const addrLine = { fontSize: 8, color: "#27272a", marginBottom: 1.5 };
const addrName = { fontSize: 9, fontWeight: 600, color: "#18181b", marginBottom: 2 };

function AddressBlocks({ po }: { po: PurchaseOrderWithLines }) {
  const snap = po.company_snapshot;
  const shipTo = po.ship_to.same_as_bill_to
    ? {
        name: snap.display_name,
        contact_name: "",
        address_line1: snap.address_line1 ?? "",
        address_line2: snap.address_line2 ?? "",
        city: snap.city ?? "",
        state: snap.state ?? "",
        zip: snap.zip ?? "",
        phone: snap.phone ?? "",
      }
    : po.ship_to;

  return (
    <View style={{ height: ADDRESS_BLOCK_HEIGHT, flexDirection: "row", justifyContent: "space-between", marginTop: 10 }}>
      <AddressColumn heading="From">
        <Text style={addrName}>{snap.legal_name}</Text>
        {snap.address_line1 && <Text style={addrLine}>{snap.address_line1}</Text>}
        {snap.address_line2 && <Text style={addrLine}>{snap.address_line2}</Text>}
        <Text style={addrLine}>
          {[snap.city, snap.state].filter(Boolean).join(", ")} {snap.zip ?? ""}
        </Text>
        {snap.phone && <Text style={addrLine}>{snap.phone}</Text>}
        {snap.email && <Text style={addrLine}>{snap.email}</Text>}
      </AddressColumn>

      <AddressColumn heading="Vendor">
        <Text style={addrName}>{po.vendor_name}</Text>
        {po.vendor_contact_name && <Text style={addrLine}>Attn: {po.vendor_contact_name}</Text>}
        <Text style={addrLine}>{po.vendor_address_line1}</Text>
        {po.vendor_address_line2 && <Text style={addrLine}>{po.vendor_address_line2}</Text>}
        <Text style={addrLine}>
          {po.vendor_city}, {po.vendor_state} {po.vendor_zip}
        </Text>
        {po.vendor_phone && <Text style={addrLine}>{po.vendor_phone}</Text>}
        {po.vendor_email && <Text style={addrLine}>{po.vendor_email}</Text>}
      </AddressColumn>

      <AddressColumn heading="Ship To">
        <Text style={addrName}>{shipTo.name}</Text>
        {shipTo.contact_name && <Text style={addrLine}>Attn: {shipTo.contact_name}</Text>}
        <Text style={addrLine}>{shipTo.address_line1}</Text>
        {shipTo.address_line2 && <Text style={addrLine}>{shipTo.address_line2}</Text>}
        <Text style={addrLine}>
          {shipTo.city}, {shipTo.state} {shipTo.zip}
        </Text>
        {shipTo.phone && <Text style={addrLine}>{shipTo.phone}</Text>}
      </AddressColumn>
    </View>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateSimple(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function OrderDetailsStrip({ po }: { po: PurchaseOrderWithLines }) {
  const items: Array<[string, string]> = [
    ["Order date", formatDateSimple(po.order_date)],
    ["Needed by", formatDateSimple(po.needed_by_date)],
    ["Payment terms", po.payment_terms],
    ["Shipping", po.shipping_method],
    ["Freight terms", po.freight_terms],
  ];
  if (po.reference_number) items.push(["Reference #", po.reference_number]);
  return (
    <View
      style={{
        height: ORDER_DETAILS_HEIGHT,
        marginTop: 8,
        flexDirection: "row",
        flexWrap: "wrap",
        backgroundColor: "#fafafa",
        borderWidth: 0.5,
        borderColor: "#e4e4e7",
        paddingVertical: 5,
        paddingHorizontal: 8,
      }}
    >
      {items.map(([label, value]) => (
        <View key={label} style={{ marginRight: 16, marginBottom: 2 }}>
          <Text style={{ fontSize: 6.5, color: "#71717a", textTransform: "uppercase" }}>{label}</Text>
          <Text style={{ fontSize: 8, color: "#18181b" }}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

const cellBase = { paddingVertical: 3.5, paddingHorizontal: 4, fontSize: ROW_FONT_SIZE };

function TableHeaderRow() {
  const headCell = { ...cellBase, fontWeight: 700, color: "#ffffff" };
  return (
    <View style={{ flexDirection: "row", backgroundColor: "#27272a", height: TABLE_HEADER_HEIGHT }}>
      <Text style={{ ...headCell, width: COLS.item }}>Item #</Text>
      <Text style={{ ...headCell, width: COLS.description }}>Description</Text>
      <Text style={{ ...headCell, width: COLS.qty, textAlign: "right" }}>Qty</Text>
      <Text style={{ ...headCell, width: COLS.unit }}>Unit</Text>
      <Text style={{ ...headCell, width: COLS.unitPrice, textAlign: "right" }}>Unit price</Text>
      <Text style={{ ...headCell, width: COLS.lineTotal, textAlign: "right" }}>Line total</Text>
    </View>
  );
}

function TableRow({ line, zebra }: { line: PoLine; zebra: boolean }) {
  return (
    <View wrap={false} style={{ flexDirection: "row", backgroundColor: zebra ? "#fafafa" : "#ffffff", borderBottomWidth: 0.5, borderBottomColor: "#e4e4e7" }}>
      <Text style={{ ...cellBase, width: COLS.item, color: "#52525b" }}>{line.item_number || "—"}</Text>
      <Text style={{ ...cellBase, width: COLS.description }}>{line.description}</Text>
      <Text style={{ ...cellBase, width: COLS.qty, textAlign: "right" }}>{line.quantity}</Text>
      <Text style={{ ...cellBase, width: COLS.unit }}>{line.unit}</Text>
      <Text style={{ ...cellBase, width: COLS.unitPrice, textAlign: "right" }}>{fmt(line.unit_price)}</Text>
      <Text style={{ ...cellBase, width: COLS.lineTotal, textAlign: "right" }}>{fmt(line.line_total)}</Text>
    </View>
  );
}

function TotalsBlock({ po }: { po: PurchaseOrderWithLines }) {
  const rows: Array<[string, string, boolean?]> = [
    ["Subtotal", fmt(po.subtotal)],
    ["Shipping", fmt(po.shipping_cost)],
    [po.tax_exempt ? "Tax (exempt)" : `Tax (${po.tax_rate_percent}%)`, fmt(po.tax_amount)],
    ["Total", fmt(po.total), true],
  ];
  return (
    <View style={{ alignSelf: "flex-end", width: 220, marginTop: 10 }}>
      {rows.map(([label, value, isTotal]) => (
        <View
          key={label}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            paddingVertical: isTotal ? 5 : 2.5,
            borderTopWidth: isTotal ? 1 : 0,
            borderTopColor: "#18181b",
            marginTop: isTotal ? 3 : 0,
          }}
        >
          <Text style={{ fontSize: isTotal ? 10 : 8.5, fontWeight: isTotal ? 700 : 400 }}>{label}</Text>
          <Text style={{ fontSize: isTotal ? 10 : 8.5, fontWeight: isTotal ? 700 : 400 }}>${value}</Text>
        </View>
      ))}
    </View>
  );
}

function TextSection({ heading, body, dim }: { heading: string; body: string; dim?: boolean }) {
  if (!body) return null;
  return (
    <View style={{ marginTop: 14 }} wrap>
      <Text style={{ fontSize: 8, fontWeight: 700, color: "#71717a", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>{heading}</Text>
      <Text style={{ fontSize: dim ? 7.5 : 8, color: dim ? "#52525b" : "#27272a", lineHeight: 1.4 }}>{body}</Text>
    </View>
  );
}

function AuthorizationBlock({ po }: { po: PurchaseOrderWithLines }) {
  return (
    <View style={{ marginTop: 20, flexDirection: "row", justifyContent: "space-between" }} wrap={false}>
      <View style={{ width: 220 }}>
        <Text style={{ fontSize: 7, color: "#71717a", textTransform: "uppercase", marginBottom: 2 }}>Prepared by</Text>
        <Text style={{ fontSize: 9, fontWeight: 600 }}>{po.prepared_by_name}</Text>
      </View>
      <View style={{ width: 220 }}>
        <Text style={{ fontSize: 7, color: "#71717a", textTransform: "uppercase", marginBottom: 2 }}>Authorized by</Text>
        <Text style={{ fontSize: 9, fontWeight: 600 }}>{po.authorized_by_name}</Text>
        <Text style={{ fontSize: 8, color: "#52525b" }}>{po.authorized_by_title}</Text>
        <View style={{ marginTop: 16, borderTopWidth: 0.5, borderTopColor: "#a1a1aa", width: 200 }} />
        <Text style={{ fontSize: 6.5, color: "#a1a1aa", marginTop: 2 }}>Signature / date</Text>
      </View>
    </View>
  );
}

export function PurchaseOrderPdfDocument({ po, logoDataUri }: { po: PurchaseOrderWithLines; logoDataUri: string | null }) {
  registerFonts();
  const pageChunks = chunkLines(po.po_lines);

  return (
    <Document title={`${po.po_number} — ${po.vendor_name}`} author={po.company_snapshot.legal_name}>
      {pageChunks.map((chunk, pageIndex) => (
        <Page key={pageIndex} size="LETTER" style={styles.page}>
          <DocHeader po={po} logoDataUri={logoDataUri} />
          {pageIndex === 0 && <AddressBlocks po={po} />}
          {pageIndex === 0 && <OrderDetailsStrip po={po} />}
          <View style={{ marginTop: 10 }}>
            <TableHeaderRow />
            {chunk.map((line, i) => (
              <TableRow key={line.id} line={line} zebra={i % 2 === 1} />
            ))}
          </View>
          <Footer po={po} />
        </Page>
      ))}

      <Page size="LETTER" style={styles.page}>
        <DocHeader po={po} logoDataUri={logoDataUri} />
        <TotalsBlock po={po} />
        <TextSection heading="Special instructions" body={po.special_instructions ?? ""} />
        <TextSection heading="Notes to vendor" body={po.notes_to_vendor ?? ""} />
        <TextSection heading="Terms & conditions" body={po.terms_text} dim />
        <AuthorizationBlock po={po} />
        <Footer po={po} />
      </Page>
    </Document>
  );
}
