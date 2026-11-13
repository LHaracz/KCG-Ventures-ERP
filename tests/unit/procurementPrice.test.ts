// Listing prices: formatPrice, parsePrice and the PO unit price string.
import { describe, expect, it } from "vitest";
import { formatPrice, parsePrice, priceForPoLine } from "@/lib/procurement/price";

describe("formatPrice", () => {
  it("whole numbers get 2 decimals", () => {
    expect(formatPrice(12)).toBe("$12.00");
    expect(formatPrice("5")).toBe("$5.00");
  });
  it("2 decimals", () => {
    expect(formatPrice(1299.5)).toBe("$1,299.50");
    expect(formatPrice("0.10")).toBe("$0.10");
  });
  it("up to 4 decimals, trailing zeros past the second trimmed", () => {
    expect(formatPrice(0.0245)).toBe("$0.0245");
    expect(formatPrice("1.2340")).toBe("$1.234");
    expect(formatPrice("12.3400")).toBe("$12.34");
    expect(formatPrice("0.00005")).toBe("$0.0001");
  });
  it("large values get thousands separators", () => {
    expect(formatPrice("1234567.891")).toBe("$1,234,567.891");
    expect(formatPrice("9999999999.9999")).toBe("$9,999,999,999.9999");
  });
  it("adds the note", () => {
    expect(formatPrice("48.5", "per 25 kg bag")).toBe("$48.50 per 25 kg bag");
    expect(formatPrice(3, "  each ")).toBe("$3.00 each");
    expect(formatPrice(3, "")).toBe("$3.00");
  });
  it("null or bad values give an empty string, note or not", () => {
    expect(formatPrice(null)).toBe("");
    expect(formatPrice(undefined, "each")).toBe("");
    expect(formatPrice("abc")).toBe("");
  });
});

describe("parsePrice", () => {
  it("blank is no price", () => {
    expect(parsePrice("")).toEqual({ ok: true, value: null });
    expect(parsePrice("  ")).toEqual({ ok: true, value: null });
    expect(parsePrice(null)).toEqual({ ok: true, value: null });
  });
  it("accepts positive numbers with at most 4 decimals, $ and commas", () => {
    expect(parsePrice("12.5")).toEqual({ ok: true, value: "12.5" });
    expect(parsePrice("$1,299.50")).toEqual({ ok: true, value: "1299.5" });
    expect(parsePrice("0.0245")).toEqual({ ok: true, value: "0.0245" });
    expect(parsePrice(7)).toEqual({ ok: true, value: "7" });
  });
  it("rejects zero, negatives, text, too many decimals and too large", () => {
    for (const bad of ["0", "0.0000", "-1", "abc", "1e3", "1.23456", "12345678901", "1.2.3"]) {
      expect(parsePrice(bad).ok, bad).toBe(false);
    }
  });
});

describe("priceForPoLine", () => {
  it("is a plain number string, or blank", () => {
    expect(priceForPoLine("1299.5000")).toBe("1299.5");
    expect(priceForPoLine(null)).toBe("");
  });
});
