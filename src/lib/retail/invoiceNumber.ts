/**
 * ERP invoice numbers: {prefix}-{YYYY}-{NNN}, padded to 3 digits and growing
 * past 999 (KCG-INV-2026-001 ... KCG-INV-2026-1000), per prefix and New York
 * year. The database assigns them (assign_invoice_number, an atomic counter
 * bumped in the same transaction as the insert); this mirrors the format
 * for display and tests.
 */
export const DEFAULT_INVOICE_PREFIX = "KCG-INV";
export const INVOICE_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/;

export function formatInvoiceNumber(prefix: string, year: number, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invoice sequence must be a positive whole number.");
  return `${prefix}-${year}-${sequence < 1000 ? String(sequence).padStart(3, "0") : String(sequence)}`;
}

/** The America/New_York calendar year of a moment. */
export function nyYear(now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(now));
}
