/**
 * Formula Table engine (pure, no I/O). Shared by the SOP editor, the
 * read-only viewer, publish snapshots and tests.
 *
 * Input rows are a product's latest FINAL formulation lines: the amount of
 * each ingredient for exactly 1 unit of finished product, as stored on the
 * Formulation page and written to Products & BOM by Finish Iteration.
 * Nothing here is derived from pieces, packs or other sub-units.
 *
 * All math uses decimal.js on the stored per-unit decimal string. A cell is
 * always qtyPerUnit x column count computed from the stored value; a rounded
 * value is never multiplied.
 */
import Decimal from "decimal.js";

/** Column unit counts, fixed in this build. */
export const FORMULA_TABLE_COLUMNS: readonly number[] = [1, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200];

export type FormulaInputRow = {
  name: string;
  unit: string;
  /** Amount for 1 unit of finished product, as a decimal string (or number from the DB). */
  qtyPerUnit: string | number;
};

export type FormulaTableCell = {
  count: number;
  /** Exact decimal value in the display unit (grams for mass units), unrounded. */
  exact: string;
  /** Formatted text for the cell, e.g. "1,000" or "40 each". */
  display: string;
};

export type FormulaTableRow = {
  name: string;
  /** Unit as stored on the ingredient. */
  sourceUnit: string;
  /** "g" for mass units, otherwise the stored unit unchanged. */
  displayUnit: string;
  isMass: boolean;
  /** Ingredient label for the first column. Non-mass units are shown, e.g. "Ingredient F (each)". */
  label: string;
  valid: boolean;
  cells: FormulaTableCell[];
};

export type FormulaTable = {
  columns: { count: number; header: string }[];
  rows: FormulaTableRow[];
};

// Grams per 1 of each mass unit. Keys are normalized (lowercase, trimmed).
const GRAMS_PER: Record<string, Decimal> = {
  g: new Decimal(1),
  gram: new Decimal(1),
  grams: new Decimal(1),
  kg: new Decimal(1000),
  kilogram: new Decimal(1000),
  kilograms: new Decimal(1000),
  lb: new Decimal("453.59237"),
  lbs: new Decimal("453.59237"),
  pound: new Decimal("453.59237"),
  pounds: new Decimal("453.59237"),
  oz: new Decimal("28.349523125"),
  ounce: new Decimal("28.349523125"),
  ounces: new Decimal("28.349523125"),
};

function normalizeUnit(unit: string): string {
  return (unit ?? "").trim().toLowerCase().replace(/\.$/, "");
}

/** True when the unit is a mass unit that converts to grams (fl oz is volume, not mass). */
export function isMassUnit(unit: string): boolean {
  return normalizeUnit(unit) in GRAMS_PER;
}

export function columnHeader(count: number): string {
  return count === 1 ? "1 unit" : `${count.toLocaleString("en-US")} units`;
}

/** Parses a stored quantity into a Decimal, or null if it is not a finite number. */
export function parseQty(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value).trim();
  if (!s) return null;
  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Converts a quantity in `unit` to grams when it is a mass unit; otherwise returns it unchanged. */
export function toDisplayUnit(qty: Decimal, unit: string): { value: Decimal; displayUnit: string; isMass: boolean } {
  const factor = GRAMS_PER[normalizeUnit(unit)];
  if (factor) return { value: qty.times(factor), displayUnit: "g", isMass: true };
  return { value: qty, displayUnit: (unit ?? "").trim(), isMass: false };
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats a quantity: thousands separators, trailing zeros trimmed, up to 3
 * decimals. If a nonzero value would display as 0 at 3 decimals, shows up to
 * 5 decimals. Values still too small at 5 decimals display as "<0.00001".
 */
export function formatQuantity(value: Decimal): string {
  if (value.isZero()) return "0";
  let rounded = value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  if (rounded.isZero()) {
    rounded = value.toDecimalPlaces(5, Decimal.ROUND_HALF_UP);
    if (rounded.isZero()) return value.isNegative() ? ">-0.00001" : "<0.00001";
  }
  const fixed = rounded.toFixed(); // no exponent notation
  const negative = fixed.startsWith("-");
  const body = negative ? fixed.slice(1) : fixed;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = fracPart.replace(/0+$/, "");
  return `${negative ? "-" : ""}${groupThousands(intPart)}${frac ? `.${frac}` : ""}`;
}

export function buildFormulaTable(rows: FormulaInputRow[], columns: readonly number[] = FORMULA_TABLE_COLUMNS): FormulaTable {
  return {
    columns: columns.map((count) => ({ count, header: columnHeader(count) })),
    rows: rows.map((row) => {
      const qty = parseQty(row.qtyPerUnit);
      const unit = (row.unit ?? "").trim();
      const mass = isMassUnit(unit);
      const displayUnit = mass ? "g" : unit;
      const label = mass || !unit ? row.name : `${row.name} (${unit})`;
      if (!qty) {
        return {
          name: row.name,
          sourceUnit: unit,
          displayUnit,
          isMass: mass,
          label,
          valid: false,
          cells: columns.map((count) => ({ count, exact: "", display: "—" })),
        };
      }
      const perUnit = toDisplayUnit(qty, unit).value;
      return {
        name: row.name,
        sourceUnit: unit,
        displayUnit,
        isMass: mass,
        label,
        valid: true,
        cells: columns.map((count) => {
          const v = perUnit.times(count);
          const text = formatQuantity(v);
          return { count, exact: v.toFixed(), display: mass || !unit ? text : `${text} ${unit}` };
        }),
      };
    }),
  };
}

/** Looks up one cell's display text by column count (test and print helper). */
export function cellDisplay(table: FormulaTable, rowName: string, count: number): string | undefined {
  return table.rows.find((r) => r.name === rowName)?.cells.find((c) => c.count === count)?.display;
}
