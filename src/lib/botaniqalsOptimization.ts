import solver, { type Model, type SolveResult } from "javascript-lp-solver";

/**
 * BotanIQals Optimization — demand/target/LP calculation engine.
 *
 * Pure functions operating on already-fetched Supabase rows, called from
 * src/app/production-optimization/page.tsx (client-side, matching this
 * app's established "fetch everything client-side, compute client-side"
 * convention — see src/lib/feasibility.ts for the precedent; no API route
 * or service-role access is needed for this feature).
 *
 * Scope: BotanIQals only (products.is_microgreen = false). unit_cost and
 * raw-material constraints only consider bom_lines with
 * line_type IN ('inventory_item', 'packaging') and a non-null
 * inventory_item — raw_microgreen/dried_microgreen BOM lines (freeze-dried
 * microgreen usage) live in a different domain (freeze-dry production
 * capacity, not an "on-hand quantity") and are out of scope for this
 * feature; only the Raw Materials page's inventory_items are named as a
 * data source in the spec.
 */

export type Objective =
  | "maximize_revenue"
  | "maximize_profit"
  | "minimize_unmet_demand"
  | "maximize_equitable_fill_rate";

export const OBJECTIVES: Objective[] = [
  "maximize_revenue",
  "maximize_profit",
  "minimize_unmet_demand",
  "maximize_equitable_fill_rate",
];

export const OBJECTIVE_LABELS: Record<Objective, string> = {
  maximize_revenue: "Maximize Revenue",
  maximize_profit: "Maximize Profit",
  minimize_unmet_demand: "Minimize Unmet Demand",
  maximize_equitable_fill_rate: "Maximize Equitable Fill Rate",
};

export type CalibrationFields = {
  trailing_window_days: number;
  safety_stock_qty: number;
  min_buffer_qty: number;
  lead_time_days: number;
};

export const DEFAULT_CALIBRATION: CalibrationFields = {
  trailing_window_days: 30,
  safety_stock_qty: 0,
  min_buffer_qty: 0,
  lead_time_days: 0,
};

export type CalibrationOverrideRow = {
  product_id: string;
  trailing_window_days: number | null;
  safety_stock_qty: number | null;
  min_buffer_qty: number | null;
  lead_time_days: number | null;
};

/** Per-field override-or-global-default merge. A field of 0 on an override
 * row is a real override (not "unset") — only null/undefined fall back. */
export function resolveEffectiveSettings(
  productId: string,
  global: CalibrationFields,
  overridesByProductId: Map<string, CalibrationOverrideRow>,
): CalibrationFields {
  const o = overridesByProductId.get(productId);
  return {
    trailing_window_days: o?.trailing_window_days ?? global.trailing_window_days,
    safety_stock_qty: o?.safety_stock_qty ?? global.safety_stock_qty,
    min_buffer_qty: o?.min_buffer_qty ?? global.min_buffer_qty,
    lead_time_days: o?.lead_time_days ?? global.lead_time_days,
  };
}

export type ProductRow = {
  id: string;
  name: string;
  sale_price_per_unit: number | null;
};

export type BomLineRow = {
  product: string;
  line_type: string;
  inventory_item: string | null;
  qty_per_unit: number | null;
};

export type InventoryItemRow = {
  id: string;
  name: string;
  unit: string;
  cost_per_unit: number | null;
  quantity_on_hand: number | null;
};

/** Raw-material BOM lines only: inventory_item/packaging with a resolved inventory_item. */
function materialBomLinesForProduct(productId: string, bomLines: BomLineRow[]): BomLineRow[] {
  return bomLines.filter(
    (b) =>
      b.product === productId &&
      (b.line_type === "inventory_item" || b.line_type === "packaging") &&
      !!b.inventory_item,
  );
}

/** unit_cost = Σ(ingredient qty-per-unit × ingredient's current cost) over a product's raw-material BOM lines. */
export function computeUnitCost(
  productId: string,
  bomLines: BomLineRow[],
  inventoryItemsById: Map<string, InventoryItemRow>,
): number {
  let total = 0;
  for (const line of materialBomLinesForProduct(productId, bomLines)) {
    const item = inventoryItemsById.get(line.inventory_item as string);
    if (!item) continue;
    total += Number(line.qty_per_unit || 0) * Number(item.cost_per_unit || 0);
  }
  return total;
}

