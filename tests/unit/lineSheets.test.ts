// Line sheets: pricing helpers, validation, the file name, page layout and
// a PDF render (photos, placeholders, many pages). Invented data only.
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import {
  LS,
  MAX_LINE_SHEET_LINES,
  lineRowHeight,
  lineSheetFilename,
  marginPercent,
  paginateLineSheet,
  preparedForText,
  standardWholesale,
  termsBoxHeight,
  validateLineSheet,
  firstHeaderHeight,
  type LineSheetLine,
  type LineSheetWithLines,
} from "@/lib/retail/lineSheets";
import { LineSheetPdfDocument } from "@/lib/pdf/lineSheetPdf";
import { photoDataUri } from "@/lib/retail/lineSheetService";

const BIZ = "11111111-1111-4111-8111-111111111111";
const RET = "22222222-2222-4222-8222-222222222222";

function sampleSheet(over: Partial<LineSheetWithLines> = {}, n = 3, long = false): LineSheetWithLines {
  const lines: LineSheetLine[] = Array.from({ length: n }, (_, i) => ({
    line_number: i + 1,
    product_id: null,
    name: long ? `Product ${i + 1} with a very long name that keeps going to test wrapping across the column` : `Product ${String.fromCharCode(65 + (i % 26))}`,
    description: long ? "A long description that goes on for a while, describing flavor, texture, and how the product is packed, so that it wraps over several lines in the product column. ".repeat(2).trim() : "Fresh mint, made in small batches.",
    size_text: "4 oz",
    case_pack_text: "12 per case",
    wholesale_price: i % 5 === 4 ? null : (6 + i * 0.0125).toFixed(4),
    msrp: i % 5 === 4 ? null : "12.00",
    photo_asset_id: null,
  }));
  return {
    id: "sample",
    name: "Spring Wholesale",
    company_profile_id: BIZ,
    retailer_id: null,
    prepared_for: "Store A",
    price_basis: "standard",
    standard_wholesale_percent: "50",
    show_margin: false,
    minimum_order_text: "$150 opening order",
    lead_time_text: "Ships in 5 business days",
    payment_terms_text: "Net 30",
    contact_name: "BotanIQals",
    contact_email: "orders@company-a.example.test",
    contact_phone: "(555) 010-0100",
    notes: "Samples available on request.",
    company_snapshot: {
      display_name: "BotanIQals",
      legal_name: "KCG Ventures LLC",
      address_line1: "100 Example Street",
      address_line2: null,
      city: "Testville",
      state: "DE",
      zip: "19700",
      country: "United States",
      phone: "(555) 010-0100",
      email: "orders@company-a.example.test",
      website: "https://company-a.example.test",
      logo_path: null,
      accent_color: "#1a472a",
    },
    prices_saved_at: "2026-11-17T15:00:00Z",
    created_by_name: null,
    deleted_at: null,
    last_downloaded_at: null,
    created_at: "2026-11-17T15:00:00Z",
    updated_at: "2026-11-17T15:00:00Z",
    lines,
    ...over,
  };
}

describe("pricing", () => {
  it("standard wholesale is a percent of MSRP (4 decimals)", () => {
    expect(standardWholesale("12", "50")).toBe("6");
    expect(standardWholesale("9.99", "55")).toBe("5.4945");
    expect(standardWholesale("", "50")).toBeNull();
    expect(standardWholesale("10", null)).toBeNull();
  });
  it("margin uses the price list's retailerMargin", () => {
    expect(marginPercent("6", "12")).toBe("50%");
    expect(marginPercent("8", "12")).toBe("33.33%");
    expect(marginPercent("6", "0")).toBeNull();
    expect(marginPercent(null, "12")).toBeNull();
  });
  it("file name and prepared-for text", () => {
    expect(lineSheetFilename('Spring / "Store A": 2027?')).toBe("Line Sheet - Spring Store A 2027.pdf");
    expect(lineSheetFilename("***")).toBe("Line Sheet - Untitled.pdf");
    expect(preparedForText({ prepared_for: " " }, "Retailer A")).toBe("Retailer A");
    expect(preparedForText({ prepared_for: "Store B" }, "Retailer A")).toBe("Store B");
  });
});

