// @vitest-environment jsdom
// Marketing Hub naming build, in the browser: the caption column (100
// characters, "...more", hook fallback, no hashtags in the table), Copy
// captions (exact text, count, options, fallback), the Edit caption popup
// (only the caption, conflicts, restore, shortcuts), Topic and Subtopic
// filters from the page address, the Actions menu, the hashtag field, the
// post form's next name, the asset card picker (20 per page, selection
// across pages, single mode) and calendar scheduling (platform chips,
// Schedule anyway, Mark posted). Components rendered with React in jsdom;
// API calls mocked. Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  updateCaptionApi: vi.fn(),
  captionHistoryApi: vi.fn(async () => ({ versions: [] as unknown[] })),
  assetPickerApi: vi.fn(),
  signedAssetUrlsApi: vi.fn(async () => ({ urls: {} })),
  scheduleFromLibraryApi: vi.fn(async () => ({ ids: ["e1", "e2"], group_id: "g1" })),
  editScheduleApi: vi.fn(async () => ({ added: 1, archived: 0, updated: 1 })),
  markPostedApi: vi.fn(async () => ({ ok: true })),
  removeFromCalendarApi: vi.fn(async () => ({ removed: 1 })),
  premadeActionApi: vi.fn(),
  premadeBulkApi: vi.fn(),
  needsActionApi: vi.fn(),
}));
const urlState = vi.hoisted(() => ({ params: {} as Record<string, string>, set: vi.fn() }));
vi.mock("@/lib/growth/client", () => ({ ...api, GrowthApiError: class extends Error {} }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/growth/useUrlParams", () => ({
  useUrlParams: () => ({ get: (k: string, d = "") => urlState.params[k] ?? d, set: urlState.set, query: "" }),
  listParam: (v: string) => (v ? v.split(",") : []),
}));

import { AdLibraryTab, CaptionCell, nextNameFor } from "@/components/growth/LibraryTabs";
import { CaptionEditDialog, CopyCaptionsButton, HashtagField, MenuButton, copyTextFor } from "@/components/growth/LibraryCaptions";
import { AssetCardPicker } from "@/components/growth/AssetCardPicker";
import { EntryPopover, ScheduleDialog } from "@/components/growth/LibraryCalendar";
import type { MarketingData } from "@/lib/growth/client";
import type { PremadeRow } from "@/lib/growth/libraryService";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG = "Word ".repeat(40).trim(); // 199 characters
const premade = (over: Partial<PremadeRow> = {}): PremadeRow =>
  ({
    id: "p1",
    title: null,
    category: "picture_post",
    picture_format: "single_image",
    business: "botaniqals",
    pillar_id: "pA",
    series_id: "sA",
    series_position: null,
    post_number: 1,
    name_history: [],
    status: "drafting",
    intent: "organic",
    is_recurring: false,
    platforms: [],
    products_mentioned: [],
    hook: null,
    caption: "Body one",
    hashtags: null,
    cta_text: null,
    style_tag: null,
    duration_text: null,
    duration_min_seconds: null,
    duration_max_seconds: null,
    script_beats: [],
    visual_direction: null,
    why_it_converts: null,
    visual_notes: null,
    best_window_text: null,
    best_window_why: null,
    asset_needs: [],
    needs_customer_permission: false,
    permission_confirmed_by_name: null,
    permission_confirmed_at: null,
    risky_ack_hash: null,
    risky_ack_by_name: null,
    risky_ack_at: null,
    notes: null,
    sort_order: 0,
    created_by_name: null,
    archived_at: null,
    created_at: "2026-11-01T12:00:00.000000+00:00",
    updated_at: "2026-11-02T12:00:00.123456+00:00",
    name: "AA-1",
    display_name: "AA-1",
    flags: [],
    claim_ids: [],
    asset_ids: [],
    product_ids: [],
    next_scheduled: null,
    last_posted: null,
    ...over,
  }) as PremadeRow;
