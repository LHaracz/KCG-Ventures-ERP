/**
 * Resolves an order's Shopify line items into packable components — the one
 * function every fulfillment screen uses (order detail page, Pick List,
 * Shipping Assignments, the Packaging Setup 90-day preview). It wraps the
 * existing exact-name variant_component_map lookup in salesAttribution.ts
 * (buildComponentsByLineitemName / resolveLineItemComponents) and adds the
 * product-name lookup the order detail page already did inline.
 */
import {
  buildComponentsByLineitemName,
  resolveLineItemComponents,
  type MappingComponent,
  type VariantMapRow,
} from "@/lib/salesAttribution";

export type ResolvedComponent = {
  productId: string;
  productName: string;
  qty: number;
};

export type ProductInfo = { name: string; isMicrogreen?: boolean };

export type ComponentResolver = {
  componentsByLineitemName: Map<string, MappingComponent[]>;
  productsById: Map<string, ProductInfo>;
};

export function buildComponentResolver(
  variantMap: VariantMapRow[],
  products: Array<{ id: string; name: string; is_microgreen?: boolean | null }>,
): ComponentResolver {
  return {
    componentsByLineitemName: buildComponentsByLineitemName(variantMap),
    productsById: new Map(products.map((p) => [p.id, { name: p.name, isMicrogreen: !!p.is_microgreen }])),
  };
}

export type ResolvedLineItem<T> = T & { components: ResolvedComponent[] };

export type ResolvedOrder<T> = {
  lineItems: ResolvedLineItem<T>[];
  /** Components combined by product, in first-seen order. */
  components: ResolvedComponent[];
  /** Line item names with no variant_component_map row. */
  unmappedLineItems: string[];
};

export function resolveOrderComponents<T extends { name: string; quantity: number }>(
  lineItems: T[],
  resolver: ComponentResolver,
): ResolvedOrder<T> {
  const combined = new Map<string, ResolvedComponent>();
  const unmapped: string[] = [];
  const resolved = lineItems.map((li) => {
    const mapped = resolveLineItemComponents(li.name, resolver.componentsByLineitemName);
    const components: ResolvedComponent[] = mapped.map((c) => ({
      productId: c.product_id,
      productName: resolver.productsById.get(c.product_id)?.name ?? "Unknown product",
      qty: c.qty_per_unit * li.quantity,
    }));
    if (components.length === 0) unmapped.push(li.name);
    for (const c of components) {
      const prev = combined.get(c.productId);
      if (prev) prev.qty += c.qty;
      else combined.set(c.productId, { ...c });
    }
    return { ...li, components };
  });
  return { lineItems: resolved, components: Array.from(combined.values()), unmappedLineItems: unmapped };
}

/** "{qty}x {product}" lines for pick/ship screens. */
export function componentLines(components: ResolvedComponent[]): string[] {
  return components.map((c) => `${formatQty(c.qty)}x ${c.productName}`);
}

function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100);
}
