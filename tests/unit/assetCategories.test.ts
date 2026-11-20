// Asset category helpers (pure): names, delete blockers, counts and rules
// with categories people add. Invented names only.
import { describe, expect, it } from "vitest";
import { categoryCounts, categoryDeleteBlocker, categoryForProducts, categoryLabel, categoryNameError, sortCategories, validateAssetCategory } from "@/lib/growth/assetCategories";

const cats = [
  { key: "other", label: "Other", sort_order: 1000, is_builtin: true },
  { key: "c_a", label: "Category A", sort_order: 60, is_builtin: false },
  { key: "product", label: "Product", sort_order: 10, is_builtin: true },
];

describe("asset categories", () => {
  it("names: required, up to 60 characters, unique ignoring case, not reserved", () => {
    expect(categoryNameError("Category B", cats)).toBeNull();
    expect(categoryNameError("  ", cats)).toBe("Enter a category name.");
    expect(categoryNameError("category a", cats)).toBe("A category with this name already exists.");
    expect(categoryNameError("x".repeat(61), cats)).toMatch(/60 characters/);
    expect(categoryNameError("all", cats)).toMatch(/reserved/);
  });

  it("a category can be deleted only when no asset (archived ones too) uses it", () => {
    const assets = [
      { category: "c_a", status: "draft" },
      { category: "c_a", status: "archived" },
      { category: "product", status: "archived" },
    ];
    expect(categoryDeleteBlocker("c_a", assets)).toBe("2 assets use this category (1 archived). Move them to another category first.");
    expect(categoryDeleteBlocker("product", assets)).toBe("1 asset uses this category (1 archived). Move it to another category first.");
    expect(categoryDeleteBlocker("other", assets)).toBeNull();
  });

  it("labels, order and counts follow the current list", () => {
    expect(sortCategories(cats).map((c) => c.label)).toEqual(["Product", "Category A", "Other"]);
    expect(categoryLabel(cats, "c_a")).toBe("Category A");
    expect(categoryLabel(cats, null)).toBe("Uncategorized");
    expect(categoryCounts([{ category: "c_a" }, { category: null }, { category: "gone" }], ["c_a", "other"])).toEqual({ all: 3, c_a: 1, other: 0, uncategorized: 2 });
  });

  it("added categories have no rules; built-in rules apply only while the key exists", () => {
    const known = cats.map((c) => c.key);
    expect(validateAssetCategory({ category: "c_a", productIds: [], ingredientIds: [], known })).toEqual({});
    expect(validateAssetCategory({ category: "product", productIds: [], ingredientIds: [], known })).toEqual({ products: "Choose exactly one product." });
    expect(validateAssetCategory({ category: "market", productIds: [], ingredientIds: [], known })).toEqual({ category: "Choose a category." });
    expect(categoryForProducts(1, known)).toBe("product");
    expect(categoryForProducts(2, known)).toBeNull(); // Group product was deleted
  });
});