const asset = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title: `Asset ${i}`,
  source: "link",
  url: "https://files.example.test/a",
  mime_type: null,
  preview_path: null,
  poster_path: null,
  file_path: null,
  category: "other",
  created_at: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  product_ids: [],
});
const md = (over: Partial<MarketingData> = {}): MarketingData =>
  ({
    products: [{ id: "prA", name: "Product A", in_development: false }],
    profiles: [{ formulation_product_id: "prA", hashtags: "#tagthree" }],
    claims: [],
    claimEvents: [],
    assets: [],
    posts: [],
    templates: [],
    riskyWords: [],
    employees: [],
    is_admin: true,
    me: null,
    pillars: [
      { id: "pA", code: "A", name: "Topic A", description: null, recurring: false, sort_order: 0, archived_at: null, last_unsorted_post_number: 3 },
      { id: "pB", code: "B", name: "Topic B", description: null, recurring: false, sort_order: 0, archived_at: null, last_unsorted_post_number: 0 },
    ],
    series: [
      { id: "sA", pillar_id: "pA", name: "Subtopic A", code: "A", last_post_number: 2, cover_text: null, default_hashtags: "#tagone #tagtwo", notes: null, sort_order: 0, archived_at: null },
      { id: "sB", pillar_id: "pB", name: "Subtopic B", code: "A", last_post_number: 0, cover_text: null, default_hashtags: null, notes: null, sort_order: 0, archived_at: null },
    ],
    premades: [],
    duplicateNames: [],
    closingLines: [],
    avoidPhrases: [],
    windows: [],
    dayNotes: [],
    rhythm: [],
    referenceNotes: {},
    ingredientTags: [],
    assetCategories: [{ key: "other", label: "Other", sort_order: 1000, is_builtin: true }],
    assetProductLinks: [],
    assetIngredientLinks: [],
    ...over,
  }) as unknown as MarketingData;

