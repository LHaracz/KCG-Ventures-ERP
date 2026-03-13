const OZ_TO_G = 28.3495;

/** Convert quantity to grams. Supports oz and g. */
export function toGrams(qty: number, unit: string): number {
  const u = (unit || "g").trim().toLowerCase();
  if (u === "oz" || u === "ounce" || u === "ounces") {
    return qty * OZ_TO_G;
  }
  return qty; // assume g
}

/** Convert grams to ounces (for display). */
export function gramsToOz(g: number): number {
  return g / OZ_TO_G;
}
