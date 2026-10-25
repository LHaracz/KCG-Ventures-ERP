/**
 * Mass-unit conversion for the Receiving log. The form always collects a
 * quantity in grams for a mass-unit raw material (so receipts are
 * comparable regardless of the material's own unit) and converts to that
 * unit for the actual inventory increase. A non-mass unit (bottle, each,
 * ...) skips grams entirely and collects the quantity directly in that unit.
 */

export const MASS_UNITS = ["g", "kg", "oz", "lb"] as const;
export type MassUnit = (typeof MASS_UNITS)[number];

export function isMassUnit(unit: string): unit is MassUnit {
  return (MASS_UNITS as readonly string[]).includes(unit.trim().toLowerCase());
}

const GRAMS_PER_UNIT: Record<MassUnit, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

/** Converts a gram quantity into the given mass unit. */
export function convertGramsTo(unit: string, grams: number): number {
  const normalized = unit.trim().toLowerCase() as MassUnit;
  const perUnit = GRAMS_PER_UNIT[normalized];
  if (!perUnit) return grams;
  return grams / perUnit;
}
