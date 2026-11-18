/**
 * The wholesale line sheet PDF (@react-pdf/renderer, server only). Same
 * page size, margins, Inter fonts, accent color and long-word breaking as
 * the invoice PDF. Pages are laid out MANUALLY (paginateLineSheet): every
 * page has the table header, a product row is never split, and the terms
 * box stays together on the page with the last rows. Photos (about 1 inch)
 * are data URIs prepared on the server; a missing photo prints a
 * placeholder. Renders from the line sheet's own saved copy of the
 * letterhead and prices.
 */
import React from "react";
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { mixWithWhite, pickReadableTextColor } from "@/lib/colorContrast";
import { formatLongDate, formatUnitPrice } from "@/lib/retail/format";
import { nyDateOf } from "@/lib/growth/dates";
import { LS, NO_PRICE_TEXT, marginPercent, paginateLineSheet, preparedForText, productColumnWidth, type LineSheetLine, type LineSheetWithLines } from "@/lib/retail/lineSheets";
import { breakable, registerInvoiceFonts } from "./invoicePdf";

const W = LS.contentW;
const INK = "#18181b";
const MUTED = "#3f3f46";
const HAIRLINE = "#d4d4d8";
const PHOTO_COL = LS.photo + 12;
const PRICE_COL = 80;
const MSRP_COL = 72;
const MARGIN_COL = 56;

const styles = StyleSheet.create({
  page: { paddingTop: LS.marginTop, paddingBottom: LS.marginBottom, paddingLeft: 40, paddingRight: 40, fontFamily: "Inter", fontSize: 8.5, color: INK, fontFeatureSettings: { kern: false } },
  label: { fontSize: 7, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" },
});

type Palette = { accent: string; onAccent: string; tint: string; soft: string; ink: string };
function palette(accent: string): Palette {
  const a = /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#1a472a";
  const on = pickReadableTextColor(a);
  return { accent: a, onAccent: on, tint: mixWithWhite(a, 0.07), soft: mixWithWhite(a, 0.04), ink: on === "#ffffff" ? a : INK };
}

const addressLines = (s: LineSheetWithLines) => {
  const c = s.company_snapshot;
  return [c.address_line1, c.address_line2, [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "), c.phone, c.email, c.website].filter((x): x is string => !!x && x.trim() !== "");
};
/** The continuation header has room for two lines: long names are shortened there (the full name is on page 1). */
const shortName = (n: string) => (n.length > 48 ? `${n.slice(0, 47).trimEnd()}…` : n);
const savedOn = (s: LineSheetWithLines) => formatLongDate(nyDateOf(s.prices_saved_at));

function Header({ s, logo, p, preparedFor }: { s: LineSheetWithLines; logo: string | null; p: Palette; preparedFor: string }) {
  const c = s.company_snapshot;
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ width: W - 250, paddingRight: 12 }}>
          {logo ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={logo} style={{ height: 48, maxWidth: 170, objectFit: "contain", marginBottom: 6, alignSelf: "flex-start" }} />
          ) : (
            <Text style={{ fontSize: 16, fontWeight: 700, color: p.ink, marginBottom: 4 }}>{c.display_name}</Text>
          )}
          {logo ? <Text style={{ fontSize: 10, fontWeight: 700 }}>{c.display_name}</Text> : null}
          {addressLines(s).map((l, i) => (
            <Text key={i} style={{ color: MUTED }}>
              {breakable(l, W - 262)}
            </Text>
          ))}
        </View>
        <View style={{ width: 250, alignItems: "flex-end" }}>
          <Text style={{ fontSize: 18, fontWeight: 700, color: p.ink, letterSpacing: 1.2, textAlign: "right" }}>WHOLESALE LINE SHEET</Text>
          <Text style={{ fontSize: 10, fontWeight: 600, marginTop: 4, textAlign: "right" }}>{breakable(s.name, 244, 10)}</Text>
          {preparedFor ? <Text style={{ fontSize: 9, marginTop: 3, textAlign: "right" }}>Prepared for {breakable(preparedFor, 230, 9)}</Text> : null}
          <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 3 }}>Prices as of {savedOn(s)}</Text>
        </View>
      </View>
      <View style={{ height: 2, backgroundColor: p.accent, marginTop: 10, marginBottom: 12 }} />
    </View>
  );
}

