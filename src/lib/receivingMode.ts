/**
 * Receiving Log modes (pure, tested). A receipt uses the full form (lot
 * number, COA, documents…) or the simple form (quantity, optional expiry,
 * invoice and notes), chosen by the COA policy of the raw material's
 * listing with the chosen supplier. The server derives the same mode again
 * in submit_receiving_entry and rejects a payload that doesn't match.
 */

export type CoaPolicy = "included" | "request" | "not_available" | "unknown";
export type EntryMode = "full" | "simple";

/** The Procurement labels for each stored policy value. */
export const COA_POLICY_LABEL: Record<CoaPolicy, string> = {
  included: "Provided automatically",
  request: "Must request",
  not_available: "Not provided",
  unknown: "Unknown",
};

export const coaPolicyLabel = (p: string | null | undefined) => (p && p in COA_POLICY_LABEL ? COA_POLICY_LABEL[p as CoaPolicy] : "Unknown");

export type ModeReason = "correction" | "forced_full" | "policy_full" | "policy_simple" | "no_listing";

/**
 * The form mode for a receipt.
 * - A correction always keeps the original entry's mode (an old receipt
 *   without a mode is a full receipt).
 * - "Use the full form" (forcedFull) gives full.
 * - 'included' or 'request' give full; 'not_available', 'unknown' or no
 *   listing give simple.
 */
export function receivingModeFor(input: {
  policy: string | null | undefined;
  hasListing: boolean;
  existingEntryMode?: string | null;
  isCorrection?: boolean;
  forcedFull?: boolean;
}): { mode: EntryMode; policy: CoaPolicy | null; reason: ModeReason } {
  const policy = input.policy && input.policy in COA_POLICY_LABEL ? (input.policy as CoaPolicy) : null;
  if (input.isCorrection) return { mode: input.existingEntryMode === "simple" ? "simple" : "full", policy, reason: "correction" };
  if (input.forcedFull) return { mode: "full", policy, reason: "forced_full" };
  if (!input.hasListing || !policy) return { mode: "simple", policy: null, reason: "no_listing" };
  if (policy === "included" || policy === "request") return { mode: "full", policy, reason: "policy_full" };
  return { mode: "simple", policy, reason: "policy_simple" };
}

/** The receiving dropdown's order: pinned first (alphabetical), then the rest alphabetically. */
export function sortSuppliersForPicker<T extends { name: string; is_pinned: boolean }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** A quantity in the material's own unit: greater than 0, at most 3 decimals. */
export function validSimpleQuantity(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,3})?$|^\.\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
