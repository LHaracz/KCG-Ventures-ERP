/**
 * Asset categories and tags (pure, tested): validation per category, asset
 * suggestions for a library item's need, and category counts.
 */
import type { AssetNeed } from "./adLibrary";
import { productKeyForName } from "./playbookParse";

export const ASSET_CATEGORIES = ["product", "group_product", "ingredient", "market", "retail", "other"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<AssetCategory | "uncategorized", string> = {
  product: "Product",
  group_product: "Group product",
  ingredient: "Ingredient",
  market: "Markets",
  retail: "Retail",
  other: "Other",
  uncategorized: "Uncategorized",
};

export function validateAssetCategory(v: {
  category: string | null | undefined;
  productIds: readonly string[];
  ingredientIds: readonly string[];
  isFullLineup?: boolean | null;
  contextLabel?: string | null;
  requireCategory?: boolean;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  const c = v.category ?? "";
  if (!c) {
    if (v.requireCategory !== false) errors.category = "Choose a category.";
    return errors;
  }
  if (!(ASSET_CATEGORIES as readonly string[]).includes(c)) {
    errors.category = "Choose a category.";
    return errors;
  }
  if (c === "product" && v.productIds.length !== 1) errors.products = "Choose exactly one product.";
  if (c === "group_product" && v.productIds.length < 2 && !v.isFullLineup) errors.products = "Choose two or more products, or tick Full lineup.";
  if (c === "ingredient" && v.ingredientIds.length < 1) errors.ingredients = "Choose at least one ingredient tag.";
  if (c === "other" && !(v.contextLabel ?? "").trim()) errors.context_label = "Describe what this is.";
  if ((v.contextLabel ?? "").length > 200) errors.context_label = "Keep the label under 200 characters.";
  return errors;
}

export type SuggestAsset = {
  id: string;
  asset_type: string;
  status: string;
  created_at: string;
  product_names: readonly string[];
};
const TYPES_FOR_KIND: Record<AssetNeed["kind"], readonly string[]> = {
  photo: ["photo"],
  video: ["video"],
  graphic: ["template", "logo", "other"],
  other: [],
};

/** Ranks assets for a need: product match first, then a matching type, then newest. Archived assets are left out. */
export function suggestAssetsForNeed<T extends SuggestAsset>(need: Pick<AssetNeed, "kind">, item: { products_mentioned?: readonly string[] | null }, assets: readonly T[]): T[] {
  const wanted = new Set(item.products_mentioned ?? []);
  const score = (a: T) => {
    const prod = a.product_names.some((n) => {
      const k = productKeyForName(n);
      return !!k && wanted.has(k);
    });
    const type = TYPES_FOR_KIND[need.kind].includes(a.asset_type);
    return (prod ? 2 : 0) + (type ? 1 : 0);
  };
  return assets
    .filter((a) => a.status !== "archived")
    .map((a) => ({ a, s: score(a) }))
    .sort((x, y) => y.s - x.s || (x.a.created_at < y.a.created_at ? 1 : x.a.created_at > y.a.created_at ? -1 : 0))
    .map((x) => x.a);
}

export function categoryCounts(assets: ReadonlyArray<{ category: string | null }>): Record<AssetCategory | "uncategorized" | "all", number> {
  const out = { all: 0, product: 0, group_product: 0, ingredient: 0, market: 0, retail: 0, other: 0, uncategorized: 0 };
  for (const a of assets) {
    out.all += 1;
    const c = a.category && (ASSET_CATEGORIES as readonly string[]).includes(a.category) ? (a.category as AssetCategory) : "uncategorized";
    out[c] += 1;
  }
  return out;
}

/** Category prefilled for "Upload and attach" from the item's products: one -> Product, several -> Group product, none -> no default. */
export const categoryForProducts = (n: number): AssetCategory | null => (n === 1 ? "product" : n > 1 ? "group_product" : null);
