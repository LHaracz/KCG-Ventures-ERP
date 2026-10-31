// Invented fixtures only. No real ingredient names or formula amounts.
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  FORMULA_TABLE_COLUMNS,
  buildFormulaTable,
  cellDisplay,
  columnHeader,
  formatQuantity,
  isMassUnit,
} from "@/lib/formulaTable";

const fixtures = [
  { name: "Ingredient A", unit: "g", qtyPerUnit: "12.5" },
  { name: "Ingredient B", unit: "g", qtyPerUnit: "0.04" },
  { name: "Ingredient C", unit: "g", qtyPerUnit: "3.125" },
  { name: "Ingredient D", unit: "kg", qtyPerUnit: "0.002" },
  { name: "Ingredient E", unit: "g", qtyPerUnit: "0.0004" },
  { name: "Ingredient F", unit: "each", qtyPerUnit: "2" },
];
const table = buildFormulaTable(fixtures);
const cell = (name: string, n: number) => cellDisplay(table, name, n);

describe("formula table columns", () => {
  it("uses 1, 20, 40 ... 200 with unit headers", () => {
    expect(FORMULA_TABLE_COLUMNS).toEqual([1, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200]);
    expect(table.columns.map((c) => c.header)).toEqual([
      "1 unit", "20 units", "40 units", "60 units", "80 units", "100 units",
      "120 units", "140 units", "160 units", "180 units", "200 units",
    ]);
    expect(columnHeader(1)).toBe("1 unit");
  });
  it("keeps the formula's line order", () => {
    expect(table.rows.map((r) => r.name)).toEqual(fixtures.map((f) => f.name));
  });
});

describe("expected values", () => {
  it("Ingredient A", () => {
    expect(cell("Ingredient A", 1)).toBe("12.5");
    expect(cell("Ingredient A", 20)).toBe("250");
    expect(cell("Ingredient A", 40)).toBe("500");
    expect(cell("Ingredient A", 80)).toBe("1,000");
    expect(cell("Ingredient A", 200)).toBe("2,500");
  });
  it("Ingredient B", () => {
    expect(cell("Ingredient B", 1)).toBe("0.04");
    expect(cell("Ingredient B", 20)).toBe("0.8");
    expect(cell("Ingredient B", 40)).toBe("1.6");
    expect(cell("Ingredient B", 60)).toBe("2.4");
    expect(cell("Ingredient B", 200)).toBe("8");
  });
  it("Ingredient C", () => {
    expect(cell("Ingredient C", 20)).toBe("62.5");
    expect(cell("Ingredient C", 40)).toBe("125");
    expect(cell("Ingredient C", 80)).toBe("250");
  });
  it("Ingredient D converts kg to grams", () => {
    expect(cell("Ingredient D", 1)).toBe("2");
    expect(cell("Ingredient D", 20)).toBe("40");
    expect(cell("Ingredient D", 200)).toBe("400");
    expect(table.rows[3].displayUnit).toBe("g");
  });
  it("Ingredient E shows more decimals for tiny values", () => {
    expect(cell("Ingredient E", 1)).toBe("0.0004");
    expect(cell("Ingredient E", 20)).toBe("0.008");
    expect(cell("Ingredient E", 200)).toBe("0.08");
  });
  it("Ingredient F keeps its non-mass unit", () => {
    expect(cell("Ingredient F", 1)).toBe("2 each");
    expect(cell("Ingredient F", 20)).toBe("40 each");
    expect(table.rows[5].label).toBe("Ingredient F (each)");
    expect(table.rows[5].isMass).toBe(false);
  });
});

describe("conversion and formatting details", () => {
  it("converts lb and oz exactly", () => {
    const t = buildFormulaTable([
      { name: "Ingredient G", unit: "lb", qtyPerUnit: "1" },
      { name: "Ingredient H", unit: "oz", qtyPerUnit: "1" },
    ]);
    expect(cellDisplay(t, "Ingredient G", 1)).toBe("453.592");
    expect(cellDisplay(t, "Ingredient H", 1)).toBe("28.35");
    expect(t.rows[1].cells[0].exact).toBe("28.349523125");
  });
  it("never multiplies a rounded value", () => {
    // 0.0012345 g rounds to 0.00123 for 1 unit, but 200 units is exactly 0.2469.
    const t = buildFormulaTable([{ name: "Ingredient I", unit: "g", qtyPerUnit: "0.0012345" }]);
    expect(cellDisplay(t, "Ingredient I", 1)).toBe("0.001");
    expect(cellDisplay(t, "Ingredient I", 200)).toBe("0.247");
    expect(t.rows[0].cells.find((c) => c.count === 200)!.exact).toBe("0.2469");
  });
  it("avoids float error", () => {
    const t = buildFormulaTable([{ name: "Ingredient J", unit: "g", qtyPerUnit: "0.1" }]);
    expect(t.rows[0].cells.find((c) => c.count === 60)!.exact).toBe("6");
  });
  it("fl oz is not treated as mass", () => {
    expect(isMassUnit("fl oz")).toBe(false);
    expect(isMassUnit(" KG ")).toBe(true);
  });
  it("formats zero, huge and too-small values", () => {
    expect(formatQuantity(new Decimal(0))).toBe("0");
    expect(formatQuantity(new Decimal("1234567.8901"))).toBe("1,234,567.89");
    expect(formatQuantity(new Decimal("0.000001"))).toBe("<0.00001");
  });
  it("marks unparseable quantities invalid without throwing", () => {
    const t = buildFormulaTable([{ name: "Ingredient K", unit: "g", qtyPerUnit: "abc" }]);
    expect(t.rows[0].valid).toBe(false);
    expect(t.rows[0].cells[0].display).toBe("—");
  });
});
