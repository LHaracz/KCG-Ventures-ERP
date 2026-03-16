export type ManufacturingCycle = {
  index: number;
  quantity: number;
};

export type BomLineForScaling = {
  bomLineId: string;
  productId: string;
  ingredientId: string;
  ingredientName: string;
  qtyPerUnit: number;
  unitLabel: string;
};

export type CycleIngredientRequirement = {
  cycleIndex: number;
  bomLineId: string;
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  unitLabel: string;
};

export type AggregatedIngredientRequirement = {
  ingredientId: string;
  ingredientName: string;
  totalQuantity: number;
  unitLabel: string;
};

export function splitIntoCycles(
  plannedQty: number,
  targetBatchSize: number,
): ManufacturingCycle[] {
  if (!Number.isFinite(plannedQty) || !Number.isFinite(targetBatchSize)) {
    return [];
  }
  if (plannedQty <= 0 || targetBatchSize <= 0) {
    return [];
  }

  // If the planned quantity is less than or equal to the batch size,
  // we still run a single cycle with the smaller quantity.
  if (plannedQty <= targetBatchSize) {
    return [{ index: 1, quantity: plannedQty }];
  }

  const fullCycles = Math.floor(plannedQty / targetBatchSize);
  const remainder = plannedQty % targetBatchSize;

  const cycles: ManufacturingCycle[] = [];
  for (let i = 0; i < fullCycles; i++) {
    cycles.push({ index: i + 1, quantity: targetBatchSize });
  }
  if (remainder > 0) {
    cycles.push({ index: cycles.length + 1, quantity: remainder });
  }

  return cycles;
}

/**
 * Scale BOM ingredient quantities for a single manufacturing cycle.
 *
 * BOM reference quantity:
 * - Each BOM line's `qty_per_unit` is defined per 1 finished unit of the product.
 * - `cycleQty` is the number of finished units produced in this cycle.
 * - Required amount per ingredient = `cycleQty * qty_per_unit`.
 *
 * targetBatchSize is not used directly here; it comes from the product
 * (`products.target_batch_size`) and is used when splitting planned quantity
 * into cycles via `splitIntoCycles`.
 *
 * BOM lines are sourced from `bom_lines` where `bom_lines.product === product.id`.
 */
export function scaleBomLines(
  bomLines: BomLineForScaling[],
  cycleQty: number,
): CycleIngredientRequirement[] {
  if (!Number.isFinite(cycleQty) || cycleQty <= 0) {
    return [];
  }

  return bomLines.map((line) => ({
    cycleIndex: 0, // the caller should override with the actual cycle index
    bomLineId: line.bomLineId,
    ingredientId: line.ingredientId,
    ingredientName: line.ingredientName,
    quantity: cycleQty * line.qtyPerUnit,
    unitLabel: line.unitLabel,
  }));
}

export function aggregateCycleRequirements(
  cycleRequirements: CycleIngredientRequirement[][],
): AggregatedIngredientRequirement[] {
  const flat = cycleRequirements.flat();
  if (flat.length === 0) {
    return [];
  }

  const byIngredient = new Map<
    string,
    { ingredientName: string; totalQuantity: number; unitLabel: string }
  >();

  for (const req of flat) {
    const existing = byIngredient.get(req.ingredientId);
    if (!existing) {
      byIngredient.set(req.ingredientId, {
        ingredientName: req.ingredientName,
        totalQuantity: req.quantity,
        unitLabel: req.unitLabel,
      });
    } else {
      existing.totalQuantity += req.quantity;
    }
  }

  return Array.from(byIngredient.entries())
    .map(([ingredientId, value]) => ({
      ingredientId,
      ingredientName: value.ingredientName,
      totalQuantity: value.totalQuantity,
      unitLabel: value.unitLabel,
    }))
    .sort((a, b) => a.ingredientName.localeCompare(b.ingredientName));
}

