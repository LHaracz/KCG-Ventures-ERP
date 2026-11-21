// Marketing Hub naming, hashtag and caption helpers. Invented data only.
import { describe, expect, it } from "vitest";
import {
  buildCopyText,
  captionSnippet,
  captionView,
  compareNames,
  composeFinalCaption,
  fileKindOf,
  findDuplicateNames,
  matchesPostSearch,
  mergeHashtags,
  nextSubtopicLetter,
  paginate,
  parseHashtags,
  planConversion,
  postName,
  previewMove,
  scheduleGroupDiff,
  stripTrailingHashtagBlock,
} from "@/lib/growth/naming";

describe("names", () => {
  it("postName with and without a subtopic, no zero padding", () => {
    expect(postName("A", "A", 1)).toBe("AA-1");
    expect(postName("B", null, 12)).toBe("B-12");
  });
  it("nextSubtopicLetter takes the next unused letter, keeps archived ones, and stops after Z", () => {
    expect(nextSubtopicLetter([])).toBe("A");
    expect(nextSubtopicLetter(["A", "B"])).toBe("C");
    expect(nextSubtopicLetter(["A", null, "C"])).toBe("B");
    const all = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    expect(() => nextSubtopicLetter(all)).toThrow(/26 subtopics/);
  });
  it("sorts by topic, then subtopic (none first), then number as a number", () => {
    const keys = [
      { pillarCode: "A", subtopicCode: "A", number: 10 },
      { pillarCode: "B", subtopicCode: null, number: 1 },
      { pillarCode: "A", subtopicCode: "A", number: 2 },
      { pillarCode: "A", subtopicCode: null, number: 3 },
      { pillarCode: "A", subtopicCode: "B", number: 1 },
    ];
    expect([...keys].sort(compareNames).map((k) => postName(k.pillarCode, k.subtopicCode, k.number))).toEqual(["A-3", "AA-2", "AA-10", "AB-1", "B-1"]);
  });
});

describe("hashtags", () => {
  it("parses spaces, commas and lines; drops punctuation; adds a missing #; reports invalid tokens", () => {
    expect(parseHashtags("#sampletag, othertag.\n#third_tag #SampleTag 1. bad-tag #!")).toEqual({ tags: ["#sampletag", "#othertag", "#third_tag"], invalid: ["1.", "bad-tag", "#!"] });
    expect(parseHashtags("")).toEqual({ tags: [], invalid: [] });
  });
  it("merges in order, removing duplicates in another case and keeping the first spelling", () => {
    expect(mergeHashtags([["#TopicTag", "#shared"], ["#Shared", "#product"], ["#legacy", "#topictag"]])).toEqual(["#TopicTag", "#shared", "#product", "#legacy"]);
  });
  it("composes the final caption: body, two blank lines, then the tags", () => {
    const out = composeFinalCaption("Closing line here.  \n\n", ["#sampletag", "#other"]);
    expect(out).toBe("Closing line here.\n\n\n#sampletag #other");
    expect(out.split("\n").length - 1).toBe(3);
  });
  it("skips a tag already in the body (whole tag, any case), and gives just the body when none remain", () => {
    expect(composeFinalCaption("Use #SampleTag today", ["#sampletag", "#sample"])).toBe("Use #SampleTag today\n\n\n#sample");
    expect(composeFinalCaption("Use #sampletag", ["#sampletag"])).toBe("Use #sampletag");
  });
  it("an empty body gives no caption at all", () => {
    expect(composeFinalCaption("  \n", ["#sampletag"])).toBe("");
    expect(composeFinalCaption(null, [])).toBe("");
  });
});

describe("stripTrailingHashtagBlock", () => {
  it("leaves text with no hashtags alone", () => {
    expect(stripTrailingHashtagBlock("Line one\nLine two\n\n")).toEqual({ body: "Line one\nLine two", hashtags: [], hashtagsOnly: false });
  });
  it("removes a trailing hashtag line after a closing line", () => {
    expect(stripTrailingHashtagBlock("Caption body\n\nClosing line ✨\n\n#tagone #tagtwo.")).toEqual({ body: "Caption body\n\nClosing line ✨", hashtags: ["#tagone", "#tagtwo"], hashtagsOnly: false });
  });
  it("removes a trailing block of several lines", () => {
    expect(stripTrailingHashtagBlock("Body\n#a #b\n\n#c,\n#d")).toEqual({ body: "Body", hashtags: ["#a", "#b", "#c", "#d"], hashtagsOnly: false });
  });
  it("keeps hashtags inside a sentence and a last line that mixes words and hashtags", () => {
    expect(stripTrailingHashtagBlock("We love #sampletag a lot")).toEqual({ body: "We love #sampletag a lot", hashtags: [], hashtagsOnly: false });
    expect(stripTrailingHashtagBlock("Body\nFollow us #sampletag")).toEqual({ body: "Body\nFollow us #sampletag", hashtags: [], hashtagsOnly: false });
  });
  it("handles emoji lines and Windows line endings", () => {
    expect(stripTrailingHashtagBlock("Body\r\n🌿✨\r\n#tag\r\n")).toEqual({ body: "Body\n🌿✨", hashtags: ["#tag"], hashtagsOnly: false });
  });
  it("only hashtags, and empty text", () => {
    expect(stripTrailingHashtagBlock("#a #b\n#c")).toEqual({ body: "", hashtags: ["#a", "#b", "#c"], hashtagsOnly: true });
    expect(stripTrailingHashtagBlock("")).toEqual({ body: "", hashtags: [], hashtagsOnly: false });
  });
  it("captionView: the body without hashtags and how many hashtags posting adds", () => {
    expect(captionView({ caption: "Body with #one\n\n#two" }, ["#one", "#two", "#three", "#four"])).toEqual({ body: "Body with #one", extraTagCount: 2, hashtagsOnly: false });
    expect(captionView({ caption: null }, ["#one"])).toEqual({ body: "", extraTagCount: 0, hashtagsOnly: false });
  });
});

