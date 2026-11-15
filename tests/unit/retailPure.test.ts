// Retail pure modules: invoice numbers, order numbers, due dates, terms,
// consignment text, totals, price choice and margin. Invented values only.
import { describe, expect, it } from "vitest";
import { formatInvoiceNumber, nyYear } from "@/lib/retail/invoiceNumber";
import { normalizeOrderNumber, orderNumberForFilename, sameOrderNumber } from "@/lib/retail/orderNumber";
import { addDays, computeDueDate, isIsoDate } from "@/lib/retail/dueDate";
import {
  consignmentTermsText,
  resolveDefaultTerms,
  retailerSharePercent,
  termsLabel,
  termsSummary,
  validateTerms,
  type Terms,
} from "@/lib/retail/terms";
import { computeTotals, lineTotal, linePriceFor, retailerMargin } from "@/lib/retail/totals";
import { formatLongDate, formatMoney, formatPercent, formatQuantity, formatUnitPrice, todayNy } from "@/lib/retail/format";

const consignment = (over: Partial<Terms> = {}): Terms => ({
  terms_type: "consignment",
  net_days: null,
  terms_start: "invoice_date",
  consignment_our_share_percent: 70,
  consignment_schedule: "monthly",
  consignment_days_to_pay: 15,
  consignment_extra_terms: null,
  ...over,
});

describe("invoice numbers", () => {
  it("first number, sequence, past 999, per prefix and year", () => {
    expect(formatInvoiceNumber("KCG-INV", 2026, 1)).toBe("KCG-INV-2026-001");
    expect(formatInvoiceNumber("KCG-INV", 2026, 42)).toBe("KCG-INV-2026-042");
    expect(formatInvoiceNumber("KCG-INV", 2026, 999)).toBe("KCG-INV-2026-999");
    expect(formatInvoiceNumber("KCG-INV", 2026, 1000)).toBe("KCG-INV-2026-1000");
    expect(formatInvoiceNumber("ML-INV", 2027, 1)).toBe("ML-INV-2027-001");
    expect(() => formatInvoiceNumber("KCG-INV", 2026, 0)).toThrow();
  });
  it("uses the New York year across New Year's Eve", () => {
    expect(nyYear(new Date("2027-01-01T03:00:00Z"))).toBe(2026); // 10 PM Dec 31 in New York
    expect(nyYear(new Date("2027-01-01T06:00:00Z"))).toBe(2027);
  });
});

describe("normalizeOrderNumber", () => {
  it("digits only get a #", () => {
    expect(normalizeOrderNumber("2552")).toEqual({ ok: true, value: "#2552" });
    expect(normalizeOrderNumber(" 2552 ")).toEqual({ ok: true, value: "#2552" });
  });
  it("keeps an existing #, letters, prefixes and suffixes as typed; collapses spaces", () => {
    expect(normalizeOrderNumber("#2552")).toEqual({ ok: true, value: "#2552" });
    expect(normalizeOrderNumber("BQ-2552")).toEqual({ ok: true, value: "BQ-2552" });
    expect(normalizeOrderNumber("  #2552   W  ")).toEqual({ ok: true, value: "#2552 W" });
  });
  it("rejects empty, whitespace-only and over 50 characters", () => {
    expect(normalizeOrderNumber("").ok).toBe(false);
    expect(normalizeOrderNumber("   ").ok).toBe(false);
    expect(normalizeOrderNumber(undefined).ok).toBe(false);
    expect(normalizeOrderNumber("A".repeat(50)).ok).toBe(true);
    expect(normalizeOrderNumber("A".repeat(51)).ok).toBe(false);
    expect(normalizeOrderNumber("1".repeat(50)).ok).toBe(false); // "#" makes it 51
  });
  it("compares case-insensitively", () => {
    expect(sameOrderNumber("bq-2552", "BQ-2552")).toBe(true);
    expect(sameOrderNumber("#2552", "#2553")).toBe(false);
    expect(orderNumberForFilename("#2552")).toBe("2552");
  });
});

