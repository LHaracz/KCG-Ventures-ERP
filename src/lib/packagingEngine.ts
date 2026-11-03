/**
 * Packaging engine: suggests a package (preset) for an order from product
 * "points" and per-product "smallest allowed package" rules. Pure: no I/O,
 * no React. Shared by Packaging Setup (test panel + 90-day preview), the
 * Pick List, Shipping Assignments, the order detail page and the server
 * routes. Points math uses decimal.js.
 *
 * The suggestion is computed live from the current rules every time and is
 * never stored. Only overrides are stored (order_packaging).
 *
 * Decision for a minimum that points at a preset with no max points (it can
 * happen if a preset's max points is cleared after a rule was saved): the
 * order goes to Needs Review with the reason
 * "{Product}'s smallest allowed package ({Preset}) has no max points set",
 * rather than silently ignoring the minimum.
 */
import Decimal from "decimal.js";

export type PackagingPresetInput = {
  id: string;
  nickname: string;
  maxPoints: Decimal.Value | null | undefined;
};

export type PackagingRuleInput = {
  productId: string;
  points: Decimal.Value | null | undefined;
  minPackageId: string | null | undefined;
};

export type EngineComponent = {
  productId: string;
  productName: string;
  qty: number; // already qty_per_unit x line quantity
};

export type PackagingBreakdownRow = {
  productId: string;
  productName: string;
  qty: number;
  pointsEach: string | null;
  subtotal: string | null;
  minPackageName: string | null;
};

export type PackagingSuggestion = {
  status: "suggested" | "needs_review";
  presetId: string | null;
  presetName: string | null;
  totalPoints: string;
  maxPoints: string | null;
  /** Human-readable reason shown on the order. */
  reason: string;
  /** Every Needs Review reason (empty when suggested). */
  reviewReasons: string[];
  /** The same reasons in structured form, for grouping (90-day preview). */
  reviewIssues: ReviewIssue[];
  decidedBy: "points" | "minimum" | null;
  breakdown: PackagingBreakdownRow[];
};

export type ReviewIssueKind =
  | "unmapped_line_item"
  | "no_points"
  | "no_rule"
  | "min_without_max_points"
  | "over_capacity"
  | "no_presets"
  | "no_items";

export type ReviewIssue = { kind: ReviewIssueKind; subject: string | null };

export type EngineInput = {
  components: EngineComponent[];
  unmappedLineItems: string[];
  rules: PackagingRuleInput[] | Map<string, PackagingRuleInput>;
  presets: PackagingPresetInput[];
};

