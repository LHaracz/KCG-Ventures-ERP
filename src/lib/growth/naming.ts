/**
 * Marketing Hub post names, hashtag lists and caption helpers (pure, tested).
 *
 * Names: topic (pillar) letter + subtopic letter + "-" + number ("AA-1"), or
 * topic letter + "-" + number with no subtopic ("B-1"). Numbers count up per
 * topic-and-subtopic group and are never reused.
 *
 * Captions: the stored caption is the body the creator writes. The posted
 * ("final") caption adds the subtopic's and products' hashtags after two
 * blank lines. The Ad Library table and Copy captions only ever use the body.
 */

// --- Names ----------------------------------------------------------------------------------------
export const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

/** The next unused subtopic letter in a topic (archived subtopics keep theirs). Throws when A to Z are used. */
export function nextSubtopicLetter(existingCodes: ReadonlyArray<string | null | undefined>): string {
  const used = new Set(existingCodes.filter(Boolean));
  const free = LETTERS.find((l) => !used.has(l));
  if (!free) throw new Error("This topic already has 26 subtopics (A to Z). Letters are never reused, so use another topic.");
  return free;
}

/** "AA-1", or "B-1" with no subtopic. */
export const postName = (pillarCode: string, subtopicCode: string | null | undefined, n: number) => `${pillarCode}${subtopicCode ?? ""}-${n}`;

/** The name a post shows: its short name once numbered, otherwise the old "{letter} - {title}". */
export function currentPostName(p: { post_number: number | null; title?: string | null }, pillarCode: string, subtopicCode: string | null | undefined): string {
  return p.post_number !== null && p.post_number !== undefined ? postName(pillarCode, subtopicCode, p.post_number) : `${pillarCode} - ${p.title ?? ""}`;
}

export type NameKey = { pillarCode: string; subtopicCode: string | null; number: number | null; fallback?: string };

/** Sort by name: topic letter, then subtopic letter (no subtopic first), then the number as a number. Unnumbered posts last in their group. */
export function compareNames(a: NameKey, b: NameKey): number {
  if (a.pillarCode !== b.pillarCode) return a.pillarCode.localeCompare(b.pillarCode);
  const sa = a.subtopicCode ?? "";
  const sb = b.subtopicCode ?? "";
  if (sa !== sb) return sa.localeCompare(sb);
  if (a.number === null && b.number === null) return (a.fallback ?? "").localeCompare(b.fallback ?? "");
  if (a.number === null) return 1;
  if (b.number === null) return -1;
  return a.number - b.number;
}

