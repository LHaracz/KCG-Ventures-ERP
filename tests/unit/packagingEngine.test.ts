// Packaging engine rules, using only invented fixtures.
import { describe, expect, it } from "vitest";
import {
  effectivePackage,
  suggestPackage,
  validatePresetMaxPoints,
  type EngineComponent,
  type PackagingPresetInput,
  type PackagingRuleInput,
} from "@/lib/packagingEngine";

const presets: PackagingPresetInput[] = [
  { id: "mailer", nickname: "Mailer", maxPoints: 4 },
  { id: "small", nickname: "Small", maxPoints: 10 },
  { id: "big", nickname: "Big", maxPoints: 25 },
  { id: "tube", nickname: "Tube", maxPoints: null }, // no max points: never suggested
];

const rules: PackagingRuleInput[] = [
  { productId: "gum", points: 1, minPackageId: null },
  { productId: "spray", points: 1, minPackageId: "small" },
  { productId: "paste", points: 2, minPackageId: null },
  { productId: "rinse", points: 3, minPackageId: "small" },
  { productId: "cup", points: 2, minPackageId: null },
];

const names: Record<string, string> = {
  gum: "Gum",
  spray: "Spray",
  paste: "Paste",
  rinse: "Rinse",
  cup: "Cup",
  pea: "Pea Shoots",
  floss: "Floss",
};
const c = (productId: string, qty: number): EngineComponent => ({ productId, productName: names[productId], qty });
const run = (components: EngineComponent[], extra: Partial<Parameters<typeof suggestPackage>[0]> = {}) =>
  suggestPackage({ components, unmappedLineItems: [], rules, presets, ...extra });

const bundle = [c("paste", 1), c("rinse", 1), c("spray", 1), c("gum", 2)];

