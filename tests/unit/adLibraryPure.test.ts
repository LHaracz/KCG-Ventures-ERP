// Ad Library pure modules. Invented text, invented rules and invented
// product names only (nothing from any real playbook).
import { describe, expect, it } from "vitest";
import {
  applyAssetToNeed,
  buildAutoTitle,
  displayName,
  hashPremadeText,
  mergeNeeds,
  nextFreeCode,
  premadeReadyCheck,
  reletterAlphabetically,
  scanBoth,
  unlinkAssetFromNeed,
  type AssetNeed,
  type Hits,
  type PremadeForGate,
} from "@/lib/growth/adLibrary";
import { autoFixText, keepCase, normalizeClosingLine, parseDuration, parseVisualNote, productKeyForName } from "@/lib/growth/playbookParse";
import { calendarEntriesFromPremade, pillarMix, postTypeFor, rhythmFor, scheduleHint, type PremadeForCalendar, type WindowRow } from "@/lib/growth/scheduling";
import { categoryCounts, categoryForProducts, suggestAssetsForNeed, validateAssetCategory } from "@/lib/growth/assetCategories";

describe("parseDuration", () => {
  it("ranges with en dash, em dash or hyphen", () => {
    expect(parseDuration("0:20–0:35")).toEqual({ min: 20, max: 35 });
    expect(parseDuration("0:40—0:60")).toEqual({ min: 40, max: 60 });
    expect(parseDuration("0:10 - 1:05")).toEqual({ min: 10, max: 65 });
  });
  it("a single value, garbage and empty", () => {
    expect(parseDuration("0:15")).toEqual({ min: 15, max: 15 });
    expect(parseDuration("about half a minute")).toBeNull();
    expect(parseDuration("0:40–0:20")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe("parseVisualNote", () => {
  it("a graphic and a product photo", () => {
    const r = parseVisualNote("INFO GRAPHIC - GUM PROD PIC");
    expect(r.needs.map((n) => [n.key, n.kind, n.status])).toEqual([
      ["graphic:info", "graphic", "needed"],
      ["photo:gum_product", "photo", "needed"],
    ]);
    expect(r.products).toEqual(["gum"]);
    expect(r.note).toBeNull();
  });
  it("every product tag, the BUNDLE/UNDLE typo and DROPS/SPRAY", () => {
    expect(parseVisualNote("TP PIC").products).toEqual(["toothpaste"]);
    expect(parseVisualNote("BUNDLE PIC").needs[0].key).toBe("photo:bundle_product");
    expect(parseVisualNote("UNDLE PIC").needs[0].key).toBe("photo:bundle_product");
    expect(parseVisualNote("MM RINSE PIC").products).toEqual(["mouth_rinse"]);
    expect(parseVisualNote("DROPS PIC").needs[0].key).toBe("photo:fresh_breath_product");
    expect(parseVisualNote("SPRAY PIC").products).toEqual(["fresh_breath"]);
    expect(parseVisualNote("QUOTE GRAPHIC").needs).toEqual([expect.objectContaining({ key: "graphic:quote", kind: "graphic" })]);
    expect(parseVisualNote("INFO GRAPHIC - GUM PIC").needs.map((n) => n.key)).toEqual(["graphic:info", "photo:gum_product"]);
  });
  it("unknown text comes back as a note with no needs", () => {
    expect(parseVisualNote("film at the booth")).toEqual({ needs: [], products: [], note: "film at the booth" });
    expect(parseVisualNote("")).toEqual({ needs: [], products: [], note: null });
  });
  it("product keys from product names", () => {
    expect(productKeyForName("Product A Gum")).toBe("gum");
    expect(productKeyForName("Product B Toothpaste")).toBe("toothpaste");
    expect(productKeyForName("Mouth Rinse C")).toBe("mouth_rinse");
    expect(productKeyForName("Fresh Breath Spray")).toBe("fresh_breath");
    expect(productKeyForName("Starter Bundle")).toBe("bundle");
    expect(productKeyForName("Mystery")).toBeNull();
  });
});

describe("normalizeClosingLine", () => {
  it("strips a trailing code, collapses spaces, keeps emoji", () => {
    expect(normalizeClosingLine("  Smile brighter   today 🌿 - ZZ1-12 ")).toEqual({ text: "Smile brighter today 🌿", code: "ZZ1-12" });
    expect(normalizeClosingLine("No code here!")).toEqual({ text: "No code here!", code: null });
    expect(normalizeClosingLine("Line  one").text).toBe(normalizeClosingLine("Line one").text);
  });
});

describe("autoFixText", () => {
  const rules = [
    { from: "teh", to: "the", kind: "typo" as const },
    { from: "widget drops", to: "widget spray", kind: "product_rename" as const },
    { from: "drops", to: "spray", kind: "product_rename" as const },
    { from: "#widgetlyfe", to: "#widgetlife", kind: "typo" as const },
  ];
  it("single and multiple changes with their sentence", () => {
    const r = autoFixText("Try teh widget drops. They work.", rules);
    expect(r.text).toBe("Try the widget spray. They work.");
    expect(r.changes).toEqual([
      { kind: "typo", before: "teh", after: "the", context: "Try the widget drops." },
      { kind: "product_rename", before: "widget drops", after: "widget spray", context: "Try the widget spray." },
    ]);
  });
  it("keeps case", () => {
    expect(autoFixText("DROPS PIC", rules).text).toBe("SPRAY PIC");
    expect(autoFixText("Drops are here", rules).text).toBe("Spray are here");
    expect(autoFixText("the drops", rules).text).toBe("the spray");
    expect(keepCase("Widget Drops", "widget spray")).toBe("Widget Spray");
  });
  it("whole words only, hashtags, empty text, and rules that change nothing", () => {
    expect(autoFixText("raindrops and tehran", rules).changes).toEqual([]);
    expect(autoFixText("Love it #widgetlyfe", rules).text).toBe("Love it #widgetlife");
    expect(autoFixText("", rules)).toEqual({ text: "", changes: [] });
    expect(autoFixText("nothing to see", [{ from: "same", to: "same", kind: "typo" }]).changes).toEqual([]);
    expect(autoFixText("same here", [{ from: "same", to: "same", kind: "typo" }]).changes).toEqual([]);
  });
  it("matchCase only matches the exact case", () => {
    const r = autoFixText("ZAP and zap", [{ from: "ZAP", to: "ZOP", kind: "typo", matchCase: true }]);
    expect(r.text).toBe("ZOP and zap");
    expect(r.changes).toHaveLength(1);
  });
});

describe("scanBoth", () => {
  const risky = ["miracle", "best ever"];
  const avoid = ["best ever", "fixes all"];
  it("both lists, phrases, punctuation and positions", () => {
    const r = scanBoth("The best ever widget, it fixes all! A miracle.", risky, avoid);
    expect(r.risky.map((h) => h.phrase)).toEqual(["best ever", "miracle"]);
    expect(r.avoid.map((h) => h.phrase)).toEqual(["best ever", "fixes all"]);
    expect(r.avoid[0].index).toBe(4);
  });
  it("no match inside a longer word or for a different (plural) word; empty text", () => {
    expect(scanBoth("miracles and premiracle", risky, avoid)).toEqual({ risky: [], avoid: [] });
    expect(scanBoth("", risky, avoid)).toEqual({ risky: [], avoid: [] });
  });
});

describe("hash, names and auto titles", () => {
  it("hashPremadeText is stable and changes with any text", () => {
    const p = { hook: "Hook A", caption: "Caption A", script_beats: [{ time: "0:00", beat: "Open" }] };
    expect(hashPremadeText(p)).toBe(hashPremadeText({ ...p }));
    expect(hashPremadeText(p)).not.toBe(hashPremadeText({ ...p, hook: "Hook B" }));
    expect(hashPremadeText(p)).not.toBe(hashPremadeText({ ...p, script_beats: [{ time: "0:01", beat: "Open" }] }));
    expect(hashPremadeText(p)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("displayName and buildAutoTitle", () => {
    expect(displayName("A", "Widget facts")).toBe("A - Widget facts");
    expect(buildAutoTitle("Series A", 3, "🌿 Did   you know? ✨")).toBe("Series A #3 (Did you know?)");
    expect(buildAutoTitle("Series A", 1, null)).toBe("Series A #1");
    const long = buildAutoTitle("Series A", 12, "word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).toMatch(/^Series A #12 \(word( word)*…\)$/);
  });
  it("nextFreeCode", () => {
    expect(nextFreeCode([{ id: "1", code: "A", name: "x" }, { id: "2", code: "C", name: "y" }])).toBe("B");
    expect(nextFreeCode(Array.from({ length: 26 }, (_, i) => ({ id: `${i}`, code: String.fromCharCode(65 + i), name: `${i}` })))).toBeNull();
  });
});

describe("premadeReadyCheck", () => {
  const reel: PremadeForGate = { category: "reel", hook: "H", script_beats: [{ time: "0:00", beat: "B" }], cta_text: "Shop", asset_needs: [] };
  const none: Hits = { risky: [], avoid: [] };
  const keys = (p: PremadeForGate, claims: Array<{ claim_text: string; status: string }> = [], hits = none, hash = "h") =>
    premadeReadyCheck({ premade: p, selectedClaims: claims, hits, currentTextHash: hash }).map((b) => b.key);
  it("no blockers", () => expect(keys(reel)).toEqual([]));
  it("each blocker", () => {
    expect(keys({ ...reel, hook: " " })).toEqual(["hook"]);
    expect(keys({ ...reel, script_beats: [] })).toEqual(["beats"]);
    expect(keys({ ...reel, cta_text: null })).toEqual(["cta"]);
    expect(keys({ category: "picture_post", caption: "" })).toEqual(["caption"]);
    expect(keys(reel, [{ claim_text: "Claim A", status: "draft" }])).toEqual(["claims"]);
    expect(keys({ ...reel, asset_needs: [{ key: "k", label: "L", kind: "photo", status: "needed" }] })).toEqual(["needs"]);
    expect(keys({ ...reel, needs_customer_permission: true })).toEqual(["permission"]);
    expect(keys({ ...reel, needs_customer_permission: true, permission_confirmed_at: "2026-01-01" })).toEqual([]);
    const hits = { risky: [{ phrase: "miracle", index: 0 }], avoid: [] };
    expect(keys({ ...reel, risky_ack_hash: null }, [], hits, "h1")).toEqual(["words"]);
    expect(keys({ ...reel, risky_ack_hash: "h0" }, [], hits, "h1")).toEqual(["words"]); // the text changed since
    expect(keys({ ...reel, risky_ack_hash: "h1" }, [], hits, "h1")).toEqual([]);
  });
});

describe("needs", () => {
  const n = (key: string, status: "needed" | "ready" = "needed"): AssetNeed => ({ key, label: key, kind: "graphic", status, asset_id: null });
  const items = [
    { id: "p1", asset_needs: [n("cover:s1"), n("photo:gum_product")] },
    { id: "p2", asset_needs: [n("cover:s1")] },
    { id: "p3", asset_needs: [n("cover:s1", "ready")] },
  ];
  it("mergeNeeds groups by key with counts and status", () => {
    const m = mergeNeeds(items);
    expect(m.find((x) => x.key === "cover:s1")).toMatchObject({ count: 3, readyCount: 1, status: "mixed", itemIds: ["p1", "p2", "p3"] });
    expect(m.find((x) => x.key === "photo:gum_product")).toMatchObject({ count: 1, status: "needed" });
  });
  it("apply to listed items only, then undo", () => {
    const a = applyAssetToNeed(items, "cover:s1", "asset-1", ["p1"]);
    expect(a[0].asset_needs[0]).toMatchObject({ status: "ready", asset_id: "asset-1" });
    expect(a[1].asset_needs[0].status).toBe("needed");
    expect(a[1]).toBe(items[1]);
    const u = unlinkAssetFromNeed(a, "cover:s1", ["p1"]);
    expect(u[0].asset_needs[0]).toMatchObject({ status: "needed", asset_id: null });
    expect(u[0].asset_needs[1]).toEqual(items[0].asset_needs[1]);
  });
});

describe("reletterAlphabetically", () => {
  const pillars = [
    { id: "1", code: "A", name: "Zebra Facts" },
    { id: "2", code: "B", name: "\"Apple\" & Co." },
    { id: "3", code: "C", name: "mango" },
    { id: "4", code: "D", name: "Archived One", archived_at: "2026-01-01" },
  ];
  it("orders by name ignoring case and punctuation, skips archived, lists affected items", () => {
    const r = reletterAlphabetically(pillars, [
      { id: "i1", pillar_id: "1", title: "Item one" },
      { id: "i2", pillar_id: "3", title: "Item two" },
    ]);
    expect(r.codes).toEqual({ "2": "A", "3": "B", "1": "C" });
    expect(r.changes.map((c) => [c.name, c.from, c.to])).toEqual([
      ["\"Apple\" & Co.", "B", "A"],
      ["mango", "C", "B"],
      ["Zebra Facts", "A", "C"],
    ]);
    expect(r.affectedItems).toEqual([
      { id: "i1", before: "A - Item one", after: "C - Item one" },
      { id: "i2", before: "C - Item two", after: "B - Item two" },
    ]);
  });
  it("more than 26 pillars is refused", () => {
    expect(() => reletterAlphabetically(Array.from({ length: 27 }, (_, i) => ({ id: `${i}`, code: "A", name: `P${i}` })))).toThrow(/more than 26/);
  });
});

describe("calendarEntriesFromPremade", () => {
  const base: PremadeForCalendar = {
    id: "p1", title: "Widget facts", pillar_code: "A", category: "reel", picture_format: null, intent: "organic",
    status: "drafting", business: "botaniqals", caption: "Cap", hashtags: "", products_mentioned: ["gum"],
  };
  const run = (over: Partial<PremadeForCalendar>, blockers: Array<{ key: string; message: string }> = [], platforms = ["instagram"]) =>
    calendarEntriesFromPremade({ premade: { ...base, ...over }, series: { default_hashtags: "#serieswide" }, date: "2026-12-01", time: "09:30", platforms, owner: "o1", gateResult: { blockers }, now: "2026-11-17T12:00:00.000Z" });
  it("status and type mappings", () => {
    const ok = (r: ReturnType<typeof run>) => (r.ok ? r : (() => { throw new Error(r.error); })());
    expect(ok(run({ status: "idea" })).rows[0]).toMatchObject({ status: "idea", post_type: "reel" });
    expect(ok(run({})).rows[0].status).toBe("scripting");
    expect(ok(run({ category: "picture_post", picture_format: "single_image" })).rows[0]).toMatchObject({ status: "editing", post_type: "post" });
    expect(ok(run({ category: "picture_post", picture_format: "story" })).rows[0].post_type).toBe("story");
    expect(ok(run({ intent: "paid" })).rows[0].post_type).toBe("ad");
    expect(ok(run({ status: "ready" })).rows[0]).toMatchObject({ status: "ready", risky_words_checked: true });
    const blocked = ok(run({ status: "ready" }, [{ key: "needs", message: "1 asset is still needed" }]));
    expect(blocked.rows[0].status).toBe("editing");
    expect(blocked.warnings).toEqual(["1 asset is still needed"]);
  });
  it("one entry per platform, display name, hashtags fallback, sync fields", () => {
    const r = run({}, [], ["instagram", "tiktok", "instagram"]);
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => x.platform)).toEqual(["instagram", "tiktok"]);
    expect(r.rows[0]).toMatchObject({ title: "A - Widget facts", hashtags: "#serieswide", premade_post_id: "p1", premade_synced_at: "2026-11-17T12:00:00.000Z", scheduled_time: "09:30", owner_account_id: "o1", notes: "Products: gum" });
  });
  it("paused items and missing platforms are refused", () => {
    expect(run({ status: "paused" })).toEqual({ ok: false, error: expect.stringMatching(/paused/) });
    expect(run({}, [], [])).toEqual({ ok: false, error: expect.stringMatching(/platform/) });
    expect(postTypeFor({ category: "picture_post", intent: "both", picture_format: "carousel" })).toBe("post");
  });
});

describe("scheduleHint", () => {
  // 2026-12-01 is a Tuesday.
  const w = (over: Partial<WindowRow>): WindowRow => ({ day_of_week: 2, platform: "tiktok", window_text: "2 to 6pm", ranges: [{ start: "14:00", end: "18:00" }], quality: "peak", ...over });
  const hint = (time: string | null, rows: WindowRow[], platform = "tiktok", intent: string | null = "organic") => scheduleHint({ date: "2026-12-01", time, platform, windows: rows, intent });
  it("in, outside, a second range, and the boundary minute", () => {
    expect(hint("15:00", [w({})]).state).toBe("in_window");
    expect(hint("15:00", [w({})]).message).toMatch(/^Tuesday on TikTok: 2 to 6pm \(peak\)/);
    expect(hint("10:00", [w({})]).state).toBe("outside_window");
    expect(hint("23:30", [w({ ranges: [{ start: "14:00", end: "18:00" }, { start: "23:00", end: "23:59", note: "spike" }] })]).state).toBe("in_window");
    expect(hint("18:00", [w({})]).state).toBe("in_window");
    expect(hint("18:01", [w({})]).state).toBe("outside_window");
  });
  it("avoid, weak, none, no time, paid and no data", () => {
    expect(hint("15:00", [w({ quality: "avoid" })]).state).toBe("avoid");
    expect(hint("15:00", [w({ quality: "weak" })]).state).toBe("weak");
    expect(hint("15:00", [w({ quality: "none", window_text: "no reliable peak", ranges: [] })]).state).toBe("no_data");
    expect(hint(null, [w({})])).toMatchObject({ state: "no_data", windowsText: "2 to 6pm" });
    expect(hint("15:00", [w({})], "tiktok", "paid").state).toBe("paid_skip");
    expect(hint("15:00", [w({})], "youtube").state).toBe("no_data");
  });
});

describe("rhythmFor and pillarMix", () => {
  const rows = [
    { id: "r1", days: [2], label: "Tuesday thing", pillar_ids: ["pA"], active: true },
    { id: "r2", days: [4, 5], label: "Off", pillar_ids: [], active: false },
  ];
  it("rhythmFor picks the active row for the weekday", () => {
    expect(rhythmFor("2026-12-01", rows)?.id).toBe("r1");
    expect(rhythmFor("2026-12-03", rows)).toBeNull(); // Thursday row is inactive
  });
  it("pillarMix counts library entries past Idea, with zeros", () => {
    const pillars = [{ id: "pA", code: "A", name: "Alpha" }, { id: "pB", code: "B", name: "Beta" }];
    const posts = [
      { scheduled_date: "2026-11-10", status: "ready", premade_post_id: "x", pillar_id: "pA" },
      { scheduled_date: "2026-11-11", status: "idea", premade_post_id: "x", pillar_id: "pA" },
      { scheduled_date: "2026-11-12", status: "posted", premade_post_id: null, pillar_id: null },
      { scheduled_date: "2026-10-01", status: "posted", premade_post_id: "y", pillar_id: "pA" },
    ];
    expect(pillarMix({ posts, pillars, from: "2026-11-01", to: "2026-11-28" }).map((p) => [p.code, p.count])).toEqual([["A", 1], ["B", 0]]);
  });
});

describe("asset categories", () => {
  const v = (over: Record<string, unknown>) => validateAssetCategory({ category: "product", productIds: [], ingredientIds: [], ...over } as never);
  it("each category's rule", () => {
    expect(v({ productIds: ["a"] })).toEqual({});
    expect(v({ productIds: [] }).products).toMatch(/exactly one/);
    expect(v({ productIds: ["a", "b"] }).products).toMatch(/exactly one/);
    expect(v({ category: "group_product", productIds: ["a"] }).products).toMatch(/two or more/);
    expect(v({ category: "group_product", productIds: ["a"], isFullLineup: true })).toEqual({});
    expect(v({ category: "group_product", productIds: ["a", "b"] })).toEqual({});
    expect(v({ category: "ingredient" }).ingredients).toBeTruthy();
    expect(v({ category: "ingredient", ingredientIds: ["t"], productIds: ["a", "b"] })).toEqual({});
    expect(v({ category: "market" })).toEqual({});
    expect(v({ category: "retail", contextLabel: "Store A" })).toEqual({});
    expect(v({ category: "other" }).context_label).toBeTruthy();
    expect(v({ category: "other", contextLabel: "Team photo" })).toEqual({});
    expect(v({ category: "" }).category).toBeTruthy();
    expect(v({ category: "", requireCategory: false })).toEqual({});
    expect(v({ category: "nonsense" }).category).toBeTruthy();
  });
  it("suggestions rank product, then type, then newest; archived left out", () => {
    const assets = [
      { id: "old-photo", asset_type: "photo", status: "ready", created_at: "2026-01-01", product_names: [] },
      { id: "new-photo", asset_type: "photo", status: "draft", created_at: "2026-06-01", product_names: [] },
      { id: "gum-video", asset_type: "video", status: "ready", created_at: "2026-02-01", product_names: ["Product A Gum"] },
      { id: "gum-photo", asset_type: "photo", status: "ready", created_at: "2025-01-01", product_names: ["Product A Gum"] },
      { id: "gone", asset_type: "photo", status: "archived", created_at: "2026-09-01", product_names: ["Product A Gum"] },
    ];
    expect(suggestAssetsForNeed({ kind: "photo" }, { products_mentioned: ["gum"] }, assets).map((a) => a.id)).toEqual(["gum-photo", "gum-video", "new-photo", "old-photo"]);
  });
  it("counts and the prefilled category", () => {
    expect(categoryCounts([{ category: "product" }, { category: null }, { category: "retail" }, { category: "product" }])).toEqual({
      all: 4, product: 2, group_product: 0, ingredient: 0, market: 0, retail: 1, other: 0, uncategorized: 1,
    });
    expect([categoryForProducts(0), categoryForProducts(1), categoryForProducts(3)]).toEqual([null, "product", "group_product"]);
  });
});
