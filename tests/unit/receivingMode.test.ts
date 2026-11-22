// Receiving Log modes by COA policy (pure): each policy, no listing, a
// correction keeping its mode, "Use the full form", old receipts with no
// mode, the supplier order and the simple quantity rule. Invented data only.
import { describe, expect, it } from "vitest";
import { coaPolicyLabel, receivingModeFor, sortSuppliersForPicker, validSimpleQuantity } from "@/lib/receivingMode";

describe("receivingModeFor", () => {
  it("each policy", () => {
    expect(receivingModeFor({ policy: "included", hasListing: true })).toEqual({ mode: "full", policy: "included", reason: "policy_full" });
    expect(receivingModeFor({ policy: "request", hasListing: true })).toEqual({ mode: "full", policy: "request", reason: "policy_full" });
    expect(receivingModeFor({ policy: "not_available", hasListing: true })).toEqual({ mode: "simple", policy: "not_available", reason: "policy_simple" });
    expect(receivingModeFor({ policy: "unknown", hasListing: true })).toEqual({ mode: "simple", policy: "unknown", reason: "policy_simple" });
  });
  it("no listing for the pair is simple", () => {
    expect(receivingModeFor({ policy: null, hasListing: false })).toEqual({ mode: "simple", policy: null, reason: "no_listing" });
  });
  it("Use the full form", () => {
    expect(receivingModeFor({ policy: "not_available", hasListing: true, forcedFull: true })).toMatchObject({ mode: "full", reason: "forced_full" });
    expect(receivingModeFor({ policy: null, hasListing: false, forcedFull: true })).toMatchObject({ mode: "full", reason: "forced_full" });
  });
  it("a correction keeps the original mode, whatever the policy says now", () => {
    expect(receivingModeFor({ isCorrection: true, existingEntryMode: "simple", policy: "included", hasListing: true })).toMatchObject({ mode: "simple", reason: "correction" });
    expect(receivingModeFor({ isCorrection: true, existingEntryMode: "full", policy: "not_available", hasListing: true, forcedFull: false })).toMatchObject({ mode: "full", reason: "correction" });
  });
  it("an old receipt with no mode is a full receipt", () => {
    expect(receivingModeFor({ isCorrection: true, existingEntryMode: null, policy: "unknown", hasListing: true })).toMatchObject({ mode: "full", reason: "correction" });
  });
});

describe("helpers", () => {
  it("labels, supplier order and the simple quantity", () => {
    expect([coaPolicyLabel("included"), coaPolicyLabel("request"), coaPolicyLabel("not_available"), coaPolicyLabel(null)]).toEqual([
      "Provided automatically",
      "Must request",
      "Not provided",
      "Unknown",
    ]);
    const list = [
      { name: "supplier c", is_pinned: false },
      { name: "Supplier B", is_pinned: true },
      { name: "Supplier A", is_pinned: false },
      { name: "Supplier Z", is_pinned: true },
    ];
    expect(sortSuppliersForPicker(list).map((s) => s.name)).toEqual(["Supplier B", "Supplier Z", "Supplier A", "supplier c"]);
    expect([validSimpleQuantity("12"), validSimpleQuantity("0.125"), validSimpleQuantity(".5"), validSimpleQuantity("1.2345"), validSimpleQuantity("0"), validSimpleQuantity("-1"), validSimpleQuantity("x")]).toEqual([
      12, 0.125, 0.5, null, null, null, null,
    ]);
  });
});