function ContinuationHeader({ s, p }: { s: LineSheetWithLines; p: Palette }) {
  return (
    <View style={{ height: LS.contHeader - 8, marginBottom: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
        <Text style={{ fontSize: 10, fontWeight: 700, maxWidth: W - 260 }}>{s.company_snapshot.display_name}</Text>
        <Text style={{ fontSize: 8.5, fontWeight: 600, maxWidth: 260, textAlign: "right" }}>Wholesale line sheet · {breakable(shortName(s.name), 150)} (continued)</Text>
      </View>
      <View style={{ height: 1, backgroundColor: p.accent, marginTop: 6 }} />
    </View>
  );
}

const cell = { paddingVertical: 5, paddingHorizontal: 5 } as const;

function TableHeader({ s, p }: { s: LineSheetWithLines; p: Palette }) {
  const t = { fontSize: 7.5, fontWeight: 700, color: p.onAccent, letterSpacing: 0.6, textTransform: "uppercase" } as const;
  return (
    <View style={{ flexDirection: "row", backgroundColor: p.accent, minHeight: LS.tableHeader, alignItems: "center" }} wrap={false}>
      <Text style={{ ...t, ...cell, width: PHOTO_COL }}> </Text>
      <Text style={{ ...t, ...cell, width: productColumnWidth(s.show_margin) }}>Product</Text>
      <Text style={{ ...t, ...cell, width: PRICE_COL, textAlign: "right" }}>Wholesale</Text>
      <Text style={{ ...t, ...cell, width: MSRP_COL, textAlign: "right" }}>MSRP</Text>
      {s.show_margin ? <Text style={{ ...t, ...cell, width: MARGIN_COL, textAlign: "right" }}>Margin</Text> : null}
    </View>
  );
}

function Row({ s, line, photo, zebra, p }: { s: LineSheetWithLines; line: LineSheetLine; photo: string | null; zebra: boolean; p: Palette }) {
  const w = productColumnWidth(s.show_margin);
  const meta = [line.size_text, line.case_pack_text ? `Case pack: ${line.case_pack_text}` : null].filter(Boolean).join(" · ");
  const noPrice = s.price_basis === "retailer";
  const price = (v: LineSheetLine["wholesale_price"]) => (v === null || v === undefined || v === "" ? (noPrice ? NO_PRICE_TEXT : "—") : formatUnitPrice(v));
  const margin = marginPercent(line.wholesale_price, line.msrp);
  return (
    <View style={{ flexDirection: "row", backgroundColor: zebra ? p.tint : "#ffffff", borderBottomWidth: 0.5, borderBottomColor: "#ececee", paddingVertical: LS.rowPad / 2 }} wrap={false}>
      <View style={{ width: PHOTO_COL, paddingHorizontal: 5 }}>
        {photo ? (
          // eslint-disable-next-line jsx-a11y/alt-text
          <Image src={photo} style={{ width: LS.photo, height: LS.photo, objectFit: "contain", backgroundColor: "#ffffff" }} />
        ) : (
          <View style={{ width: LS.photo, height: LS.photo, borderWidth: 0.75, borderColor: HAIRLINE, backgroundColor: "#f4f4f5", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 7, color: MUTED }}>No photo</Text>
          </View>
        )}
      </View>
      <View style={{ width: w, paddingHorizontal: 5 }}>
        <Text style={{ fontSize: 9.5, fontWeight: 700 }}>{breakable(line.name, w - 10, 9.5)}</Text>
        {line.description ? <Text style={{ fontSize: 8, marginTop: 2 }}>{breakable(line.description, w - 10, 8)}</Text> : null}
        {meta ? <Text style={{ fontSize: 7.5, color: MUTED, marginTop: 2 }}>{breakable(meta, w - 10, 7.5)}</Text> : null}
      </View>
      <Text style={{ ...cell, paddingVertical: 0, width: PRICE_COL, textAlign: "right", fontSize: line.wholesale_price === null && noPrice ? 7.5 : 9.5, fontWeight: 700 }}>{price(line.wholesale_price)}</Text>
      <Text style={{ ...cell, paddingVertical: 0, width: MSRP_COL, textAlign: "right", fontSize: line.msrp === null && noPrice ? 7.5 : 9 }}>{price(line.msrp)}</Text>
      {s.show_margin ? <Text style={{ ...cell, paddingVertical: 0, width: MARGIN_COL, textAlign: "right" }}>{margin ?? "—"}</Text> : null}
    </View>
  );
}

function TermsBox({ s, p }: { s: LineSheetWithLines; p: Palette }) {
  const half = W / 2 - 24;
  const rows: Array<[string, string]> = [
    ["Minimum order", s.minimum_order_text ?? ""],
    ["Lead time", s.lead_time_text ?? ""],
    ["Payment terms", s.payment_terms_text ?? ""],
  ].filter(([, v]) => v) as Array<[string, string]>;
  const contact = [s.contact_name, s.contact_email, s.contact_phone].filter((x): x is string => !!x);
  return (
    <View style={{ marginTop: 14 }} wrap={false}>
      <View style={{ borderWidth: 0.75, borderColor: HAIRLINE, backgroundColor: p.soft, padding: 10, borderRadius: 2 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View style={{ width: half }}>
            <Text style={{ ...styles.label, color: p.ink, marginBottom: 4 }}>Terms</Text>
            {rows.length === 0 ? <Text style={{ color: MUTED }}>Ask us about terms.</Text> : null}
            {rows.map(([k, v]) => (
              <View key={k} style={{ flexDirection: "row", marginBottom: 2 }}>
                <Text style={{ width: 70, fontWeight: 600 }}>{k}</Text>
                <Text style={{ width: half - 70 }}>{breakable(v, half - 72)}</Text>
              </View>
            ))}
          </View>
          <View style={{ width: half }}>
            <Text style={{ ...styles.label, color: p.ink, marginBottom: 4 }}>Contact</Text>
            {contact.map((c, i) => (
              <Text key={i} style={{ fontWeight: i === 0 ? 600 : 400 }}>
                {breakable(c, half)}
              </Text>
            ))}
          </View>
        </View>
        {s.notes ? (
          <View style={{ marginTop: 8, borderTopWidth: 0.5, borderTopColor: HAIRLINE, paddingTop: 6 }}>
            <Text>{breakable(s.notes, W - 24)}</Text>
          </View>
        ) : null}
      </View>
      <Text style={{ fontSize: 7, color: MUTED, marginTop: 4 }}>Prices in USD as of {savedOn(s)}.</Text>
    </View>
  );
}

function Footer({ s }: { s: LineSheetWithLines }) {
  return (
    <View fixed style={{ position: "absolute", left: 40, right: 40, bottom: 18 }}>
      <View style={{ height: 0.5, backgroundColor: HAIRLINE, marginBottom: 4 }} />
      <View style={{ flexDirection: "row", justifyContent: "space-between", fontSize: 6.5, color: MUTED }}>
        <Text style={{ width: W * 0.8 }}>
          {s.company_snapshot.legal_name} · Wholesale line sheet · {breakable(s.name, W * 0.6, 6.5)}
        </Text>
        <Text style={{ width: W * 0.2, textAlign: "right" }} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </View>
    </View>
  );
}

export function LineSheetPdfDocument({ sheet, logoDataUri, photos, retailerName }: { sheet: LineSheetWithLines; logoDataUri: string | null; photos: Record<string, string>; retailerName: string | null }) {
  registerInvoiceFonts();
  const p = palette(sheet.company_snapshot.accent_color);
  const preparedFor = preparedForText(sheet, retailerName);
  const pages = paginateLineSheet(sheet, sheet.lines, preparedFor);
  let n = 0;
  return (
    <Document title={`Line Sheet - ${sheet.name}`} author={sheet.company_snapshot.legal_name} subject="Wholesale line sheet" creator="KCG Ventures ERP" producer="KCG Ventures ERP">
      {pages.map((pg, i) => (
        <Page key={i} size="LETTER" style={styles.page} wrap>
          {pg.first ? <Header s={sheet} logo={logoDataUri} p={p} preparedFor={preparedFor} /> : <ContinuationHeader s={sheet} p={p} />}
          {pg.rows.length > 0 ? <TableHeader s={sheet} p={p} /> : null}
          {pg.rows.map((line) => {
            const z = n++ % 2 === 1;
            return <Row key={line.line_number} s={sheet} line={line} photo={line.photo_asset_id ? photos[line.photo_asset_id] ?? null : null} zebra={z} p={p} />;
          })}
          {pg.tail ? <TermsBox s={sheet} p={p} /> : null}
          <Footer s={sheet} />
        </Page>
      ))}
    </Document>
  );
}