describe("computeDueDate", () => {
  it("Net 15 and Net 30 from the invoice date and from the delivery date", () => {
    expect(computeDueDate("2026-11-15", "2026-11-20", "net", 15, "invoice_date")).toBe("2026-11-30");
    expect(computeDueDate("2026-11-15", "2026-11-20", "net", 30, "invoice_date")).toBe("2026-12-15");
    expect(computeDueDate("2026-11-15", "2026-11-20", "net", 30, "delivery_date")).toBe("2026-12-20");
  });
  it("month ends, year ends and a leap year", () => {
    expect(computeDueDate("2026-01-31", "2026-01-31", "net", 30, "invoice_date")).toBe("2026-03-02");
    expect(computeDueDate("2026-12-15", "2026-12-20", "net", 30, "invoice_date")).toBe("2027-01-14");
    expect(computeDueDate("2028-02-15", "2028-02-15", "net", 15, "invoice_date")).toBe("2028-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });
  it("across both daylight saving changes the result is the exact calendar date", () => {
    expect(computeDueDate("2026-03-01", "2026-03-01", "net", 15, "invoice_date")).toBe("2026-03-16"); // spring forward Mar 8
    expect(computeDueDate("2026-10-25", "2026-10-25", "net", 15, "invoice_date")).toBe("2026-11-09"); // fall back Nov 1
    expect(computeDueDate("2026-03-07", "2026-03-07", "net", 1, "invoice_date")).toBe("2026-03-08");
    expect(computeDueDate("2026-10-31", "2026-10-31", "net", 1, "invoice_date")).toBe("2026-11-01");
  });
  it("due on receipt, due on delivery, prepaid and consignment", () => {
    expect(computeDueDate("2026-11-15", "2026-11-20", "due_on_receipt", null)).toBe("2026-11-15");
    expect(computeDueDate("2026-11-15", "2026-11-20", "due_on_delivery", null)).toBe("2026-11-20");
    expect(computeDueDate("2026-11-15", "2026-11-20", "prepaid", null)).toBe("2026-11-15");
    expect(computeDueDate("2026-11-15", "2026-11-20", "consignment", null)).toBeNull();
  });
  it("validates net days and dates", () => {
    for (const bad of [0, 181, 1.5, null, undefined]) expect(() => computeDueDate("2026-11-15", "2026-11-20", "net", bad as never)).toThrow();
    expect(computeDueDate("2026-11-15", "2026-11-20", "net", 180)).toBe("2027-05-14");
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-11-15")).toBe(true);
  });
});

describe("terms", () => {
  it("labels", () => {
    expect(termsLabel({ terms_type: "net", net_days: 30 })).toBe("Net 30");
    expect(termsLabel({ terms_type: "due_on_receipt", net_days: null })).toBe("Due on receipt");
    expect(termsLabel({ terms_type: "due_on_delivery", net_days: null })).toBe("Due on delivery");
    expect(termsLabel({ terms_type: "prepaid", net_days: null })).toBe("Prepaid (payment due before delivery)");
    expect(termsLabel({ terms_type: "consignment", net_days: null })).toBe("Consignment");
    expect(termsSummary(consignment())).toBe("Consignment 70%, monthly");
    expect(termsSummary(consignment({ consignment_schedule: "biweekly", consignment_our_share_percent: "66.50" }))).toBe("Consignment 66.5%, every two weeks");
  });

  it("consignment terms text: shares, schedule, days, extra terms", () => {
    expect(consignmentTermsText(consignment(), "Company A LLC")).toEqual([
      "Company A LLC receives 70% of the retail price of each unit sold. The retailer retains 30%.",
      "Sales are reported and settled monthly.",
      "Payment is due 15 days after each settlement statement.",
    ]);
    const t = consignmentTermsText(
      consignment({ consignment_our_share_percent: "66.67", consignment_schedule: "biweekly", consignment_days_to_pay: 30, consignment_extra_terms: "  Unsold stock is returned at our cost.  " }),
      "Company A LLC",
    );
    expect(t[0]).toBe("Company A LLC receives 66.67% of the retail price of each unit sold. The retailer retains 33.33%.");
    expect(t[1]).toBe("Sales are reported and settled every two weeks.");
    expect(t[2]).toBe("Payment is due 30 days after each settlement statement.");
    expect(t[3]).toBe("Unsold stock is returned at our cost.");
    expect(consignmentTermsText(consignment({ consignment_extra_terms: "   " }), "Company A LLC")).toHaveLength(3);
    expect(retailerSharePercent("70.00")).toBe("30");
  });

  it("resolveDefaultTerms: retailer row first (consignment fields carried), else business defaults", () => {
    const r = resolveDefaultTerms(consignment({ consignment_extra_terms: "Extra" }), { default_terms_type: "net", default_net_days: 30 });
    expect(r).toMatchObject({ terms_type: "consignment", consignment_our_share_percent: 70, consignment_schedule: "monthly", consignment_days_to_pay: 15, consignment_extra_terms: "Extra", source: "retailer" });
    const d = resolveDefaultTerms(null, { default_terms_type: "net", default_net_days: 45 });
    expect(d).toMatchObject({ terms_type: "net", net_days: 45, terms_start: "invoice_date", source: "business_default" });
    expect(resolveDefaultTerms(null, { default_terms_type: "due_on_receipt", default_net_days: 30 })).toMatchObject({ terms_type: "due_on_receipt", net_days: null });
    expect(resolveDefaultTerms(null, null)).toMatchObject({ terms_type: "net", net_days: 30 });
    const net = resolveDefaultTerms({ ...consignment(), terms_type: "net", net_days: 15, terms_start: "delivery_date" }, null);
    expect(net).toMatchObject({ net_days: 15, terms_start: "delivery_date" });
  });

  it("validateTerms: required fields, ranges, and clearing fields that don't apply", () => {
    expect(validateTerms({ terms_type: "net", net_days: "30" })).toMatchObject({ ok: true, value: { net_days: 30, consignment_schedule: null } });
    expect(validateTerms({ terms_type: "net", net_days: 0 }).ok).toBe(false);
    expect(validateTerms({ terms_type: "nope" }).ok).toBe(false);
    const c = validateTerms({ terms_type: "consignment", consignment_our_share_percent: "70", consignment_schedule: "monthly", consignment_days_to_pay: 15, net_days: 30 });
    expect(c).toMatchObject({ ok: true, value: { consignment_our_share_percent: "70", net_days: null } });
    for (const share of ["0", "100", "-5", "70.123", "abc", ""]) {
      const r = validateTerms({ terms_type: "consignment", consignment_our_share_percent: share, consignment_schedule: "monthly", consignment_days_to_pay: 15 });
      expect(r.ok, share).toBe(false);
    }
    const missing = validateTerms({ terms_type: "consignment", consignment_our_share_percent: "70" });
    expect(missing.ok ? [] : Object.keys(missing.errors).sort()).toEqual(["consignment_days_to_pay", "consignment_schedule"]);
    const d = validateTerms({ terms_type: "due_on_receipt", consignment_our_share_percent: "70", net_days: 30 });
    expect(d).toMatchObject({ ok: true, value: { net_days: null, consignment_our_share_percent: null } });
  });
});

describe("totals", () => {
  it("rounds line totals half up at 4-decimal prices and 3-decimal quantities", () => {
    expect(lineTotal("3", "1.2345").toFixed(2)).toBe("3.70"); // 3.7035
    expect(lineTotal("2.5", "0.3333").toFixed(2)).toBe("0.83"); // 0.83325
    expect(lineTotal("1.125", "10").toFixed(2)).toBe("11.25");
    expect(lineTotal("1", "0.005").toFixed(2)).toBe("0.01"); // half up
  });
  it("subtotal, tax on the subtotal only, delivery fee untaxed, exempt and zero tax", () => {
    const lines = [{ quantity: 2, unit_price: "10.50" }, { quantity: "1.5", unit_price: "4.3333" }];
    expect(computeTotals(lines, "15", "6", false)).toEqual({ lineTotals: ["21.00", "6.50"], subtotal: "27.50", deliveryFee: "15.00", tax: "1.65", total: "44.15" });
    expect(computeTotals(lines, "15", "6", true)).toMatchObject({ tax: "0.00", total: "42.50" });
    expect(computeTotals(lines, 0, 0, false)).toMatchObject({ tax: "0.00", total: "27.50" });
    expect(computeTotals([{ quantity: 1, unit_price: "0.01" }], 0, "7.5", false)).toMatchObject({ tax: "0.00" });
  });
  it("many lines add up exactly", () => {
    const lines = Array.from({ length: 100 }, () => ({ quantity: "0.333", unit_price: "0.3333" }));
    expect(computeTotals(lines, 0, 0, false).subtotal).toBe("11.00"); // 100 x 0.11
  });
  it("linePriceFor: MSRP on consignment, wholesale otherwise, null when not set", () => {
    const p = { wholesale_price: "6.5000", msrp: "12.9900" };
    expect(linePriceFor("consignment", p)).toBe("12.99");
    expect(linePriceFor("net", p)).toBe("6.5");
    expect(linePriceFor("prepaid", p)).toBe("6.5");
    expect(linePriceFor("consignment", { wholesale_price: "6.5", msrp: null })).toBeNull();
    expect(linePriceFor("net", { wholesale_price: null, msrp: "12" })).toBeNull();
    expect(linePriceFor("net", null)).toBeNull();
    expect(linePriceFor("net", { wholesale_price: 0, msrp: 1 })).toBe("0");
  });
  it("retailerMargin", () => {
    expect(retailerMargin("12", "6")).toBe("50.00");
    expect(retailerMargin("9.99", "5.5")).toBe("44.94");
    expect(retailerMargin(null, "5")).toBeNull();
    expect(retailerMargin("10", null)).toBeNull();
    expect(retailerMargin("0", "0")).toBeNull();
  });
});

describe("formatting", () => {
  it("money, unit prices, quantities, percentages and dates", () => {
    expect(formatMoney("1234.5")).toBe("$1,234.50");
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatUnitPrice("12.5")).toBe("$12.50");
    expect(formatUnitPrice("0.0245")).toBe("$0.0245");
    expect(formatUnitPrice("1234.1200")).toBe("$1,234.12");
    expect(formatQuantity("1250")).toBe("1,250");
    expect(formatQuantity("2.500")).toBe("2.5");
    expect(formatQuantity("0.125")).toBe("0.125");
    expect(formatPercent("70.00")).toBe("70");
    expect(formatPercent("66.67")).toBe("66.67");
    expect(formatLongDate("2026-12-15")).toBe("December 15, 2026");
    expect(todayNy(new Date("2026-11-16T03:00:00Z"))).toBe("2026-11-15");
  });
});
