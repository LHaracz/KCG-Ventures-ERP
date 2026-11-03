// "Last 90 days" preview summary, with invented orders and fixtures.
import { describe, expect, it } from "vitest";
import { buildComponentResolver } from "@/lib/orderComponents";
import { buildPackagingPreview } from "@/lib/packagingPreview";

const resolver = buildComponentResolver(
  [
    { lineitem_name: "Gum", business: "botaniqals", components: [{ product_id: "gum", qty_per_unit: 1 }] },
    { lineitem_name: "Spray", business: "botaniqals", components: [{ product_id: "spray", qty_per_unit: 1 }] },
    { lineitem_name: "Floss", business: "botaniqals", components: [{ product_id: "floss", qty_per_unit: 1 }] },
    { lineitem_name: "Pea Shoots", business: "minileaf", components: [{ product_id: "pea", qty_per_unit: 1 }] },
  ],
  [
    { id: "gum", name: "Gum" },
    { id: "spray", name: "Spray" },
    { id: "floss", name: "Floss" },
    { id: "pea", name: "Pea Shoots", is_microgreen: true },
  ],
);
const rules = [
  { productId: "gum", points: 1, minPackageId: null },
  { productId: "spray", points: 1, minPackageId: "small" },
  { productId: "floss", points: null, minPackageId: null },
];
const presets = [
  { id: "mailer", nickname: "Mailer", maxPoints: 4 },
  { id: "small", nickname: "Small", maxPoints: 10 },
];

describe("buildPackagingPreview", () => {
  it("counts orders per package and groups Needs Review reasons with the products involved", () => {
    const p = buildPackagingPreview(
      [
        { id: "1", lineItems: [{ name: "Gum", quantity: 2 }] }, // Mailer
        { id: "2", lineItems: [{ name: "Gum", quantity: 1 }, { name: "Spray", quantity: 1 }] }, // Small (minimum)
        { id: "3", lineItems: [{ name: "Gum", quantity: 20 }] }, // over capacity
        { id: "4", lineItems: [{ name: "Floss", quantity: 1 }] }, // no points
        { id: "5", lineItems: [{ name: "Floss", quantity: 2 }, { name: "Pea Shoots", quantity: 1 }] }, // no points + no rule
        { id: "6", lineItems: [{ name: "Gift Card", quantity: 1 }] }, // unmapped
      ],
      resolver,
      rules,
      presets,
    );
    expect(p.orderCount).toBe(6);
    expect(p.packages).toEqual([
      { presetId: "mailer", nickname: "Mailer", count: 1 },
      { presetId: "small", nickname: "Small", count: 1 },
    ]);
    expect(p.needsReview).toBe(4);
    const byKind = Object.fromEntries(p.topReasons.map((r) => [r.kind, r]));
    expect(p.topReasons[0].kind).toBe("no_points");
    expect(byKind.no_points).toMatchObject({ orders: 2, subjects: [{ name: "Floss", orders: 2 }] });
    expect(byKind.no_rule).toMatchObject({ orders: 1, subjects: [{ name: "Pea Shoots", orders: 1 }] });
    expect(byKind.over_capacity).toMatchObject({ orders: 1, subjects: [{ name: "Gum", orders: 1 }] });
    expect(byKind.unmapped_line_item).toMatchObject({ orders: 1, subjects: [{ name: "Gift Card", orders: 1 }] });
  });
});