describe("snippets and copying", () => {
  it("cuts at 100 user-perceived characters without splitting emoji, line breaks as spaces", () => {
    const text = `${"a".repeat(99)}👍🏽 tail`;
    expect(captionSnippet(text, 100)).toEqual({ snippet: `${"a".repeat(99)}👍🏽`, truncated: true });
    expect(captionSnippet("Line one\nLine two", 100)).toEqual({ snippet: "Line one Line two", truncated: false });
  });
  it("joins captions with one blank line, skips empty ones, no trailing newline", () => {
    const r = buildCopyText(
      [
        { name: "AA-1", body: "\n\nFirst caption  \nsecond line\n\n" },
        { name: "AA-2", body: "  \n " },
        { name: "AA-3", body: "Third\r\n\r\nwith a blank line 🌿" },
      ],
      { includeNames: false },
    );
    expect(r).toEqual({ text: "First caption\nsecond line\n\nThird\n\nwith a blank line 🌿", copied: 2, skipped: 1 });
  });
  it("adds the name above each caption when asked", () => {
    expect(buildCopyText([{ name: "AA-1", body: "One" }, { name: "B-2", body: "Two" }], { includeNames: true }).text).toBe("AA-1\nOne\n\nB-2\nTwo");
  });
  it("all empty: nothing copied", () => {
    expect(buildCopyText([{ name: "A-1", body: "" }, { name: "A-2", body: null }], { includeNames: false })).toEqual({ text: "", copied: 0, skipped: 2 });
  });
});

describe("search and duplicates", () => {
  const post = { name: "AA-1", name_history: [{ name: "A - Imported title" }], title: "Imported title", subtopicName: "Topic X basics", caption: "A caption about mint\n\n#sampletag" };
  it("matches the name with or without the dash, previous names, title, subtopic and caption body", () => {
    expect(matchesPostSearch(post, "aa1")).toBe(true);
    expect(matchesPostSearch(post, "AA-1")).toBe(true);
    expect(matchesPostSearch({ ...post, name: "AA-10" }, "aa-1")).toBe(false);
    expect(matchesPostSearch(post, "imported")).toBe(true);
    expect(matchesPostSearch(post, "basics")).toBe(true);
    expect(matchesPostSearch(post, "MINT")).toBe(true);
    expect(matchesPostSearch(post, "sampletag")).toBe(false);
    expect(matchesPostSearch(post, "")).toBe(true);
  });
  it("finds names shared by non-archived posts", () => {
    expect(findDuplicateNames([{ id: "1", name: "A-1" }, { id: "2", name: "A-1" }, { id: "3", name: "A-1", archived_at: "x" }, { id: "4", name: "A-2" }])).toEqual([{ name: "A-1", ids: ["1", "2"] }]);
  });
});

describe("assets and pages", () => {
  it("file kinds from the type and source", () => {
    expect(fileKindOf({ source: "link", mime_type: null })).toBe("link");
    expect(fileKindOf({ source: "upload", mime_type: "image/gif" })).toBe("gif");
    expect(fileKindOf({ source: "upload", mime_type: "image/heic" })).toBe("image");
    expect(fileKindOf({ source: "upload", mime_type: "video/mp4" })).toBe("video");
    expect(fileKindOf({ source: "upload", mime_type: "application/pdf" })).toBe("pdf");
  });
  it("pages of 20, clamped at both ends", () => {
    expect(paginate(0, 1)).toEqual({ page: 1, pages: 1, from: 0, to: 0, size: 20 });
    expect(paginate(45, 3)).toEqual({ page: 3, pages: 3, from: 40, to: 45, size: 20 });
    expect(paginate(45, 9).page).toBe(3);
    expect(paginate(45, 0).page).toBe(1);
    expect(paginate(40, 2)).toMatchObject({ from: 20, to: 40, pages: 2 });
  });
});