describe("validation", () => {
  const base = { name: "Sheet A", company_profile_id: BIZ, price_basis: "standard", standard_wholesale_percent: "50", lines: [{ name: "Product A", wholesale_price: "6", msrp: "12" }] };
  it("accepts a valid sheet and normalises prices", () => {
    const r = validateLineSheet(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0]).toMatchObject({ line_number: 1, name: "Product A", wholesale_price: "6", msrp: "12", description: null });
  });
  it("needs a retailer for the retailer basis, a valid percent, names and at most 60 lines", () => {
    const r = validateLineSheet({ ...base, name: "", price_basis: "retailer", lines: [{ name: "", wholesale_price: "-1" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["lines.0.name", "lines.0.wholesale_price", "name", "retailer_id"]);
    const p = validateLineSheet({ ...base, standard_wholesale_percent: "0" });
    expect(p.ok || p.errors.standard_wholesale_percent).toBeTruthy();
    const many = validateLineSheet({ ...base, lines: Array.from({ length: MAX_LINE_SHEET_LINES + 1 }, (_, i) => ({ name: `P${i}` })) });
    expect(many.ok ? "" : many.errors.lines).toMatch(/at most 60/);
    const none = validateLineSheet({ ...base, lines: [] });
    expect(none.ok ? "" : none.errors.lines).toMatch(/at least one/);
    const retail = validateLineSheet({ ...base, price_basis: "retailer", retailer_id: RET, lines: [{ name: "P", wholesale_price: "", msrp: "" }] });
    expect(retail.ok && retail.value.lines[0].wholesale_price).toBeNull();
  });
});

describe("page layout", () => {
  const BODY = LS.pageH - LS.marginTop - LS.marginBottom;
  for (const [n, long, margin] of [[1, false, false], [12, false, true], [40, true, false], [60, true, true]] as const) {
    it(`${n} rows${long ? " (long text)" : ""}: every row once, in order, pages within budget, terms on the last page`, () => {
      const s = sampleSheet({ show_margin: margin }, n, long);
      const pages = paginateLineSheet(s, s.lines, "Store A");
      expect(pages.flatMap((p) => p.rows.map((r) => r.line_number))).toEqual(s.lines.map((l) => l.line_number));
      expect(pages.filter((p) => p.tail)).toHaveLength(1);
      expect(pages[pages.length - 1].tail).toBe(true);
      expect(pages[pages.length - 1].rows.length).toBeGreaterThan(0);
      pages.forEach((p, i) => {
        const head = i === 0 ? firstHeaderHeight(s, "Store A") : LS.contHeader;
        const used = head + LS.tableHeader + p.rows.reduce((t, r) => t + lineRowHeight(r, margin), 0) + (p.tail ? termsBoxHeight(s) : 0);
        expect(used).toBeLessThanOrEqual(BODY);
      });
      if (n >= 40) expect(pages.length).toBeGreaterThan(2);
    });
  }
});

describe("PDF", () => {
  it("renders photos, placeholders and several pages", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const photo = await photoDataUri(new Uint8Array(png), "image/png");
    expect(photo).toMatch(/^data:image\/(png|jpeg);base64,/);
    const s = sampleSheet({ show_margin: true }, 40, true);
    s.lines[0].photo_asset_id = "33333333-3333-4333-8333-333333333333";
    const buf = await renderToBuffer(React.createElement(LineSheetPdfDocument, { sheet: s, logoDataUri: null, photos: { [s.lines[0].photo_asset_id!]: photo! }, retailerName: null }) as never);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const pages = (buf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
    expect(pages).toBe(paginateLineSheet(s, s.lines, "Store A").length);
  }, 60_000);
  it("an unreadable photo gives the placeholder (null), never an error", async () => {
    expect(await photoDataUri(new TextEncoder().encode("not an image"), "image/webp")).toBeNull();
  });
});