export type OrderRow = { id: string; created_at: string };
export type OrderLineItemRow = { order_id: string; lineitem_name: string; quantity: number };
export type MappingComponent = { product_id: string; qty_per_unit: number };
export type VariantMappingRow = { lineitem_name: string; components: MappingComponent[] };

export type DemandRatesByProduct = Map<string, number>; // product_id -> daily_demand_rate

/**
 * Sum quantity sold (resolved through variant_component_map, the same way
 * src/lib/salesImport.ts resolves Shopify line items to components) over
 * each product's own trailing window, divided into a daily rate. Windows
 * can differ per product (per-product overrides), so this takes every
 * order/line-item within the *widest* window the caller fetched and applies
 * each product's own narrower cutoff here.
 */
export function computeDemandRates(params: {
  products: ProductRow[];
  orders: OrderRow[];
  orderLineItems: OrderLineItemRow[];
  variantComponentMap: VariantMappingRow[];
  effectiveSettingsByProduct: Map<string, CalibrationFields>;
  now: Date;
}): DemandRatesByProduct {
  const { products, orders, orderLineItems, variantComponentMap, effectiveSettingsByProduct, now } = params;

  const mappingByName = new Map<string, MappingComponent[]>(
    variantComponentMap.map((r) => [r.lineitem_name, r.components || []]),
  );
  const orderCreatedAtById = new Map(orders.map((o) => [o.id, o.created_at]));
  const productIds = new Set(products.map((p) => p.id));

  // Sold quantity per product, each tagged with its order's date, so every
  // product can apply its own trailing-window cutoff below.
  const soldEvents = new Map<string, Array<{ createdAt: string; qty: number }>>();

  for (const li of orderLineItems) {
    const createdAt = orderCreatedAtById.get(li.order_id);
    if (!createdAt) continue;
    const components = mappingByName.get(li.lineitem_name);
    if (!components) continue;
    for (const c of components) {
      if (!productIds.has(c.product_id)) continue; // not a BotanIQals product (e.g. MiniLeaf component)
      const qty = Number(c.qty_per_unit || 0) * Number(li.quantity || 0);
      if (!qty) continue;
      const list = soldEvents.get(c.product_id) ?? [];
      list.push({ createdAt, qty });
      soldEvents.set(c.product_id, list);
    }
  }

  const rates: DemandRatesByProduct = new Map();
  for (const product of products) {
    const settings = effectiveSettingsByProduct.get(product.id) ?? DEFAULT_CALIBRATION;
    const windowDays = Math.max(1, Number(settings.trailing_window_days));
    const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const events = soldEvents.get(product.id) ?? [];
    const totalQty = events
      .filter((e) => new Date(e.createdAt) >= cutoff)
      .reduce((sum, e) => sum + e.qty, 0);
    rates.set(product.id, totalQty / windowDays);
  }
  return rates;
}

export type TargetRow = {
  productId: string;
  dailyDemandRate: number;
  currentOnHandQty: number;
  targetQty: number;
  effectiveSettings: CalibrationFields;
};

/**
 * target_qty = max(0, daily_demand_rate × lead_time_days + safety_stock_qty
 * + min_buffer_qty − current_on_hand_qty). Products where this is 0 are
 * left in the returned array (targetQty: 0) — the caller filters those out
 * before building the LP ("exclude from the plan"), keeping this function
 * a pure per-product calculation.
 */
export function computeTargetQuantities(params: {
  products: ProductRow[];
  demandRates: DemandRatesByProduct;
  onHandByProduct: Map<string, number>;
  effectiveSettingsByProduct: Map<string, CalibrationFields>;
}): TargetRow[] {
  const { products, demandRates, onHandByProduct, effectiveSettingsByProduct } = params;
  return products.map((product) => {
    const effectiveSettings = effectiveSettingsByProduct.get(product.id) ?? DEFAULT_CALIBRATION;
    const dailyDemandRate = demandRates.get(product.id) ?? 0;
    const currentOnHandQty = onHandByProduct.get(product.id) ?? 0;
    const projected = dailyDemandRate * effectiveSettings.lead_time_days;
    const targetQty = Math.max(
      0,
      projected + effectiveSettings.safety_stock_qty + effectiveSettings.min_buffer_qty - currentOnHandQty,
    );
    return { productId: product.id, dailyDemandRate, currentOnHandQty, targetQty, effectiveSettings };
  });
}