describe("schedule groups", () => {
  it("adds, keeps and archives platforms; Posted rows are locked", () => {
    const rows = [
      { id: "1", platform: "instagram", status: "scheduled" },
      { id: "2", platform: "facebook", status: "posted" },
      { id: "3", platform: "tiktok", status: "scheduled" },
      { id: "4", platform: "youtube", status: "scheduled", archived_at: "x" },
    ];
    const d = scheduleGroupDiff(rows, ["instagram", "youtube"]);
    expect(d.add).toEqual(["youtube"]);
    expect(d.keep.map((r) => r.id)).toEqual(["1"]);
    expect(d.archive.map((r) => r.id)).toEqual(["3"]);
    expect(d.locked.map((r) => r.id)).toEqual(["2"]);
    expect(scheduleGroupDiff(rows, ["facebook"]).add).toEqual([]);
  });
});

describe("moving posts (preview)", () => {
  const pillars = [{ id: "pA", code: "A", last_unsorted_post_number: 2 }];
  const subtopics = [{ id: "sA", pillar_id: "pA", code: "A", last_post_number: 5 }];
  const posts = [
    { id: "x", pillar_id: "pA", series_id: null, post_number: 2, created_at: "2026-01-02" },
    { id: "y", pillar_id: "pA", series_id: null, post_number: 1, created_at: "2026-01-01" },
  ];
  it("renumbers in name order from the group's counter", () => {
    expect(previewMove({ posts, pillars, subtopics, target: { pillarId: "pA", subtopicId: "sA" } }).moves).toEqual([
      { id: "y", oldName: "A-1", newName: "AA-6" },
      { id: "x", oldName: "A-2", newName: "AA-7" },
    ]);
  });
  it("a new subtopic gets the next letter and starts at 1; posts already in the group are skipped", () => {
    const r = previewMove({ posts, pillars, subtopics, target: { pillarId: "pA", subtopicId: null, newSubtopicName: "Topic X" } });
    expect(r.subtopicCode).toBe("B");
    expect(r.moves.map((m) => m.newName)).toEqual(["AB-1", "AB-2"]);
    expect(previewMove({ posts, pillars, subtopics, target: { pillarId: "pA", subtopicId: null } }).moves).toEqual([]);
  });
});

describe("planConversion", () => {
  it("letters by sort order, numbers by position then order, archived included, counters set", () => {
    const plan = planConversion(
      [{ id: "pA", code: "A" }],
      [
        { id: "s2", pillar_id: "pA", code: null, sort_order: 2, created_at: "2026-01-01" },
        { id: "s1", pillar_id: "pA", code: null, sort_order: 1, created_at: "2026-01-01" },
      ],
      [
        { id: "a", pillar_id: "pA", series_id: "s1", series_position: null, sort_order: 1, created_at: "2026-01-01", post_number: null, title: "T1" },
        { id: "b", pillar_id: "pA", series_id: "s1", series_position: 1, sort_order: 9, created_at: "2026-01-01", post_number: null, title: "T2", archived_at: "x" },
        { id: "c", pillar_id: "pA", series_id: null, series_position: null, sort_order: 2, created_at: "2026-01-01", post_number: null, title: "T3" },
        { id: "d", pillar_id: "pA", series_id: null, series_position: null, sort_order: 1, created_at: "2026-01-01", post_number: null, title: "T4" },
      ],
    );
    expect(plan.subtopicCodes).toEqual({ s1: "A", s2: "B" });
    expect(plan.posts.map((p) => `${p.oldName}>${p.newName}`)).toEqual(["A - T2>AA-1", "A - T1>AA-2", "A - T4>A-1", "A - T3>A-2"]);
    expect(plan.subtopicCounters).toEqual({ s1: 2 });
    expect(plan.pillarCounters).toEqual({ pA: 2 });
  });
  it("reports posts whose subtopic is in another topic, and continues after numbers already used", () => {
    const plan = planConversion(
      [{ id: "pA", code: "A" }, { id: "pB", code: "B" }],
      [{ id: "sB", pillar_id: "pB", code: "A", sort_order: 0, created_at: "2026-01-01" }],
      [
        { id: "x", pillar_id: "pA", series_id: "sB", series_position: null, sort_order: 0, created_at: "2026-01-01", post_number: null, title: "Wrong" },
        { id: "y", pillar_id: "pB", series_id: null, series_position: null, sort_order: 0, created_at: "2026-01-01", post_number: 3, title: null },
        { id: "z", pillar_id: "pB", series_id: null, series_position: null, sort_order: 1, created_at: "2026-01-01", post_number: null, title: "New" },
      ],
    );
    expect(plan.mismatched).toEqual(["x"]);
    expect(plan.posts.map((p) => p.newName)).toEqual(["B-4"]);
  });
});
