// Shared line-item -> product/business resolution for Sales Data-derived
// pages. Line items resolve to product(s)/business by EXACT string match on
// lineitem_name against variant_component_map (never fuzzy/auto-parsed),
// matching the convention established in src/lib/salesImport.ts.
//
// Extracted from src/app/sales-data/page.tsx (componentsByLineitemName /
// businessByLineitemName / the per-order business-tag reducer) so the Stats
// page can reuse the identical logic instead of re-deriving it.

export type MappingComponent = { product_id: string; qty_per_unit: number };

export type VariantMapRow = {
  lineitem_name: string;
  business: "minileaf" | "botaniqals";
  components: MappingComponent[];
};

export type BusinessTag = "botaniqals" | "minileaf" | "Mixed" | "Unmapped";

export function buildComponentsByLineitemName(
  variantMap: VariantMapRow[],
): Map<string, MappingComponent[]> {
  const map = new Map<string, MappingComponent[]>();
  for (const m of variantMap) map.set(m.lineitem_name, m.components || []);
  return map;
}

export function buildBusinessByLineitemName(
  variantMap: VariantMapRow[],
): Map<string, "minileaf" | "botaniqals"> {
  const map = new Map<string, "minileaf" | "botaniqals">();
  for (const m of variantMap) map.set(m.lineitem_name, m.business);
  return map;
}

// A single line item's business, or null if it has no variant_component_map
// row yet (unmapped).
export function resolveLineItemBusiness(
  lineitemName: string,
  businessByLineitemName: Map<string, "minileaf" | "botaniqals">,
): "minileaf" | "botaniqals" | null {
  return businessByLineitemName.get(lineitemName) ?? null;
}

export function resolveLineItemComponents(
  lineitemName: string,
  componentsByLineitemName: Map<string, MappingComponent[]>,
): MappingComponent[] {
  return componentsByLineitemName.get(lineitemName) ?? [];
}

// An order's overall business tag from its line items' resolved businesses:
// no line items, or none mapped -> "Unmapped"; every mapped line item
// agrees on one business AND none are unmapped -> that business;
// otherwise (multiple businesses present, or a mix of mapped + unmapped)
// -> "Mixed". Matches src/app/sales-data/page.tsx's businessTagByOrderId
// reducer exactly.
export function resolveOrderBusinessTag(
  lineitemNames: string[],
  businessByLineitemName: Map<string, "minileaf" | "botaniqals">,
): BusinessTag {
  if (lineitemNames.length === 0) return "Unmapped";
  const businesses = new Set<string>();
  let hasUnmapped = false;
  for (const name of lineitemNames) {
    const business = businessByLineitemName.get(name);
    if (!business) {
      hasUnmapped = true;
    } else {
      businesses.add(business);
    }
  }
  if (businesses.size === 0) return "Unmapped";
  if (businesses.size === 1 && !hasUnmapped) return Array.from(businesses)[0] as BusinessTag;
  return "Mixed";
}