export type OptimizationResultRow = TargetRow & {
  productName: string;
  unitCost: number;
  salePrice: number;
  recommendedQty: number;
  fillRatePct: number;
  projectedRevenue: number;
  projectedProfit: number;
  limitingRawMaterial: string | null;
};

export type OptimizationSummary = {
  objective: Objective;
  totalRecommendedUnits: number;
  totalProjectedRevenue: number;
  totalProjectedProfit: number;
  rows: OptimizationResultRow[];
};

const EPSILON = 1e-6;

function recVar(productId: string): string {
  return `rec_${productId}`;
}

function fairnessConstraint(productId: string): string {
  return `fairness_${productId}`;
}

function capConstraint(productId: string): string {
  return `cap_${productId}`;
}

function materialConstraint(materialId: string): string {
  return `material_${materialId}`;
}

function objectiveKey(objective: Objective): "revenue" | "profit" | "fill" | "z" {
  switch (objective) {
    case "maximize_revenue":
      return "revenue";
    case "maximize_profit":
      return "profit";
    case "minimize_unmet_demand":
      return "fill";
    case "maximize_equitable_fill_rate":
      return "z";
  }
}

/**
 * Builds and solves the LP for the given objective across all products with
 * targetQty > 0 (the caller must have already excluded targetQty === 0
 * rows — see computeTargetQuantities), subject to: for each raw material,
 * total consumption <= its on-hand quantity; for each product,
 * 0 <= recommended_qty <= target_qty (the library defaults every variable's
 * lower bound to 0, confirmed against the real library).
 *
 * "Maximize Equitable Fill Rate" adds an auxiliary variable z with a
 * per-product constraint z - recommended_qty/target_qty <= 0 (valid as a
 * linear constraint since target_qty is a run-time constant, not a
 * variable), maximizing z — the standard max-min/fairness LP formulation.
 *
 * solver.Solve() omits any variable that solves to 0 from its result
 * object (confirmed empirically) — every read below defaults a missing key
 * to 0 rather than treating it as an error.
 */
