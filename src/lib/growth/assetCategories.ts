/**
 * Asset categories and tags (pure, tested): validation per category, asset
 * suggestions for a library item's need, and category counts.
 *
 * Categories live in the asset_categories table: six built-ins (which keep
 * their rules below while they exist) plus any that people add. Added
 * categories have no rules. Any category can be deleted once no asset uses it.
 */
import type { AssetNeed } from "./adLibrary";
import { productKeyForName } from "./playbookParse";

/** The built-in keys (seeded by asset_categories.sql). The rules in validateAssetCategory apply to these keys. */
export const ASSET_CATEGORIES = ["product", "group_product", "ingredient", "market", "retail", "other"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/** One row of asset_categories. */
export type AssetCategoryRow = { key: string; label: string; sort_order: number; is_builtin: boolean };

export const CATEGORY_LABEL_MAX = 60;

/** The label to show for an asset's category ("Uncategorized" when it has none). */
export function categoryLabel(categories: ReadonlyArray<Pick<AssetCategoryRow, "key" | "label">>, key: string | null | undefined): string {
  if (!key) return "Uncategorized";
  return categories.find((c) => c.key === key)?.label ?? "Uncategorized";
}

/** Categories in display order. */
export const sortCategories = <T extends Pick<AssetCategoryRow, "sort_order" | "label">>(cats: readonly T[]): T[] =>
  [...cats].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));

/** Null when a new category name is fine; else the message. Names are unique ignoring case and spaces. */
export function categoryNameError(name: string, existing: ReadonlyArray<{ label: string }>): string | null {
  const t = name.trim().replace(/\s+/g, " ");
  if (!t) return "Enter a category name.";
  if (t.length > CATEGORY_LABEL_MAX) return `Keep the name to ${CATEGORY_LABEL_MAX} characters or fewer.`;
  if (t.toLowerCase() === "uncategorized" || t.toLowerCase() === "all") return "That name is reserved. Choose another.";
  if (existing.some((c) => c.label.trim().toLowerCase() === t.toLowerCase())) return "A category with this name already exists.";
  return null;
}

/** Why a category can't be deleted yet, or null when it can (no asset uses it, archived ones included). */
export function categoryDeleteBlocker(key: string, assets: ReadonlyArray<{ category: string | null; status: string }>): string | null {
  const used = assets.filter((a) => a.category === key);
  if (used.length === 0) return null;
  const archived = used.filter((a) => a.status === "archived").length;
  const n = `${used.length} asset${used.length === 1 ? " uses" : "s use"} this category`;
  return `${n}${archived ? ` (${archived} archived)` : ""}. Move ${used.length === 1 ? "it" : "them"} to another category first.`;
}

export function validateAssetCategory(v: {
  category: string | null | undefined;
  productIds: readonly string[];
  ingredientIds: readonly string[];
  isFullLineup?: boolean | null;
  contextLabel?: string | null;
  requireCategory?: boolean;
  /** The category keys that exist now (asset_categories). Defaults to the built-ins. */
  known?: readonly string[];
}): Record<string, string> {
  const errors: Record<string, string> = {};
  const c = v.category ?? "";
  if (!c) {
    if (v.requireCategory !== false) errors.category = "Choose a category.";
    return errors;
  }
  if (!(v.known ?? ASSET_CATEGORIES).includes(c)) {
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

/** Counts per category key, plus "all" and "uncategorized" (no category, or one that no longer exists). */
export function categoryCounts(assets: ReadonlyArray<{ category: string | null }>, keys: readonly string[] = ASSET_CATEGORIES): Record<string, number> {
  const out: Record<string, number> = { all: 0, uncategorized: 0 };
  for (const k of keys) out[k] = 0;
  for (const a of assets) {
    out.all += 1;
    const c = a.category && keys.includes(a.category) ? a.category : "uncategorized";
    out[c] += 1;
  }
  return out;
}

/**
 * Category prefilled for "Upload and attach" from the item's products:
 * one -> Product, several -> Group product, none -> no default. Only when
 * that category still exists.
 */
export const categoryForProducts = (n: number, keys: readonly string[] = ASSET_CATEGORIES): string | null => {
  const k = n === 1 ? "product" : n > 1 ? "group_product" : null;
  return k && keys.includes(k) ? k : null;
};
