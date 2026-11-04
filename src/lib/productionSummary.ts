/**
 * Numbers for the read-only View Production page. Uses the cycle's
 * completion snapshot when there is one; for productions completed before
 * snapshots existed it recomputes from current Products & BOM and raw
 * material prices, with the same math as the cycle planner (BOM
 * qty_per_unit x quantity x cost_per_unit).
 */

export type SummaryIngredient = {
  product: string;
  ingredient: string;
  unit: string;
  qtyUsed: number;
  costPerUnit: number;
  lineCost: number;
};

export type SummaryProduct = {
  productId: string;
  name: string;
  targetQty: number;
  actualQty: number;
  salePricePerUnit: number | null;
  cost: number;
};

export type ProductionSummary = {
  basis: "snapshot" | "current_prices";
  products: SummaryProduct[];
  ingredients: SummaryIngredient[];
  totalIngredientCost: number;
  totalActualQty: number;
  costPerUnit: number | null;
  potentialRevenue: number;
  grossProfit: number;
  marginPct: number | null;
};

type Snapshot = {
  lines: Array<{ product_id?: string; product?: string | null; ingredient: string; unit: string; qty_used: number; cost_per_unit: number; line_cost: number }>;
  total_cost: number | string;
  sale_price_per_unit: number | string | null;
  actual_quantities: Record<string, number>;
  per_product: Array<{ product_id: string; name: string | null; qty: number; sale_price_per_unit: number | null; cost: number }>;
};

export function buildProductionSummary(params: {
  targets: Array<{ product: string | null; quantity_to_produce?: number | null; target_units?: number | null }>;
  products: Array<{ id: string; name: string; sale_price_per_unit: number | string | null }>;
  actualByProductId: Map<string, number>;
  snapshot: Snapshot | null;
  bomLines: Array<{ product: string; inventory_item: string | null; qty_per_unit: number | string | null; unit_label: string | null }>;
  items: Array<{ id: string; name: string; unit: string | null; cost_per_unit: number | string | null }>;
}): ProductionSummary {
  const productById = new Map(params.products.map((p) => [p.id, p]));
  const targetByProduct = new Map<string, number>();
  for (const t of params.targets) {
    if (!t.product) continue;
    targetByProduct.set(t.product, (targetByProduct.get(t.product) ?? 0) + (Number(t.quantity_to_produce ?? t.target_units ?? 0) || 0));
  }
  const productIds = Array.from(new Set([...targetByProduct.keys(), ...params.actualByProductId.keys()]));
  const snap = params.snapshot;

  let products: SummaryProduct[];
  let ingredients: SummaryIngredient[];
  if (snap) {
    const perProduct = new Map((snap.per_product ?? []).map((p) => [p.product_id, p]));
    products = productIds.map((id) => {
      const pp = perProduct.get(id);
      return {
        productId: id,
        name: pp?.name ?? productById.get(id)?.name ?? "Unknown product",
        targetQty: targetByProduct.get(id) ?? 0,
        actualQty: Number(snap.actual_quantities?.[id] ?? params.actualByProductId.get(id) ?? 0),
        salePricePerUnit:
          pp?.sale_price_per_unit != null
            ? Number(pp.sale_price_per_unit)
            : productIds.length === 1 && snap.sale_price_per_unit != null
              ? Number(snap.sale_price_per_unit)
              : null,
        cost: Number(pp?.cost ?? 0),
      };
    });
    ingredients = (snap.lines ?? []).map((l) => ({
      product: l.product ?? productById.get(l.product_id ?? "")?.name ?? "",
      ingredient: l.ingredient,
      unit: l.unit,
      qtyUsed: Number(l.qty_used),
      costPerUnit: Number(l.cost_per_unit),
      lineCost: Number(l.line_cost),
    }));
  } else {
    const itemsById = new Map(params.items.map((i) => [i.id, i]));
    ingredients = [];
    products = productIds.map((id) => {
      const actual = params.actualByProductId.get(id) ?? 0;
      let cost = 0;
      for (const line of params.bomLines) {
        if (line.product !== id || !line.inventory_item) continue;
        const item = itemsById.get(line.inventory_item);
        if (!item) continue;
        const qtyUsed = actual * Number(line.qty_per_unit || 0);
        const costPerUnit = Number(item.cost_per_unit || 0);
        cost += qtyUsed * costPerUnit;
        ingredients.push({
          product: productById.get(id)?.name ?? "",
          ingredient: item.name,
          unit: line.unit_label || item.unit || "",
          qtyUsed,
          costPerUnit,
          lineCost: qtyUsed * costPerUnit,
        });
      }
      const price = productById.get(id)?.sale_price_per_unit;
      return {
        productId: id,
        name: productById.get(id)?.name ?? "Unknown product",
        targetQty: targetByProduct.get(id) ?? 0,
        actualQty: actual,
        salePricePerUnit: price == null ? null : Number(price),
        cost,
      };
    });
  }

  const totalIngredientCost = snap ? Number(snap.total_cost ?? 0) : products.reduce((s, p) => s + p.cost, 0);
  const totalActualQty = products.reduce((s, p) => s + p.actualQty, 0);
  const potentialRevenue = products.reduce((s, p) => s + p.actualQty * (p.salePricePerUnit ?? 0), 0);
  const grossProfit = potentialRevenue - totalIngredientCost;
  return {
    basis: snap ? "snapshot" : "current_prices",
    products,
    ingredients,
    totalIngredientCost,
    totalActualQty,
    costPerUnit: totalActualQty > 0 ? totalIngredientCost / totalActualQty : null,
    potentialRevenue,
    grossProfit,
    marginPct: potentialRevenue > 0 ? (grossProfit / potentialRevenue) * 100 : null,
  };
}