export function buildAndSolveOptimization(params: {
  rows: TargetRow[];
  objective: Objective;
  products: ProductRow[];
  bomLines: BomLineRow[];
  inventoryItemsById: Map<string, InventoryItemRow>;
}): OptimizationSummary {
  const { rows, objective, products, bomLines, inventoryItemsById } = params;
  const productById = new Map(products.map((p) => [p.id, p]));

  const inputRows = rows.map((r) => {
    const product = productById.get(r.productId);
    return {
      ...r,
      productName: product?.name ?? "Unknown product",
      unitCost: computeUnitCost(r.productId, bomLines, inventoryItemsById),
      salePrice: Number(product?.sale_price_per_unit || 0),
    };
  });

  if (inputRows.length === 0) {
    return { objective, totalRecommendedUnits: 0, totalProjectedRevenue: 0, totalProjectedProfit: 0, rows: [] };
  }

  // Raw materials referenced by any included product's BOM, and each
  // included product's per-material usage rate (qty consumed per unit
  // produced), built once and reused for both LP construction and the
  // post-solve "limiting raw material" heuristic below.
  const materialIds = new Set<string>();
  const materialUsageByProduct = new Map<string, Map<string, number>>();
  for (const row of inputRows) {
    const usage = new Map<string, number>();
    for (const line of materialBomLinesForProduct(row.productId, bomLines)) {
      const materialId = line.inventory_item as string;
      materialIds.add(materialId);
      usage.set(materialId, (usage.get(materialId) ?? 0) + Number(line.qty_per_unit || 0));
    }
    materialUsageByProduct.set(row.productId, usage);
  }

  const objKey = objectiveKey(objective);
  const model: Model = {
    optimize: objKey,
    opType: "max",
    constraints: {},
    variables: {},
  };

  for (const row of inputRows) {
    const coeffs: Record<string, number> = { [capConstraint(row.productId)]: 1 };
    model.constraints[capConstraint(row.productId)] = { max: row.targetQty };

    if (objective === "maximize_revenue") {
      coeffs.revenue = row.salePrice;
    } else if (objective === "maximize_profit") {
      coeffs.profit = row.salePrice - row.unitCost;
    } else if (objective === "minimize_unmet_demand") {
      coeffs.fill = row.targetQty > 0 ? 1 / row.targetQty : 0;
    } else {
      // maximize_equitable_fill_rate: z - recommended_qty/target_qty <= 0
      const key = fairnessConstraint(row.productId);
      model.constraints[key] = { max: 0 };
      coeffs[key] = row.targetQty > 0 ? -(1 / row.targetQty) : 0;
    }

    const usage = materialUsageByProduct.get(row.productId) ?? new Map();
    for (const [materialId, qtyPerUnit] of usage.entries()) {
      coeffs[materialConstraint(materialId)] = qtyPerUnit;
    }

    model.variables[recVar(row.productId)] = coeffs;
  }

  for (const materialId of materialIds) {
    const item = inventoryItemsById.get(materialId);
    model.constraints[materialConstraint(materialId)] = { max: Number(item?.quantity_on_hand || 0) };
  }

  if (objective === "maximize_equitable_fill_rate") {
    const zCoeffs: Record<string, number> = { z: 1 };
    for (const row of inputRows) {
      zCoeffs[fairnessConstraint(row.productId)] = 1;
    }
    model.variables.z = zCoeffs;
  }

  // solver.Solve()'s declared return type is `SolveResult | unknown`, which
  // TypeScript collapses to `unknown` — the real runtime shape (confirmed
  // against the actual library) is always SolveResult, so this cast is safe.
  const solved = solver.Solve(model) as SolveResult;
  const recommendedQtyByProduct = new Map<string, number>(
    inputRows.map((row) => [row.productId, Number(solved[recVar(row.productId)] ?? 0)]),
  );

  // "Tight" (binding) raw materials: total consumption at or above on-hand,
  // or any consumption at all of a material that's already at 0 on-hand.
  const totalConsumption = new Map<string, number>();
  for (const row of inputRows) {
    const recommendedQty = recommendedQtyByProduct.get(row.productId) ?? 0;
    const usage = materialUsageByProduct.get(row.productId) ?? new Map();
    for (const [materialId, qtyPerUnit] of usage.entries()) {
      totalConsumption.set(materialId, (totalConsumption.get(materialId) ?? 0) + qtyPerUnit * recommendedQty);
    }
  }
  const tightMaterials = new Set<string>();
  for (const materialId of materialIds) {
    const onHand = Number(inventoryItemsById.get(materialId)?.quantity_on_hand || 0);
    const consumed = totalConsumption.get(materialId) ?? 0;
    if (consumed >= onHand - EPSILON) tightMaterials.add(materialId);
  }

  let totalRecommendedUnits = 0;
  let totalProjectedRevenue = 0;
  let totalProjectedProfit = 0;

  const resultRows: OptimizationResultRow[] = inputRows.map((row) => {
    const recommendedQty = recommendedQtyByProduct.get(row.productId) ?? 0;
    const fillRatePct = row.targetQty > 0 ? (recommendedQty / row.targetQty) * 100 : 0;
    const projectedRevenue = recommendedQty * row.salePrice;
    const projectedProfit = recommendedQty * (row.salePrice - row.unitCost);

    // Best-effort heuristic, not an LP shadow-price/sensitivity analysis
    // (the library's simplified Solve() result doesn't expose duals): among
    // the tight materials this product actually draws on, the one it
    // consumes the most of is reported as "limiting". Only reported when
    // the product didn't reach its own target (an unfilled product capped
    // only by its own target, with no tight material, gets no label).
    let limitingRawMaterial: string | null = null;
    if (recommendedQty < row.targetQty - EPSILON) {
      const usage = materialUsageByProduct.get(row.productId) ?? new Map();
      let best: { id: string; contribution: number } | null = null;
      for (const [materialId, qtyPerUnit] of usage.entries()) {
        if (!tightMaterials.has(materialId)) continue;
        const contribution = qtyPerUnit * recommendedQty;
        if (!best || contribution > best.contribution) best = { id: materialId, contribution };
      }
      limitingRawMaterial = best ? inventoryItemsById.get(best.id)?.name ?? null : null;
    }

    totalRecommendedUnits += recommendedQty;
    totalProjectedRevenue += projectedRevenue;
    totalProjectedProfit += projectedProfit;

    return { ...row, recommendedQty, fillRatePct, projectedRevenue, projectedProfit, limitingRawMaterial };
  });

  return { objective, totalRecommendedUnits, totalProjectedRevenue, totalProjectedProfit, rows: resultRows };
}