describe("suggestPackage", () => {
  it("2 Gum = 2 points: Mailer", () => {
    const s = run([c("gum", 2)]);
    expect(s.status).toBe("suggested");
    expect(s.presetName).toBe("Mailer");
    expect(s.totalPoints).toBe("2");
    expect(s.reason).toBe("Mailer: 2 of 4 points");
  });

  it("2 Gum + 1 Spray = 3 points, but Spray needs Small: Small with the minimum reason", () => {
    const s = run([c("gum", 2), c("spray", 1)]);
    expect(s.totalPoints).toBe("3");
    expect(s.presetName).toBe("Small");
    expect(s.decidedBy).toBe("minimum");
    expect(s.reason).toBe("Small: contains Spray (needs Small or larger)");
  });

  it("1 Paste + 1 Gum = 3 points: Mailer", () => {
    const s = run([c("paste", 1), c("gum", 1)]);
    expect(s.presetName).toBe("Mailer");
    expect(s.reason).toBe("Mailer: 3 of 4 points");
  });

  it("Bundle (1 Paste, 1 Rinse, 1 Spray, 2 Gum) = 8 points: Small", () => {
    const s = run(bundle);
    expect(s.totalPoints).toBe("8");
    expect(s.presetName).toBe("Small");
    // Points alone already need Small, so points decided it.
    expect(s.decidedBy).toBe("points");
    expect(s.reason).toBe("Small: 8 of 10 points");
  });

  it("Bundle with Cup = 10 points: Small (boundary, 10 fits exactly)", () => {
    const s = run([...bundle, c("cup", 1)]);
    expect(s.totalPoints).toBe("10");
    expect(s.presetName).toBe("Small");
  });

  it("2 Bundles with Cups = 20 points: Big", () => {
    const s = run([...bundle, c("cup", 1), ...bundle, c("cup", 1)]);
    expect(s.totalPoints).toBe("20");
    expect(s.presetName).toBe("Big");
    expect(s.reason).toBe("Big: 20 of 25 points");
    // Repeated products are combined in the breakdown.
    expect(s.breakdown.find((b) => b.productId === "gum")).toMatchObject({ qty: 4, subtotal: "4" });
  });

  it("30 points: Needs review (over capacity)", () => {
    const s = run([c("paste", 15)]);
    expect(s.status).toBe("needs_review");
    expect(s.presetId).toBeNull();
    expect(s.reason).toBe("Over capacity: 30 points, largest package holds 25");
  });

  it("an unmapped line item: Needs review", () => {
    const s = run([c("gum", 1)], { unmappedLineItems: ["Mystery Pack - Large"] });
    expect(s.status).toBe("needs_review");
    expect(s.reason).toBe("Unmapped line item: Mystery Pack - Large");
  });

  it("a product with no points: Needs review", () => {
    const s = suggestPackage({
      components: [c("gum", 1), c("floss", 1)],
      unmappedLineItems: [],
      rules: [...rules, { productId: "floss", points: null, minPackageId: null }],
      presets,
    });
    expect(s.status).toBe("needs_review");
    expect(s.reason).toBe("Floss has no points set");
  });

  it("a MiniLeaf component (no packaging rule): Needs review", () => {
    const s = run([c("gum", 1), c("pea", 2)]);
    expect(s.status).toBe("needs_review");
    expect(s.reason).toBe("Pea Shoots has no packaging rule");
  });

  it("a minimum that points to a preset with no max points: Needs review with a clear reason", () => {
    const s = suggestPackage({
      components: [c("gum", 1)],
      unmappedLineItems: [],
      rules: [{ productId: "gum", points: 1, minPackageId: "tube" }],
      presets,
    });
    expect(s.status).toBe("needs_review");
    expect(s.reason).toBe("Gum's smallest allowed package (Tube) has no max points set");
  });

  it("no presets with max points: Needs review", () => {
    const s = suggestPackage({ components: [c("gum", 1)], unmappedLineItems: [], rules, presets: [presets[3]] });
    expect(s.status).toBe("needs_review");
    expect(s.reason).toBe("No packages have max points set");
  });

  it("an order that resolves to zero components: Needs review", () => {
    const s = run([]);
    expect(s.status).toBe("needs_review");
    expect(s.reason).toBe("Order has no items to pack");
  });

  it("lists every Needs Review reason", () => {
    const s = run([c("pea", 1), c("paste", 20)], { unmappedLineItems: ["Gift Card"] });
    expect(s.reviewReasons).toEqual([
      "Unmapped line item: Gift Card",
      "Pea Shoots has no packaging rule",
      "Over capacity: 40 points, largest package holds 25",
    ]);
  });

  it("uses exact decimal math for fractional points", () => {
    const s = suggestPackage({
      components: [c("gum", 3)],
      unmappedLineItems: [],
      rules: [{ productId: "gum", points: "1.1", minPackageId: null }],
      presets,
    });
    expect(s.totalPoints).toBe("3.3");
    expect(s.presetName).toBe("Mailer");
  });
});

describe("validatePresetMaxPoints", () => {
  it("rejects two presets with the same max points", () => {
    const errors = validatePresetMaxPoints([
      { id: "a", nickname: "Mailer", maxPoints: 4 },
      { id: "b", nickname: "Padded Mailer", maxPoints: "4.00" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("already used by Mailer");
  });

  it("rejects zero and negative max points", () => {
    expect(validatePresetMaxPoints([{ id: "a", nickname: "Zero", maxPoints: 0 }])).toHaveLength(1);
    expect(validatePresetMaxPoints([{ id: "a", nickname: "Neg", maxPoints: -2 }])).toHaveLength(1);
  });

  it("accepts distinct positive values and presets with no max points", () => {
    expect(validatePresetMaxPoints(presets)).toEqual([]);
  });
});

describe("effectivePackage", () => {
  it("override to another package wins, override to Needs Review moves it, no override uses the suggestion", () => {
    const s = run([c("gum", 2)]);
    expect(effectivePackage(s, null, presets)).toMatchObject({ key: "mailer", overridden: false });
    expect(effectivePackage(s, { target: "preset", presetId: "big", presetName: "Big" }, presets)).toMatchObject({
      key: "big",
      label: "Big",
      overridden: true,
      suggestionLabel: "Mailer",
    });
    expect(effectivePackage(s, { target: "needs_review", presetId: null, presetName: null }, presets)).toMatchObject({
      key: "needs_review",
      overridden: true,
    });
  });

  it("an override to a preset that lost its max points falls back to Needs Review", () => {
    const s = run([c("gum", 2)]);
    expect(effectivePackage(s, { target: "preset", presetId: "tube", presetName: "Tube" }, presets).key).toBe(
      "needs_review",
    );
  });
});
