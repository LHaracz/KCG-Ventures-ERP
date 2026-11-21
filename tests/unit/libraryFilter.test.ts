// The Ad Library's shared filter and sort: Copy captions lists exactly what
// the table lists. Invented data only.
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, copyList, libraryList, libraryMatches, type LibPost, type LibraryFilters } from "@/lib/growth/libraryFilter";
import { buildCopyText, stripTrailingHashtagBlock } from "@/lib/growth/naming";

let seq = 0;
const post = (over: Partial<LibPost>): LibPost => {
  seq += 1;
  return {
    id: `p${seq}`,
    category: "picture_post",
    status: "drafting",
    intent: "organic",
    pillar_id: "pA",
    series_id: null,
    archived_at: null,
    created_at: `2026-01-${String(seq).padStart(2, "0")}`,
    name: `A-${seq}`,
    pillarCode: "A",
    subtopicCode: null,
    subtopicName: null,
    post_number: seq,
    title: null,
    name_history: [],
    caption: `Caption ${seq}\n\n#sampletag`,
    product_ids: [],
    openNeeds: 0,
    needsPermission: false,
    avoidHits: 0,
    watchHits: 0,
    openFlagKeys: [],
    duplicate: false,
    scheduled: false,
    ...over,
  };
};

const posts: LibPost[] = [
  post({ name: "AA-10", subtopicCode: "A", series_id: "sA", subtopicName: "Topic X basics", post_number: 10 }),
  post({ name: "AA-2", subtopicCode: "A", series_id: "sA", subtopicName: "Topic X basics", post_number: 2, caption: "Talks about mint" }),
  post({ name: "A-3", post_number: 3 }),
  post({ name: "B-1", pillar_id: "pB", pillarCode: "B", post_number: 1, status: "paused" }),
  post({ name: "BA-1", pillar_id: "pB", pillarCode: "B", series_id: "sB", subtopicCode: "A", post_number: 1, category: "reel" }),
  post({ name: "A-4", post_number: 4, archived_at: "2026-02-01" }),
  post({ name: "AA-3", subtopicCode: "A", series_id: "sA", post_number: 3, caption: "", openNeeds: 1 }),
];
const f = (over: Partial<LibraryFilters>): LibraryFilters => ({ ...DEFAULT_FILTERS, cat: "picture_post", ...over });
const names = (list: LibPost[]) => list.map((p) => p.name);
const copyNames = (filters: LibraryFilters, both = false) => names(copyList(posts, filters, both));

describe("libraryFilter and librarySort", () => {
  it("sorts by name with no subtopic first and numbers as numbers", () => {
    expect(names(libraryList(posts, f({})))).toEqual(["A-3", "AA-2", "AA-3", "AA-10"]);
    expect(names(libraryList(posts, f({ sort: "newest" })))).toEqual(["AA-3", "A-3", "AA-2", "AA-10"]);
  });
  it("All topics, one topic, topic plus subtopic, and No subtopic yet", () => {
    expect(names(libraryList(posts, f({ topic: "pA" })))).toEqual(["A-3", "AA-2", "AA-3", "AA-10"]);
    expect(names(libraryList(posts, f({ topic: "pA", subtopic: "sA" })))).toEqual(["AA-2", "AA-3", "AA-10"]);
    expect(names(libraryList(posts, f({ subtopic: "none" })))).toEqual(["A-3"]);
  });
  it("status, search, needs attention, and paused hidden unless shown", () => {
    expect(names(libraryList(posts, f({ status: "paused" })))).toEqual([]);
    expect(names(libraryList(posts, f({ status: "paused", paused: true })))).toEqual(["B-1"]);
    expect(names(libraryList(posts, f({ q: "mint" })))).toEqual(["AA-2"]);
    expect(names(libraryList(posts, f({ q: "aa10" })))).toEqual(["AA-10"]);
    expect(names(libraryList(posts, f({ att: ["needs"] })))).toEqual(["AA-3"]);
    expect(libraryMatches(posts[0], f({ att: ["needs"] }), "needs")).toBe(true);
  });
  it("the copy list equals the table list for every combination", () => {
    const combos: Array<Partial<LibraryFilters>> = [{}, { topic: "pA" }, { topic: "pA", subtopic: "sA" }, { subtopic: "none" }, { status: "drafting" }, { q: "caption" }, { paused: true }, { cat: "reel" }];
    for (const c of combos) expect(copyNames(f(c))).toEqual(names(libraryList(posts, f(c))));
  });
  it("with both tabs: Picture posts first, then Reels, each in name order", () => {
    expect(copyNames(f({ sort: "newest" }), true)).toEqual(["A-3", "AA-2", "AA-3", "AA-10", "BA-1"]);
  });
  it("copies caption bodies only, separated by blank lines, skipping empty ones", () => {
    const list = copyList(posts, f({ topic: "pA", subtopic: "sA" }), false);
    const r = buildCopyText(list.map((p) => ({ name: p.name, body: stripTrailingHashtagBlock(p.caption).body })), { includeNames: false });
    expect(r).toEqual({ text: "Talks about mint\n\nCaption 1", copied: 2, skipped: 1 });
  });
});