let host: HTMLDivElement;
let root: Root;
const clip = { writeText: vi.fn(async (t: string) => void t) };
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  api.updateCaptionApi.mockReset();
  urlState.params = {};
  Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
  window.localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = async (el: ReturnType<typeof createElement>) => {
  await act(async () => root.render(el));
};
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const byText = (re: RegExp, sel = "button") => [...document.querySelectorAll<HTMLElement>(sel)].find((b) => re.test(b.textContent ?? ""));
const click = async (el: Element | null | undefined) => {
  expect(el, "element").toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const select = async (el: HTMLSelectElement, value: string) => {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("caption column", () => {
  const cell = (post: Partial<PremadeRow>, tags: string[] = [], expanded = false, onToggle = vi.fn(), onEdit = vi.fn()) =>
    render(createElement(CaptionCell, { row: { post: premade(post), tags }, expanded, onToggle, onEdit }));
  it("100 characters plus ...more, never the hashtags, even a typed trailing block", async () => {
    const onToggle = vi.fn();
    await cell({ caption: `${LONG}\n\n#typedtag #other` }, ["#tagone"], false, onToggle);
    const text = host.textContent ?? "";
    expect(text).toContain(`${LONG.slice(0, 100)}...more`);
    expect(text).not.toContain("#");
    await click(byText(/\.\.\.more/));
    expect(onToggle).toHaveBeenCalled();
  });
  it("expanded: the whole body, the hashtag count note and Edit", async () => {
    const onEdit = vi.fn();
    await cell({ caption: `${LONG}\n\n#typedtag` }, ["#tagone", "#tagtwo"], true, vi.fn(), onEdit);
    expect(host.textContent).toContain(LONG);
    expect(host.textContent).toContain("Hashtags added when posted: 2");
    expect(host.textContent).not.toContain("#");
    await click(byText(/^Edit$/));
    expect(onEdit).toHaveBeenCalled();
  });
  it("hook fallback for reels, No caption yet, Hashtags only", async () => {
    await cell({ category: "reel", caption: null, hook: "A hook line" });
    expect(host.textContent).toContain("Hook: A hook line");
    await cell({ caption: null });
    expect(host.textContent).toContain("No caption yet");
    expect(byText(/Add caption/)).toBeTruthy();
    await cell({ caption: "#onlytags #more" });
    expect(host.textContent).toContain("Hashtags only");
  });
});

describe("Copy captions", () => {
  const rows = [
    { name: "AA-1", caption: "First body\r\nline two  \n\n#tag" },
    { name: "AA-2", caption: "" },
    { name: "AA-3", caption: "Third 🌿\n\nwith a gap" },
  ];
  it("the exact text: bodies only, one blank line between, empties skipped, no trailing newline", async () => {
    const toast = vi.fn();
    await render(createElement(CopyCaptionsButton, { rowsFor: () => rows, toast }));
    expect(byText(/^Copy captions \(2\)$/)).toBeTruthy();
    await click(byText(/^Copy captions/));
    await flush();
    expect(clip.writeText).toHaveBeenCalledWith("First body\nline two\n\nThird 🌿\n\nwith a gap");
    expect(toast).toHaveBeenCalledWith("Copied 2 captions, skipped 1 with no caption");
  });
  it("names option (remembered) and both tabs option", async () => {
    const rowsFor = vi.fn((both: boolean) => (both ? [...rows, { name: "B-1", caption: "Reel body" }] : rows));
    await render(createElement(CopyCaptionsButton, { rowsFor, toast: vi.fn() }));
    await click(document.querySelector('[aria-label="Copy captions options"]'));
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')];
    await click(boxes[0]);
    await click(boxes[1]);
    expect(window.localStorage.getItem("kcg.copyCaptions.names")).toBe("1");
    await click(byText(/^Copy captions \(3\)/));
    await flush();
    expect(clip.writeText).toHaveBeenLastCalledWith("AA-1\nFirst body\nline two\n\nAA-3\nThird 🌿\n\nwith a gap\n\nB-1\nReel body");
    expect(copyTextFor([{ name: "X", caption: "" }], false)).toEqual({ text: "", copied: 0, skipped: 1 });
  });
  it("Nothing to copy, and the fallback window when the clipboard is blocked", async () => {
    const toast = vi.fn();
    await render(createElement(CopyCaptionsButton, { rowsFor: () => [{ name: "X", caption: null }], toast }));
    await click(byText(/^Copy captions/));
    expect(toast).toHaveBeenCalledWith("Nothing to copy");
    clip.writeText.mockRejectedValueOnce(new Error("blocked"));
    await render(createElement(CopyCaptionsButton, { rowsFor: () => rows, toast }));
    await click(byText(/^Copy captions/));
    await flush();
    const fb = document.querySelector('[data-testid="copy-fallback"]');
    expect(fb?.textContent).toContain("Press Ctrl+C (or Cmd+C) to copy.");
    expect(fb?.querySelector("textarea")?.value).toBe("First body\nline two\n\nThird 🌿\n\nwith a gap");
  });
});

describe("Edit caption popup", () => {
  const open = async (data = md(), post = premade(), onSaved = vi.fn(), onClose = vi.fn()) => {
    await render(createElement(CaptionEditDialog, { key: Math.random(), data, post, onClose, onSaved }));
    await flush();
    return { onSaved, onClose, area: document.querySelector<HTMLTextAreaElement>("#f-caption-edit")! };
  };
  it("saves only the caption with the version that was opened; preview shows the hashtags", async () => {
    api.updateCaptionApi.mockResolvedValueOnce({ ok: true, updated_at: "x", notice: "Moved back to Drafting: Write the caption." });
    const { onSaved, area } = await open();
    await type(area, "Body two");
    expect(document.querySelector('[data-testid="final-caption-preview"]')?.textContent).toBe("Body two\n\n\n#tagone #tagtwo");
    await click(byText(/^Save$/));
    expect(api.updateCaptionApi).toHaveBeenCalledWith("p1", { caption: "Body two", expected_updated_at: "2026-11-02T12:00:00.123456+00:00", source: "table_edit" });
    expect(onSaved).toHaveBeenCalledWith("Saved AA-1. Moved back to Drafting: Write the caption.");
  });
  it("conflict: Use theirs, or Keep mine and save with the new version", async () => {
    api.updateCaptionApi.mockResolvedValueOnce({ conflict: true, current_caption: "Their body", current_updated_at: "2026-11-03T00:00:00.5+00:00" });
    const { area, onSaved } = await open();
    await type(area, "My body");
    await click(byText(/^Save$/));
    expect(document.querySelector('[data-testid="caption-conflict"]')?.textContent).toContain("This post was changed by someone else.");
    api.updateCaptionApi.mockResolvedValueOnce({ ok: true, updated_at: "y", notice: null });
    await click(byText(/Keep mine and save/));
    expect(api.updateCaptionApi).toHaveBeenLastCalledWith("p1", { caption: "My body", expected_updated_at: "2026-11-03T00:00:00.5+00:00", source: "table_edit" });
    expect(onSaved).toHaveBeenCalledWith("Saved AA-1");
    api.updateCaptionApi.mockResolvedValueOnce({ conflict: true, current_caption: "Their body", current_updated_at: "t2" });
    const second = await open();
    await type(second.area, "Mine again");
    await click(byText(/^Save$/));
    await click(byText(/Use theirs/));
    expect(second.area.value).toBe("Their body");
  });
  it("previous versions restore into the text area; Ctrl+Enter saves as a restore", async () => {
    api.captionHistoryApi.mockResolvedValueOnce({ versions: [{ id: "v1", caption: "Older body", changed_by_name: "Editor A", changed_at: "2026-11-01T15:00:00Z", source: "form" }] });
    api.updateCaptionApi.mockResolvedValueOnce({ ok: true, updated_at: "z", notice: null });
    const { area } = await open();
    expect(document.querySelector('[data-testid="caption-versions"]')?.textContent).toContain("Editor A");
    await click(byText(/^Restore$/));
    expect(area.value).toBe("Older body");
    await act(async () => area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(api.updateCaptionApi).toHaveBeenCalledWith("p1", expect.objectContaining({ caption: "Older body", source: "restore" }));
  });
  it("Escape with unsaved changes asks first; the scheduled notice names the date and platforms", async () => {
    const data = md({ posts: [{ id: "e1", premade_post_id: "p1", platform: "instagram", status: "scheduled", scheduled_date: "2099-01-05", archived_at: null }] as unknown as MarketingData["posts"] });
    const { area, onClose } = await open(data);
    expect(document.querySelector('[data-testid="scheduled-notice"]')?.textContent).toMatch(/AA-1 is scheduled on .* for IG\. The scheduled post will use the new caption\./);
    await type(area, "Changed");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).not.toHaveBeenCalled();
    await click(byText(/^Discard$/));
    expect(onClose).toHaveBeenCalled();
  });
  it("a failed save keeps the popup open with the text", async () => {
    api.updateCaptionApi.mockRejectedValueOnce(new Error("Network down"));
    const { area, onSaved } = await open();
    await type(area, "Keep me");
    await click(byText(/^Save$/));
    expect(host.ownerDocument.body.textContent).toContain("Network down");
    expect(area.value).toBe("Keep me");
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("Ad Library table and filters", () => {
  const data = () =>
    md({
      premades: [
        premade({ id: "p1", name: "AA-1", caption: "First" }),
        premade({ id: "p2", name: "AA-2", post_number: 2, caption: "Second" }),
        premade({ id: "p3", name: "A-1", series_id: null, caption: "Third" }),
        premade({ id: "p4", name: "BA-1", pillar_id: "pB", series_id: "sB", caption: "Fourth" }),
        premade({ id: "p5", name: "AA-3", post_number: null, category: "reel", caption: "Reel" }),
      ],
      duplicateNames: [{ name: "AA-2", post_ids: ["p2"] }],
    });
  const names = () => [...document.querySelectorAll('[data-testid="library-row"] td:nth-child(2) button')].map((b) => b.textContent);
  it("filters come from the page address: topic, subtopic, No subtopic yet", async () => {
    urlState.params = { lib_cat: "picture_post" };
    await render(createElement(AdLibraryTab, { data: data(), reload: vi.fn() }));
    expect(names()).toEqual(["A-1", "AA-1", "AA-2", "BA-1"]);
    expect(document.querySelector('[data-testid="duplicate-banner"]')?.textContent).toContain("1 duplicate name found");
    urlState.params = { lib_cat: "picture_post", lib_topic: "pA", lib_sub: "sA" };
    await render(createElement(AdLibraryTab, { data: data(), reload: vi.fn() }));
    expect(names()).toEqual(["AA-1", "AA-2"]);
    const sub = document.querySelector<HTMLSelectElement>('select[aria-label="Subtopic"]')!;
    expect([...sub.options].map((o) => o.textContent)).toEqual(["All subtopics", "No subtopic yet", "AA · Subtopic A"]);
    urlState.params = { lib_cat: "picture_post", lib_sub: "none" };
    await render(createElement(AdLibraryTab, { data: data(), reload: vi.fn() }));
    expect(names()).toEqual(["A-1"]);
    expect(byText(/^Copy captions \(1\)/)).toBeTruthy();
  });
  it("changing the topic resets a subtopic from another topic; chips for duplicates and numbering", async () => {
    urlState.params = { lib_cat: "picture_post", lib_sub: "sA" };
    await render(createElement(AdLibraryTab, { data: data(), reload: vi.fn() }));
    await select(document.querySelector<HTMLSelectElement>('select[aria-label="Topic"]')!, "pB");
    expect(urlState.set).toHaveBeenCalledWith({ lib_topic: "pB", lib_sub: null });
    expect(host.textContent).toContain("Duplicate name");
    urlState.params = {};
    await render(createElement(AdLibraryTab, { data: data(), reload: vi.fn() }));
    expect(host.textContent).toContain("Needs numbering");
  });
  it("the Actions menu opens, Escape closes it and focus returns to the button", async () => {
    const onSelect = vi.fn();
    await render(createElement(MenuButton, { label: "Actions", items: [{ label: "Open", onSelect }, { label: "Archive", onSelect: vi.fn() }] }));
    const button = byText(/^Actions$/)!;
    await click(button);
    const menu = document.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["Open", "Archive"]);
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe("hashtags and the form's next name", () => {
  it("the hashtag field counts tags and lists what isn't a hashtag", async () => {
    await render(createElement(HashtagField, { name: "t", value: "#tagone, tagtwo. 1. #bad-tag", onChange: vi.fn() }));
    expect(host.textContent).toContain("2 hashtags");
    expect(host.textContent).toContain("will be left out");
  });
  it("next name for a new post, a new subtopic, and a move", () => {
    const data = md();
    expect(nextNameFor(data, null, { pillar_id: "pA", series_id: "sA", new_subtopic_name: "" }).name).toBe("AA-3");
    expect(nextNameFor(data, null, { pillar_id: "pA", series_id: "", new_subtopic_name: "" }).name).toBe("A-4");
    expect(nextNameFor(data, null, { pillar_id: "pA", series_id: "__new", new_subtopic_name: "X" })).toMatchObject({ name: "AB-1", newLetter: "B" });
    expect(nextNameFor(data, premade(), { pillar_id: "pA", series_id: "sA", new_subtopic_name: "" })).toMatchObject({ name: "AA-1", moves: false });
    expect(nextNameFor(data, premade(), { pillar_id: "pB", series_id: "sB", new_subtopic_name: "" })).toMatchObject({ name: "BA-1", moves: true });
  });
});

describe("asset card picker", () => {
  const page = (n: number) => ({ rows: Array.from({ length: n === 1 ? 20 : 3 }, (_, i) => asset((n - 1) * 20 + i + 1)), total: 23, page: n, pages: 2 });
  it("20 per page, selection survives paging, Save only with a selection", async () => {
    api.assetPickerApi.mockImplementation(async (b: { page: number }) => page(b.page));
    const onSave = vi.fn();
    await render(createElement(AssetCardPicker, { data: md(), mode: "multi", title: "Add assets", onClose: vi.fn(), onSave, reload: vi.fn() }));
    await flush();
    expect(document.querySelectorAll('[data-testid="picker-card"]')).toHaveLength(20);
    const save = byText(/^Save$/) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await click(document.querySelectorAll('[data-testid="picker-card"] button[aria-pressed]')[0]);
    await click(byText(/^Next$/));
    await flush();
    await click(document.querySelectorAll('[data-testid="picker-card"] button[aria-pressed]')[0]);
    expect(host.ownerDocument.body.textContent).toContain("2 selected");
    expect(save.disabled).toBe(false);
    await click(save);
    expect(onSave).toHaveBeenCalledWith([asset(1).id, asset(21).id]);
  });
  it("single mode: choosing a card replaces the previous choice; filters return to page 1", async () => {
    api.assetPickerApi.mockImplementation(async (b: { page: number }) => page(b.page));
    const onSave = vi.fn();
    await render(createElement(AssetCardPicker, { data: md(), mode: "single", title: "Attach", onClose: vi.fn(), onSave, reload: vi.fn() }));
    await flush();
    const buttons = () => document.querySelectorAll('[data-testid="picker-card"] button[aria-pressed]');
    await click(buttons()[0]);
    await click(buttons()[1]);
    await click(byText(/^Save$/));
    expect(onSave).toHaveBeenCalledWith([asset(2).id]);
    await click(byText(/^Next$/));
    await flush();
    await select(document.querySelector<HTMLSelectElement>('select[aria-label="File type"]')!, "link");
    await flush();
    expect(api.assetPickerApi).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, kind: "link" }));
  });
});

describe("calendar scheduling", () => {
  it("New post: search, add and remove platforms, Schedule anyway for a post that isn't Ready", async () => {
    const data = md({ premades: [premade({ id: "p1", name: "AA-1", caption: "Searchable body" }), premade({ id: "p2", name: "AA-2", status: "paused" })] });
    const onDone = vi.fn();
    await render(createElement(ScheduleDialog, { data, onClose: vi.fn(), onDone }));
    await type(document.querySelector<HTMLInputElement>("#f-sch-search")!, "searchable");
    const list = document.querySelector('[data-testid="schedule-post-list"]')!;
    expect(list.querySelectorAll("button")).toHaveLength(1);
    await click(list.querySelector("button"));
    await select(document.querySelector<HTMLSelectElement>('select[aria-label="Add platform"]')!, "facebook");
    await select(document.querySelector<HTMLSelectElement>('select[aria-label="Add platform"]')!, "tiktok");
    await click(document.querySelector('[aria-label="Remove TikTok"]'));
    await type(document.querySelector<HTMLInputElement>("#f-sch-date")!, "2027-01-05");
    const go = byText(/^Schedule 2 entries$/) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await click(document.querySelector('[data-testid="schedule-blockers"] input[type="checkbox"]'));
    expect(go.disabled).toBe(false);
    await click(go);
    expect(api.scheduleFromLibraryApi).toHaveBeenCalledWith("p1", { date: "2027-01-05", time: null, platforms: ["instagram", "facebook"], schedule_anyway: true });
    expect(onDone).toHaveBeenCalled();
  });
  it("Edit schedule keeps Posted platforms locked; Mark posted sends the link", async () => {
    const posts = [
      { id: "e1", premade_post_id: "p1", schedule_group_id: "g1", platform: "instagram", status: "scheduled", scheduled_date: "2027-01-05", scheduled_time: null, title: "AA-1", caption: null, hashtags: null, archived_at: null, asset_ids: [], posted_url: null },
      { id: "e2", premade_post_id: "p1", schedule_group_id: "g1", platform: "facebook", status: "posted", scheduled_date: "2027-01-05", scheduled_time: null, title: "AA-1", caption: "Frozen", hashtags: null, archived_at: null, asset_ids: [], posted_url: null },
    ] as unknown as MarketingData["posts"];
    const data = md({ premades: [premade({ id: "p1", name: "AA-2", caption: "Live body" })], posts });
    await render(createElement(ScheduleDialog, { data, entry: posts[0], onClose: vi.fn(), onDone: vi.fn() }));
    expect(document.querySelector('[aria-label="Remove Facebook"]')).toBeNull();
    expect(document.querySelector('[aria-label="Remove Instagram"]')).toBeTruthy();
    await click(byText(/^Save schedule$/));
    expect(api.editScheduleApi).toHaveBeenCalledWith("e1", { date: "2027-01-05", time: null, platforms: ["instagram", "facebook"] });

    const onChanged = vi.fn();
    await render(createElement(EntryPopover, { data, post: posts[0], onClose: vi.fn(), onEdit: vi.fn(), onChanged }));
    expect(document.querySelector('[data-testid="entry-caption"]')?.textContent).toBe("Live body\n\n\n#tagone #tagtwo");
    await click(byText(/^Mark posted$/));
    await type(document.querySelector<HTMLInputElement>("#f-posted-url")!, "https://social.example.test/p/1");
    await click([...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "Mark posted").pop());
    expect(api.markPostedApi).toHaveBeenCalledWith("e1", { posted_url: "https://social.example.test/p/1" });
    expect(onChanged).toHaveBeenCalledWith("Marked AA-2 posted");

    await render(createElement(EntryPopover, { data, post: posts[1], onClose: vi.fn(), onEdit: vi.fn(), onChanged }));
    expect(document.querySelector('[data-testid="entry-caption"]')?.textContent).toBe("Frozen");
  });
});