// --- Hashtags --------------------------------------------------------------------------------------
const TAG_RE = /^#[\p{L}\p{N}_]+$/u;
const EDGE_PUNCT = /^[.,;:!?()[\]{}"'“”‘’]+|[.,;:!?()[\]{}"'“”‘’]+$/gu;

/**
 * Hashtags from pasted or typed text: split on spaces, commas and line
 * breaks; surrounding punctuation (such as a trailing period) is dropped; a
 * missing "#" is added. Tokens that still aren't "#" + letters, numbers or
 * underscores are returned in `invalid`. Bare numbers ("1.") are numbering,
 * not tags, and are reported as invalid. Duplicates (ignoring case) keep the
 * first spelling.
 */
export function parseHashtags(text: string | null | undefined): { tags: string[]; invalid: string[] } {
  const tags: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of (text ?? "").split(/[\s,]+/u)) {
    if (!raw) continue;
    let t = raw.replace(EDGE_PUNCT, "");
    if (!t) continue;
    if (!t.startsWith("#")) {
      if (/^\d+$/.test(t)) {
        invalid.push(raw);
        continue;
      }
      t = `#${t}`;
    }
    if (!TAG_RE.test(t)) {
      invalid.push(raw);
      continue;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tags.push(t);
  }
  return { tags, invalid };
}

/** The stored form of a hashtag list: the valid tags separated by single spaces (or null when there are none). */
export const normalizeHashtagList = (text: string | null | undefined) => {
  const { tags } = parseHashtags(text);
  return tags.length ? tags.join(" ") : null;
};

/** Union in order (subtopic first, then products, then legacy extras); duplicates ignoring case keep the first spelling. */
export function mergeHashtags(lists: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const t of list) {
      const k = t.toLowerCase();
      if (!t || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/**
 * The hashtags posting adds for a post: the subtopic's list, then each
 * checked product's list (in the order of the product checkboxes), then any
 * legacy extra hashtags typed on the post, without duplicates.
 */
export const postHashtags = (subtopicHashtags: string | null | undefined, productHashtags: ReadonlyArray<string | null | undefined>, legacyHashtags: string | null | undefined) =>
  mergeHashtags([parseHashtags(subtopicHashtags).tags, ...productHashtags.map((h) => parseHashtags(h).tags), parseHashtags(legacyHashtags).tags]);

const tagInText = (text: string, tag: string) => {
  const body = tag.replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])#${body}(?![\\p{L}\\p{N}_])`, "iu").test(text);
};

/** Tags not already written in the text (case-insensitive, whole tag). */
export const tagsNotIn = (text: string, tags: readonly string[]) => tags.filter((t) => !tagInText(text, t));

/**
 * The posted caption: the body (end trimmed), then two blank lines, then the
 * hashtags not already in the body, separated by single spaces. An empty body
 * gives "" (no caption is posted with only hashtags).
 */
export function composeFinalCaption(body: string | null | undefined, tags: readonly string[]): string {
  const b = (body ?? "").replace(/\s+$/u, "");
  if (!b) return "";
  const rest = tagsNotIn(b, tags);
  if (!rest.length) return b;
  return `${b}\n\n\n${rest.join(" ")}`;
}

const TOKEN_RE = /^#[\p{L}\p{N}_]+[.,]?$/u;

/**
 * Splits a trailing block of hashtag-only lines off a caption. Works on
 * lines: trailing blank lines are ignored; while the last non-blank line is
 * made only of hashtags (each "#" + letters, numbers or underscores, with an
 * optional period or comma), it is removed and its tags collected. The first
 * line with anything else stops it, so hashtags inside sentences stay. The
 * stored text is never changed; this is for display and copying.
 */
export function stripTrailingHashtagBlock(text: string | null | undefined): { body: string; hashtags: string[]; hashtagsOnly: boolean } {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[][] = [];
  const isBlank = (l: string) => !l.trim();
  while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    const tokens = last.split(/\s+/u);
    if (!tokens.length || !tokens.every((t) => TOKEN_RE.test(t))) break;
    blocks.unshift(tokens.map((t) => t.replace(/[.,]$/, "")));
    lines.pop();
    while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  }
  const hashtags = blocks.flat();
  const body = lines.join("\n");
  return { body, hashtags, hashtagsOnly: !body.trim() && hashtags.length > 0 };
}

/** What the Ad Library table shows for a caption: the body (no hashtags) and how many hashtags posting would add. */
export function captionView(post: { caption: string | null | undefined }, tags: readonly string[]): { body: string; extraTagCount: number; hashtagsOnly: boolean } {
  const s = stripTrailingHashtagBlock(post.caption);
  const stored = (post.caption ?? "").replace(/\s+$/u, "");
  return { body: s.body, extraTagCount: stored ? tagsNotIn(stored, tags).length : 0, hashtagsOnly: s.hashtagsOnly };
}

type Seg = { segment: string };
const graphemes = (s: string): string[] => {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (t: string) => Iterable<Seg> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
  return Array.from(s);
};

/** The first `max` user-perceived characters (emoji are never cut), with line breaks shown as spaces. */
export function captionSnippet(text: string | null | undefined, max = 100): { snippet: string; truncated: boolean } {
  const flat = (text ?? "").replace(/\r\n?|\n/g, " ");
  const g = graphemes(flat);
  if (g.length <= max) return { snippet: flat, truncated: false };
  return { snippet: g.slice(0, max).join(""), truncated: true };
}

/**
 * The text for Copy captions: each caption (line endings as "\n", leading and
 * trailing blank lines and line-end spaces removed), optionally with its name
 * on the line above, separated by exactly one blank line. Empty captions are
 * skipped and counted. No trailing newline.
 */
export function buildCopyText(items: ReadonlyArray<{ name: string; body: string | null | undefined }>, opts: { includeNames: boolean }): { text: string; copied: number; skipped: number } {
  const kept: string[] = [];
  let skipped = 0;
  for (const it of items) {
    const lines = (it.body ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/u, ""));
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const body = lines.join("\n");
    if (!body) {
      skipped += 1;
      continue;
    }
    kept.push(opts.includeNames ? `${it.name}\n${body}` : body);
  }
  return { text: kept.join("\n\n"), copied: kept.length, skipped };
}

// --- Search and duplicates ----------------------------------------------------------------------------
export type SearchablePost = {
  name: string;
  name_history?: ReadonlyArray<{ name: string }> | null;
  title?: string | null;
  subtopicName?: string | null;
  caption?: string | null;
};
const noDash = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");
const NAME_LIKE = /^[a-z]{1,2}\s*-?\s*\d+$/i;

/**
 * Case-insensitive search over the name (with or without the dash, so "aa1"
 * finds "AA-1"), previous names, the imported title, the subtopic name and
 * the caption body. A query shaped like a name matches names exactly.
 */
