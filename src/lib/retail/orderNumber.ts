/**
 * Shopify order numbers typed on an invoice. Trimmed, inner whitespace
 * collapsed, and digits-only input gets a "#" ("2552" -> "#2552"). Anything
 * else is kept as typed (stores can have custom prefixes or suffixes).
 * Compared case-insensitively. The ERP never looks the number up in Shopify.
 */
export const MAX_ORDER_NUMBER_LENGTH = 50;

export type OrderNumberResult = { ok: true; value: string } | { ok: false; error: string };

export function normalizeOrderNumber(input: unknown): OrderNumberResult {
  const t = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  if (!t) return { ok: false, error: "Enter the Shopify order number." };
  const value = /^\d+$/.test(t) ? `#${t}` : t;
  if (value.length > MAX_ORDER_NUMBER_LENGTH) return { ok: false, error: `Keep the order number under ${MAX_ORDER_NUMBER_LENGTH + 1} characters.` };
  return { ok: true, value };
}

export const sameOrderNumber = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** "2552" from "#2552", for file names. */
export const orderNumberForFilename = (n: string) => n.replace(/^#/, "");
