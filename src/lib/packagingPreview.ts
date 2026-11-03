/**
 * Packaging Setup "Last 90 days" preview: runs the packaging engine over
 * historical orders in one pass and summarizes the result. Pure (the route
 * loads the orders from the ERP's own orders/order_line_items tables).
 */
import { resolveOrderComponents, type ComponentResolver } from "@/lib/orderComponents";
import {
  suggestPackage,
  sizedPresets,
  type PackagingPresetInput,
  type PackagingRuleInput,
  type ReviewIssueKind,
} from "@/lib/packagingEngine";

export type PreviewOrder = { id: string; lineItems: Array<{ name: string; quantity: number }> };

export type PackagingPreview = {
  orderCount: number;
  packages: Array<{ presetId: string; nickname: string; count: number }>;
  needsReview: number;
  topReasons: Array<{ kind: ReviewIssueKind; label: string; orders: number; subjects: Array<{ name: string; orders: number }> }>;
};

const KIND_LABELS: Record<ReviewIssueKind, string> = {
  unmapped_line_item: "Unmapped line items",
  no_rule: "Products with no packaging rule",
  no_points: "Products with no points set",
  min_without_max_points: "Smallest allowed package has no max points",
  over_capacity: "Over capacity (more points than the largest package)",
  no_presets: "No packages have max points set",
  no_items: "Orders with no items to pack",
};

export function buildPackagingPreview(
  orders: PreviewOrder[],
  resolver: ComponentResolver,
  rules: PackagingRuleInput[],
  presets: PackagingPresetInput[],
): PackagingPreview {
  const rulesById = new Map(rules.map((r) => [r.productId, r]));
  const sized = sizedPresets(presets);
  const counts = new Map<string, number>(sized.map((p) => [p.id, 0]));
  let needsReview = 0;
  const byKind = new Map<ReviewIssueKind, { orders: number; subjects: Map<string, number> }>();

  for (const order of orders) {
    const resolved = resolveOrderComponents(order.lineItems, resolver);
    const s = suggestPackage({
      components: resolved.components,
      unmappedLineItems: resolved.unmappedLineItems,
      rules: rulesById,
      presets,
    });
    if (s.status === "suggested" && s.presetId) {
      counts.set(s.presetId, (counts.get(s.presetId) ?? 0) + 1);
      continue;
    }
    needsReview += 1;
    const kindsSeen = new Set<ReviewIssueKind>();
    const subjectsSeen = new Set<string>();
    for (const issue of s.reviewIssues) {
      let bucket = byKind.get(issue.kind);
      if (!bucket) {
        bucket = { orders: 0, subjects: new Map() };
        byKind.set(issue.kind, bucket);
      }
      if (!kindsSeen.has(issue.kind)) {
        bucket.orders += 1;
        kindsSeen.add(issue.kind);
      }
      // Over capacity has no single product: list the products in those orders.
      const subjects =
        issue.kind === "over_capacity" ? resolved.components.map((c) => c.productName) : issue.subject ? [issue.subject] : [];
      for (const name of subjects) {
        const key = `${issue.kind}|${name}`;
        if (subjectsSeen.has(key)) continue;
        subjectsSeen.add(key);
        bucket.subjects.set(name, (bucket.subjects.get(name) ?? 0) + 1);
      }
    }
  }

  return {
    orderCount: orders.length,
    packages: sized.map((p) => ({ presetId: p.id, nickname: p.nickname, count: counts.get(p.id) ?? 0 })),
    needsReview,
    topReasons: Array.from(byKind.entries())
      .map(([kind, b]) => ({
        kind,
        label: KIND_LABELS[kind],
        orders: b.orders,
        subjects: Array.from(b.subjects.entries())
          .map(([name, n]) => ({ name, orders: n }))
          .sort((a, z) => z.orders - a.orders || a.name.localeCompare(z.name))
          .slice(0, 10),
      }))
      .sort((a, z) => z.orders - a.orders),
  };
}