export function matchesPostSearch(post: SearchablePost, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const names = [post.name, ...(post.name_history ?? []).map((h) => h.name)].filter(Boolean);
  if (NAME_LIKE.test(q)) {
    const want = noDash(q);
    if (names.some((n) => noDash(n) === want)) return true;
  }
  // A name-shaped query ("AA-1") matches names exactly, so it doesn't also find AA-10.
  const fields = [...(NAME_LIKE.test(q) ? [] : names), post.title ?? "", post.subtopicName ?? "", stripTrailingHashtagBlock(post.caption).body];
  return fields.some((f) => f.toLowerCase().includes(q));
}

/** Groups of non-archived posts that share a name. */
export function findDuplicateNames<T extends { id: string; name: string; archived_at?: string | null }>(posts: readonly T[]): Array<{ name: string; ids: string[] }> {
  const by = new Map<string, string[]>();
  for (const p of posts) {
    if (p.archived_at) continue;
    const k = p.name.toUpperCase();
    by.set(k, [...(by.get(k) ?? []), p.id]);
  }
  return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids })).sort((a, b) => a.name.localeCompare(b.name));
}

// --- Assets ------------------------------------------------------------------------------------------
export type FileKindLabel = "image" | "gif" | "video" | "pdf" | "link" | "other";
export function fileKindOf(asset: { source: string; mime_type: string | null }): FileKindLabel {
  if (asset.source === "link") return "link";
  const m = (asset.mime_type ?? "").toLowerCase();
  if (m === "image/gif") return "gif";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  return "other";
}

/** Page bounds (1-based page, clamped); `from` and `to` are indexes for slice. */
export function paginate(total: number, page: number, size = 20): { page: number; pages: number; from: number; to: number; size: number } {
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const from = (p - 1) * size;
  return { page: p, pages, from, to: Math.min(total, from + size), size };
}

// --- Calendar groups ------------------------------------------------------------------------------------
export type GroupRow = { id: string; platform: string; status: string; archived_at?: string | null };

/**
 * When a schedule group's platforms change: which platforms get a new row,
 * which rows stay, and which are archived. Posted rows are locked: never
 * archived or changed, whatever the new list says.
 */
export function scheduleGroupDiff<T extends GroupRow>(existingRows: readonly T[], platforms: readonly string[]): { add: string[]; keep: T[]; archive: T[]; locked: T[] } {
  const live = existingRows.filter((r) => !r.archived_at);
  const want = [...new Set(platforms)];
  const locked = live.filter((r) => r.status === "posted");
  const open = live.filter((r) => r.status !== "posted");
  const keep = open.filter((r) => want.includes(r.platform));
  const archive = open.filter((r) => !want.includes(r.platform));
  const have = new Set([...keep, ...locked].map((r) => r.platform));
  return { add: want.filter((p) => !have.has(p)), keep, archive, locked };
}

// --- Moving posts (preview of move_premade_posts) ----------------------------------------------------------------
export type MovePost = { id: string; pillar_id: string; series_id: string | null; post_number: number | null; title?: string | null; created_at: string };
export type MoveTopic = { id: string; code: string; last_unsorted_post_number: number };
export type MoveSubtopic = { id: string; pillar_id: string; code: string | null; last_post_number: number; archived_at?: string | null };

