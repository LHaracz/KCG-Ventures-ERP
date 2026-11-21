// Ad Library values computed in the browser: hashtags in the server's order,
// the final caption, the gate on the final caption, table rows, and what a
// calendar entry shows (live until Posted, frozen after). Invented data only.
import { describe, expect, it } from "vitest";
import { entryView, finalCaptionOf, gateView, productHashtags, tagsForPost, toLibRows, type ViewData, type ViewPost } from "@/lib/growth/libraryView";

const data: ViewData = {
  pillars: [{ id: "pA", code: "A", name: "Topic A", archived_at: null }],
  series: [{ id: "sA", pillar_id: "pA", code: "A", name: "Subtopic A", default_hashtags: "#tagone #tagtwo", archived_at: null }],
  products: [
    { id: "prB", name: "Product B" },
    { id: "prA", name: "Product A" },
  ],
  profiles: [
    { formulation_product_id: "prA", hashtags: "#tagthree #TagOne" },
    { formulation_product_id: "prB", hashtags: "#tagfour" },
  ],
  riskyWords: [{ phrase: "miracle", archived_at: null }],
  avoidPhrases: [{ phrase: "tagfour", archived_at: null }],
  duplicateNames: [{ name: "A-1", post_ids: ["p2"] }],
};
const post = (over: Partial<ViewPost> = {}): ViewPost => ({
  id: "p1",
  category: "picture_post",
  pillar_id: "pA",
  series_id: "sA",
  product_ids: ["prB", "prA"],
  hashtags: "#tagfive",
  hook: null,
  caption: "Body text",
  script_beats: [],
  asset_needs: [],
  needs_customer_permission: false,
  permission_confirmed_at: null,
  risky_ack_hash: null,
  ...over,
});

describe("hashtags and the final caption", () => {
  it("products in name order, then subtopic first, products, legacy last, no repeats", () => {
    expect(productHashtags(data, ["prB", "prA"])).toEqual(["#tagthree #TagOne", "#tagfour"]);
    expect(tagsForPost(data, post())).toEqual(["#tagone", "#tagtwo", "#tagthree", "#tagfour", "#tagfive"]);
    expect(finalCaptionOf(data, post())).toBe("Body text\n\n\n#tagone #tagtwo #tagthree #tagfour #tagfive");
    expect(finalCaptionOf(data, post({ caption: "" }))).toBe("");
  });
  it("the gate scans the FINAL caption, so a hashtag on the avoid list counts", () => {
    const g = gateView(data, post());
    expect(g.hits.avoid.map((h) => h.phrase)).toEqual(["tagfour"]);
    expect(g.blockers.map((b) => b.key)).toEqual(["words"]);
    expect(gateView(data, post({ risky_ack_hash: g.hash })).blockers).toEqual([]);
    expect(gateView(data, post({ product_ids: [] })).blockers).toEqual([]);
  });
});

describe("table rows", () => {
  it("codes, attention counts and duplicates", () => {
    const base = { status: "drafting", intent: "organic", archived_at: null, created_at: "2026-11-01", post_number: 1, title: null, name_history: [], next_scheduled: null, last_posted: null };
    const rows = toLibRows(data, [
      { ...post(), ...base, name: "AA-1", flags: [{ flag_key: "typo_fixed", dismissed_at: null }], asset_needs: [{ key: "k", label: "L", kind: "photo", status: "needed" }] },
      { ...post({ id: "p2", series_id: null }), ...base, name: "A-1", flags: [], needs_customer_permission: true },
    ]);
    expect(rows[0]).toMatchObject({ pillarCode: "A", subtopicCode: "A", subtopicName: "Subtopic A", openNeeds: 1, openFlagKeys: ["typo_fixed"], avoidHits: 1, duplicate: false, scheduled: false });
    expect(rows[1]).toMatchObject({ subtopicCode: null, needsPermission: true, duplicate: true });
  });
});

describe("calendar entries", () => {
  const premades = [{ id: "p1", name: "AA-2", caption: "Body text", series_id: "sA", product_ids: [], hashtags: null }];
  it("a library entry that isn't Posted shows the live name and final caption; the stored title is only a fallback", () => {
    expect(entryView(data, { title: "AA-1", caption: null, hashtags: null, status: "scheduled", premade_post_id: "p1" }, premades)).toEqual({ name: "AA-2", caption: "Body text\n\n\n#tagone #tagtwo", live: true });
  });
  it("a Posted entry shows its frozen values; an entry without a library post shows what is stored", () => {
    expect(entryView(data, { title: "AA-1", caption: "Old body\n\n\n#old", hashtags: null, status: "posted", premade_post_id: "p1" }, premades)).toEqual({ name: "AA-1", caption: "Old body\n\n\n#old", live: false });
    expect(entryView(data, { title: "Plain entry", caption: "Text", hashtags: "#x", status: "idea", premade_post_id: null }, premades)).toEqual({ name: "Plain entry", caption: "Text\n\n#x", live: false });
    expect(entryView(data, { title: "Gone", caption: null, hashtags: null, status: "scheduled", premade_post_id: "missing" }, premades).name).toBe("Gone");
  });
});
