// Splits a multi-component line item's revenue across its components for
// the Stats page's product-level charts/table, and detects whether an
// order contains a "bundle" line item for the Bundle Attach Rate KPI.
// Bundle detection is derived automatically from variant_component_map: a
// line item is a bundle if its mapped components array names more than one
// distinct product_id. No manual configuration needed — it stays correct
// as variant mappings change.

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

// A line item is "a bundle" if variant_component_map resolves it to more
// than one distinct product_id (a single-product line item, even at
// qty_per_unit > 1, is not a bundle — it's just one product).
export function lineItemIsBundle(
  lineitemName: string,
  componentsByLineitemName: Map<string, MappingComponent[]>,
): boolean {
  const components = componentsByLineitemName.get(lineitemName) ?? [];
  const distinctProductIds = new Set(components.map((c) => c.product_id));
  return distinctProductIds.size > 1;
}

// An order "contains a bundle" if any of its line items resolve to a
// multi-product components array.
export function orderContainsBundle(
  orderLineItemNames: string[],
  componentsByLineitemName: Map<string, MappingComponent[]>,
): boolean {
  return orderLineItemNames.some((name) => lineItemIsBundle(name, componentsByLineitemName));
}