/** The old and new names move_premade_posts would give, in the same order (current names), skipping posts already in the group. */
export function previewMove(args: {
  posts: readonly MovePost[];
  pillars: readonly MoveTopic[];
  subtopics: readonly MoveSubtopic[];
  target: { pillarId: string; subtopicId: string | null; newSubtopicName?: string | null };
}): { subtopicCode: string | null; moves: Array<{ id: string; oldName: string; newName: string }> } {
  const pillar = args.pillars.find((p) => p.id === args.target.pillarId);
  if (!pillar) throw new Error("Choose a topic.");
  const subCode = (id: string | null) => (id ? args.subtopics.find((s) => s.id === id)?.code ?? null : null);
  const pillarCode = (id: string) => args.pillars.find((p) => p.id === id)?.code ?? "?";
  let code: string | null = null;
  let counter: number;
  const sid = args.target.subtopicId;
  const isNew = !!args.target.newSubtopicName?.trim();
  if (isNew) {
    code = nextSubtopicLetter(args.subtopics.filter((s) => s.pillar_id === pillar.id).map((s) => s.code));
    counter = 0;
  } else if (sid) {
    const s = args.subtopics.find((x) => x.id === sid && x.pillar_id === pillar.id);
    if (!s) throw new Error("Choose a subtopic of this topic.");
    code = s.code;
    counter = s.last_post_number;
  } else counter = pillar.last_unsorted_post_number;
  const ordered = [...args.posts].sort(
    (a, b) =>
      compareNames(
        { pillarCode: pillarCode(a.pillar_id), subtopicCode: subCode(a.series_id), number: a.post_number },
        { pillarCode: pillarCode(b.pillar_id), subtopicCode: subCode(b.series_id), number: b.post_number },
      ) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const moves: Array<{ id: string; oldName: string; newName: string }> = [];
  for (const p of ordered) {
    if (!isNew && p.pillar_id === pillar.id && (p.series_id ?? null) === (sid ?? null)) continue;
    counter += 1;
    moves.push({ id: p.id, oldName: currentPostName(p, pillarCode(p.pillar_id), subCode(p.series_id)), newName: postName(pillar.code, code, counter) });
  }
  return { subtopicCode: code, moves };
}

// --- Conversion (the logic of supabase/conversions/2026-11-naming/02-apply.sql) -----------------------------------
export type ConvPillar = { id: string; code: string; last_unsorted_post_number?: number };
export type ConvSubtopic = { id: string; pillar_id: string; code: string | null; sort_order: number; created_at: string };
export type ConvPost = {
  id: string;
  pillar_id: string;
  series_id: string | null;
  series_position: number | null;
  sort_order: number;
  created_at: string;
  post_number: number | null;
  title: string | null;
  archived_at?: string | null;
};
export type ConversionPlan = {
  subtopicCodes: Record<string, string>;
  posts: Array<{ id: string; number: number; oldName: string; newName: string; group: string }>;
  subtopicCounters: Record<string, number>;
  pillarCounters: Record<string, number>;
  mismatched: string[];
  tooManySubtopics: string[];
};

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The same plan the SQL applies: letters per topic, then numbers per group (archived posts too), then counters. */
export function planConversion(pillars: readonly ConvPillar[], subtopics: readonly ConvSubtopic[], posts: readonly ConvPost[]): ConversionPlan {
  const subtopicCodes: Record<string, string> = {};
  const tooManySubtopics: string[] = [];
  for (const pl of pillars) {
    const mine = subtopics.filter((s) => s.pillar_id === pl.id);
    if (mine.length > 26) tooManySubtopics.push(pl.id);
    const used = new Set(mine.map((s) => s.code).filter((c): c is string => !!c));
    for (const s of mine.filter((x) => x.code)) subtopicCodes[s.id] = s.code!;
    const todo = mine.filter((s) => !s.code).sort((a, b) => cmp(a.sort_order, b.sort_order) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
    for (const s of todo) {
      const free = LETTERS.find((l) => !used.has(l));
      if (!free) break;
      used.add(free);
      subtopicCodes[s.id] = free;
    }
  }
  const subById = new Map(subtopics.map((s) => [s.id, s]));
  const mismatched = posts.filter((p) => p.series_id && subById.get(p.series_id)?.pillar_id !== p.pillar_id).map((p) => p.id);
  const pillarCode = new Map(pillars.map((p) => [p.id, p.code]));
  const groups = new Map<string, ConvPost[]>();
  for (const p of posts) {
    if (mismatched.includes(p.id)) continue;
    const key = `${p.pillar_id}|${p.series_id ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const out: ConversionPlan["posts"] = [];
  const subtopicCounters: Record<string, number> = {};
  const pillarCounters: Record<string, number> = {};
  for (const [key, list] of groups) {
    const withSeries = !!list[0].series_id;
    const max = Math.max(0, ...list.map((p) => p.post_number ?? 0));
    const todo = list
      .filter((p) => p.post_number === null)
      .sort((a, b) =>
        withSeries
          ? (a.series_position === null ? 1 : 0) - (b.series_position === null ? 1 : 0) || cmp(a.series_position ?? 0, b.series_position ?? 0) || cmp(a.sort_order, b.sort_order) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id)
          : cmp(a.sort_order, b.sort_order) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id),
      );
    let n = max;
    const pc = pillarCode.get(list[0].pillar_id) ?? "?";
    const sc = list[0].series_id ? subtopicCodes[list[0].series_id] ?? null : null;
    for (const p of todo) {
      n += 1;
      out.push({ id: p.id, number: n, oldName: `${pc} - ${p.title ?? ""}`, newName: postName(pc, sc, n), group: key });
    }
    if (withSeries) subtopicCounters[list[0].series_id!] = n;
    else pillarCounters[list[0].pillar_id] = n;
  }
  return { subtopicCodes, posts: out, subtopicCounters, pillarCounters, mismatched, tooManySubtopics };
}
