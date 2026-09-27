// Splits a multi-component line item's revenue across its components for
// the Stats page's product-level charts/table, and detects whether an
// order contains a configured "bundle" line item for the Bundle Attach
// Rate KPI. Bundle identification is settings-driven (bundle_settings.
// bundle_lineitem_names, edited on the Stats page) rather than hardcoded,
// so it survives a Shopify variant rename without a code change.

export type MappingComponent = { product_id: string; qty_per_unit: number };

export type ProductPriceInfo = { sale_price_per_unit: number | null };

export type ComponentRevenueSplit = {
  product_id: string;
  units: number;
  revenue: number;
};

// Revenue is split proportionally to each component's own list-price
// contribution (qty_per_unit * sale_price_per_unit) — e.g. a $40 bundle
// with an $18 component and a $12 component and a $10 component splits
// ~45%/30%/25%, so a bundle discount is spread fairly across products
// rather than crediting one product with the whole line item's revenue.
// Falls back to an even split across components when none of them have a
// usable sale_price_per_unit. Units always reflect each component's real
// per-unit count (qty_per_unit * quantity), unaffected by this split — the
// splits' revenue always sums back to exactly the line item's total
// revenue (price * quantity).
export function splitLineItemRevenueByComponents(
  lineItem: { price: number | null; quantity: number },
  components: MappingComponent[],
  productsById: Map<string, ProductPriceInfo>,
): ComponentRevenueSplit[] {
  if (components.length === 0) return [];
  const totalRevenue = (lineItem.price ?? 0) * lineItem.quantity;

  const weighted = components.map((component) => {
    const price = productsById.get(component.product_id)?.sale_price_per_unit;
    const weight = price && price > 0 ? component.qty_per_unit * price : 0;
    return { component, weight };
  });
  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);

  return weighted.map(({ component, weight }) => {
    const share = totalWeight > 0 ? weight / totalWeight : 1 / components.length;
    return {
      product_id: component.product_id,
      units: component.qty_per_unit * lineItem.quantity,
      revenue: totalRevenue * share,
    };
  });
}

// An order "contains the bundle" if any of its line items' lineitem_name is
// an exact match against the configured list. Returns false (never "the
// order might contain it") when bundle_settings hasn't been configured yet
// — the Stats page shows "—" for Bundle Attach Rate in that case rather
// than a misleading 0%.
export function orderContainsBundle(
  orderLineItemNames: string[],
  bundleLineitemNames: string[],
): boolean {
  if (bundleLineitemNames.length === 0) return false;
  const bundleSet = new Set(bundleLineitemNames);
  return orderLineItemNames.some((name) => bundleSet.has(name));
}