function toDecimal(v: Decimal.Value | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

export function fmtPoints(d: Decimal): string {
  return d.toDecimalPlaces(2).toString();
}

export type SizedPreset = { id: string; nickname: string; maxPoints: Decimal };

/** Presets usable for suggestions (positive max points), smallest first. */
export function sizedPresets(presets: PackagingPresetInput[]): SizedPreset[] {
  return presets
    .map((p) => ({ id: p.id, nickname: p.nickname, maxPoints: toDecimal(p.maxPoints) }))
    .filter((p): p is SizedPreset => p.maxPoints !== null && p.maxPoints.gt(0))
    .sort((a, b) => a.maxPoints.comparedTo(b.maxPoints) || a.nickname.localeCompare(b.nickname));
}

export type PresetValidationError = { presetId: string | null; message: string };

/**
 * Among presets with max points set, max points must be a positive number and
 * unique. Returns every problem found (empty = valid). Used before saving a
 * preset (pass the list as it would be after the save) and on the setup page.
 */
export function validatePresetMaxPoints(presets: PackagingPresetInput[]): PresetValidationError[] {
  const errors: PresetValidationError[] = [];
  const seen = new Map<string, string>();
  for (const p of presets) {
    if (p.maxPoints === null || p.maxPoints === undefined || p.maxPoints === "") continue;
    const d = toDecimal(p.maxPoints);
    if (d === null || !d.gt(0)) {
      errors.push({ presetId: p.id || null, message: `${p.nickname || "This package"}: max points must be a positive number.` });
      continue;
    }
    const key = fmtPoints(d);
    const other = seen.get(key);
    if (other !== undefined) {
      errors.push({
        presetId: p.id || null,
        message: `${p.nickname || "This package"}: max points ${key} is already used by ${other}. Each package needs a different max points.`,
      });
    } else {
      seen.set(key, p.nickname || "another package");
    }
  }
  return errors;
}

/** Combines repeated products (same product from several line items). */
export function aggregateComponents(components: EngineComponent[]): EngineComponent[] {
  const byId = new Map<string, EngineComponent>();
  for (const c of components) {
    const prev = byId.get(c.productId);
    if (prev) prev.qty += c.qty;
    else byId.set(c.productId, { ...c });
  }
  return Array.from(byId.values());
}

export function suggestPackage(input: EngineInput): PackagingSuggestion {
  const rulesById =
    input.rules instanceof Map ? input.rules : new Map(input.rules.map((r) => [r.productId, r]));
  const sized = sizedPresets(input.presets);
  const allById = new Map(input.presets.map((p) => [p.id, p]));
  const rankById = new Map(sized.map((p, i) => [p.id, i]));
  const components = aggregateComponents(input.components);

  const reviewReasons: string[] = [];
  const reviewIssues: ReviewIssue[] = [];
  const flag = (kind: ReviewIssueKind, subject: string | null, text: string) => {
    reviewReasons.push(text);
    reviewIssues.push({ kind, subject });
  };
  for (const name of input.unmappedLineItems) flag("unmapped_line_item", name, `Unmapped line item: ${name}`);

  let total = new Decimal(0);
  let minRank = -1;
  const minProducts: string[] = [];
  const breakdown: PackagingBreakdownRow[] = [];

  for (const c of components) {
    const rule = rulesById.get(c.productId);
    const points = rule ? toDecimal(rule.points) : null;
    let minName: string | null = null;

    if (!rule) {
      flag("no_rule", c.productName, `${c.productName} has no packaging rule`);
    } else if (points === null || !points.gt(0)) {
      flag("no_points", c.productName, `${c.productName} has no points set`);
    }

    if (rule?.minPackageId) {
      const minPreset = allById.get(rule.minPackageId);
      const rank = rankById.get(rule.minPackageId);
      if (minPreset && rank === undefined) {
        flag(
          "min_without_max_points",
          c.productName,
          `${c.productName}'s smallest allowed package (${minPreset.nickname}) has no max points set`,
        );
        minName = minPreset.nickname;
      } else if (minPreset && rank !== undefined) {
        minName = minPreset.nickname;
        if (rank > minRank) {
          minRank = rank;
          minProducts.length = 0;
          minProducts.push(c.productName);
        } else if (rank === minRank) {
          minProducts.push(c.productName);
        }
      }
      // A min_package_id pointing at a deleted preset can't happen (FK sets
      // it NULL), so a missing preset is simply treated as "Any package".
    }

    const subtotal = points && points.gt(0) ? points.times(c.qty) : null;
    if (subtotal) total = total.plus(subtotal);
    breakdown.push({
      productId: c.productId,
      productName: c.productName,
      qty: c.qty,
      pointsEach: points && points.gt(0) ? fmtPoints(points) : null,
      subtotal: subtotal ? fmtPoints(subtotal) : null,
      minPackageName: minName,
    });
  }

  if (components.length === 0 && input.unmappedLineItems.length === 0) {
    flag("no_items", null, "Order has no items to pack");
  }

  if (sized.length === 0) {
    flag("no_presets", null, "No packages have max points set");
  } else {
    const largest = sized[sized.length - 1];
    if (total.gt(largest.maxPoints)) {
      flag(
        "over_capacity",
        null,
        `Over capacity: ${fmtPoints(total)} points, largest package holds ${fmtPoints(largest.maxPoints)}`,
      );
    }
  }

  const base = { totalPoints: fmtPoints(total), breakdown };

  if (reviewReasons.length > 0) {
    return {
      ...base,
      status: "needs_review",
      presetId: null,
      presetName: null,
      maxPoints: null,
      reason: reviewReasons.join("; "),
      reviewReasons,
      reviewIssues,
      decidedBy: null,
    };
  }

  const pointsRank = sized.findIndex((p) => p.maxPoints.gte(total));
  const finalRank = Math.max(pointsRank, minRank);
  const chosen = sized[finalRank];
  const decidedBy = minRank > pointsRank ? "minimum" : "points";
  const reason =
    decidedBy === "minimum"
      ? `${chosen.nickname}: contains ${minProducts.join(", ")} (needs ${chosen.nickname} or larger)`
      : `${chosen.nickname}: ${fmtPoints(total)} of ${fmtPoints(chosen.maxPoints)} points`;

  return {
    ...base,
    status: "suggested",
    presetId: chosen.id,
    presetName: chosen.nickname,
    maxPoints: fmtPoints(chosen.maxPoints),
    reason,
    reviewReasons: [],
    reviewIssues: [],
    decidedBy,
  };
}

// --- Effective package (override wins over the suggestion) ----------------

export type PackagingOverride = {
  target: "preset" | "needs_review";
  presetId: string | null;
  presetName: string | null;
};

export type EffectivePackage = {
  /** Tab key: a preset id, or "needs_review". */
  key: string;
  presetId: string | null;
  label: string;
  reason: string;
  overridden: boolean;
  suggestion: PackagingSuggestion;
  suggestionLabel: string;
};

export const NEEDS_REVIEW_KEY = "needs_review";

export function effectivePackage(
  suggestion: PackagingSuggestion,
  override: PackagingOverride | null,
  presets: PackagingPresetInput[],
): EffectivePackage {
  const suggestionLabel = suggestion.presetName ?? "Needs Review";
  if (override) {
    if (override.target === "preset" && override.presetId) {
      const sized = sizedPresets(presets).find((p) => p.id === override.presetId);
      if (sized) {
        return {
          key: sized.id,
          presetId: sized.id,
          label: sized.nickname,
          reason: `Overridden to ${sized.nickname} (suggested: ${suggestionLabel})`,
          overridden: true,
          suggestion,
          suggestionLabel,
        };
      }
      // The override's preset lost its max points or was removed: show it in
      // Needs Review rather than on a tab that no longer exists.
      return {
        key: NEEDS_REVIEW_KEY,
        presetId: null,
        label: "Needs Review",
        reason: `Overridden to ${override.presetName ?? "a package"}, which is no longer available for suggestions`,
        overridden: true,
        suggestion,
        suggestionLabel,
      };
    }
    if (override.target === "needs_review") {
      return {
        key: NEEDS_REVIEW_KEY,
        presetId: null,
        label: "Needs Review",
        reason: `Moved to Needs Review (suggested: ${suggestionLabel})`,
        overridden: true,
        suggestion,
        suggestionLabel,
      };
    }
  }
  return {
    key: suggestion.status === "suggested" && suggestion.presetId ? suggestion.presetId : NEEDS_REVIEW_KEY,
    presetId: suggestion.presetId,
    label: suggestionLabel,
    reason: suggestion.reason,
    overridden: false,
    suggestion,
    suggestionLabel,
  };
}
