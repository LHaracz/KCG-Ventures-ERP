// Stock alert, Procurement sort order and suggested order quantity.
// Invented raw material names only.
import { describe, expect, it } from "vitest";
import { formatQuantity, sortByStockAlert, stockAlert, suggestedQuantity } from "@/lib/procurement/stockAlert";

describe("stockAlert", () => {
  it("out of stock when on hand is 0", () => {
    expect(stockAlert(0, 10, "kg")).toEqual({ state: "out", shortBy: null, label: "Out of stock" });
  });
  it("a negative on hand counts as out", () => {
    expect(stockAlert(-2.5, 10, "kg").state).toBe("out");
  });
  it("out wins over a missing par", () => {
    expect(stockAlert(0, null, "kg").state).toBe("out");
  });
  it("no par level when par is null, 0 or negative", () => {
    for (const par of [null, undefined, 0, -1, ""]) {
      expect(stockAlert(5, par as never, "g")).toEqual({ state: "no_par", shortBy: null, label: "No par level set" });
    }
  });
  it("below par with the shortage and unit", () => {
    const a = stockAlert(3, 10, "lb");
    expect(a.state).toBe("below");
    expect(a.shortBy?.toString()).toBe("7");
    expect(a.label).toBe("Below par: short by 7 lb");
  });
  it("decimal quantities are exact", () => {
    const a = stockAlert("0.1", "0.3", "kg");
    expect(a.state).toBe("below");
    expect(a.shortBy?.toString()).toBe("0.2");
    expect(a.label).toBe("Below par: short by 0.2 kg");
    expect(stockAlert(1.25, 2, "L").label).toBe("Below par: short by 0.75 L");
  });
  it("exactly at par is OK, above par is OK", () => {
    expect(stockAlert(10, 10, "kg")).toEqual({ state: "ok", shortBy: null, label: "OK" });
    expect(stockAlert("0.3", "0.30", "kg").state).toBe("ok");
    expect(stockAlert(11, 10, "kg").state).toBe("ok");
  });
  it("no unit leaves no trailing space", () => {
    expect(stockAlert(1, 2, "").label).toBe("Below par: short by 1");
  });
});

describe("sortByStockAlert", () => {
  const rows = [
    { name: "Zinc OK", quantity_on_hand: 20, par_level: 10 },
    { name: "Apple no par", quantity_on_hand: 5, par_level: null },
    { name: "Basil out small par", quantity_on_hand: 0, par_level: 2 },
    { name: "Clove out big par", quantity_on_hand: -1, par_level: 50 },
    { name: "Aloe out big par", quantity_on_hand: 0, par_level: 50 },
    { name: "Mint below 50%", quantity_on_hand: 5, par_level: 10 },
    { name: "Sage below 10%", quantity_on_hand: 1, par_level: 10 },
    { name: "Anise below 50%", quantity_on_hand: 50, par_level: 100 },
    { name: "Beet OK", quantity_on_hand: 10, par_level: 10 },
    { name: "Yarrow no par", quantity_on_hand: 1, par_level: 0 },
  ];
  it("groups out, below, ok, no par, with the right order inside each", () => {
    expect(sortByStockAlert(rows).map((r) => r.name)).toEqual([
      "Aloe out big par",
      "Clove out big par",
      "Basil out small par",
      "Sage below 10%",
      "Anise below 50%",
      "Mint below 50%",
      "Beet OK",
      "Zinc OK",
      "Apple no par",
      "Yarrow no par",
    ]);
  });
  it("does not change the input array", () => {
    const copy = [...rows];
    sortByStockAlert(rows);
    expect(rows).toEqual(copy);
  });
});

describe("suggestedQuantity", () => {
  it("normal shortage", () => {
    expect(suggestedQuantity(3, 10)?.toString()).toBe("7");
  });
  it("out of stock suggests the full par", () => {
    expect(suggestedQuantity(0, 25)?.toString()).toBe("25");
  });
  it("negative on hand is treated as 0", () => {
    expect(suggestedQuantity(-4, 25)?.toString()).toBe("25");
  });
  it("no par returns null", () => {
    expect(suggestedQuantity(0, null)).toBeNull();
    expect(suggestedQuantity(0, 0)).toBeNull();
    expect(suggestedQuantity(0, -3)).toBeNull();
  });
  it("at or above par returns null", () => {
    expect(suggestedQuantity(10, 10)).toBeNull();
    expect(suggestedQuantity(12, 10)).toBeNull();
  });
  it("decimals round up to 3 places", () => {
    expect(suggestedQuantity("0.1", "0.3")?.toString()).toBe("0.2");
    expect(suggestedQuantity("1.0001", "2")?.toString()).toBe("1");
    expect(suggestedQuantity("1", "2.0004")?.toString()).toBe("1.001");
    expect(suggestedQuantity("0", "0.0001")?.toString()).toBe("0.001");
  });
});

describe("formatQuantity", () => {
  it("drops trailing zeros", () => {
    expect(formatQuantity("12.500")).toBe("12.5");
    expect(formatQuantity(3)).toBe("3");
    expect(formatQuantity("100")).toBe("100");
    expect(formatQuantity(null)).toBe("");
  });
});
