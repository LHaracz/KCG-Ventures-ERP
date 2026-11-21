/**
 * The Ad Library's filters and sort, in ONE place (pure, tested). The table,
 * the tab and "Needs attention" counts, and Copy captions all use this, so
 * what is copied is exactly what the table lists.
 */
import { compareNames, matchesPostSearch } from "./naming";

/** One library post, prepared for filtering (see libraryView.ts). */
export type LibPost = {
  id: string;
  category: "reel" | "picture_post";
  status: string;
  intent: string;
  pillar_id: string;
  series_id: string | null;
  archived_at: string | null;
  created_at: string;
  name: string;
  pillarCode: string;
  subtopicCode: string | null;
  subtopicName: string | null;
  post_number: number | null;
  title: string | null;
  name_history: ReadonlyArray<{ name: string }>;
  caption: string | null;
  product_ids: readonly string[];
  openNeeds: number;
  needsPermission: boolean;
  avoidHits: number;
  watchHits: number;
  openFlagKeys: readonly string[];
  duplicate: boolean;
  scheduled: boolean;
};

export const ATTENTION_KEYS = ["needs", "permission", "avoid", "watch", "flag", "nosub", "dupe", "unscheduled"] as const;
export type AttentionKey = (typeof ATTENTION_KEYS)[number];

export type LibraryFilters = {
  /** Sub-tab: Reels or Picture posts. */
  cat: "reel" | "picture_post";
  /** "" = All topics, else a pillar id. */
  topic: string;
  /** "" = All subtopics, "none" = No subtopic yet, else a subtopic id. */
  subtopic: string;
  status: string;
  intent: string;
  /** A product id ("" = any). */
  product: string;
  att: readonly string[];
  /** With the "flag" toggle: one flag type ("" = any open flag). */
  flag: string;
  q: string;
  paused: boolean;
  sort: "name" | "newest";
};

export const DEFAULT_FILTERS: LibraryFilters = { cat: "reel", topic: "", subtopic: "", status: "", intent: "", product: "", att: [], flag: "", q: "", paused: false, sort: "name" };

export function attentionMatch(p: LibPost, key: string, flag = ""): boolean {
  switch (key) {
    case "needs":
      return p.openNeeds > 0;
    case "permission":
      return p.needsPermission;
    case "avoid":
      return p.avoidHits > 0;
    case "watch":
      return p.watchHits > 0;
    case "flag":
      return flag ? p.openFlagKeys.includes(flag) : p.openFlagKeys.length > 0;
    case "nosub":
      return !p.series_id;
    case "dupe":
      return p.duplicate;
    case "unscheduled":
      return !p.scheduled;
    default:
      return true;
  }
}

/** True when the post passes every filter (the sub-tab included). `skipAtt` leaves out one toggle, for its count. */
export function libraryMatches(p: LibPost, f: LibraryFilters, skipAtt?: string): boolean {
  if (p.archived_at) return false;
  if (p.category !== f.cat) return false;
  if (!f.paused && p.status === "paused") return false;
  if (f.topic && p.pillar_id !== f.topic) return false;
  if (f.subtopic === "none" ? !!p.series_id : f.subtopic && p.series_id !== f.subtopic) return false;
  if (f.status && p.status !== f.status) return false;
  if (f.intent && p.intent !== f.intent) return false;
  if (f.product && !p.product_ids.includes(f.product)) return false;
  for (const a of f.att) if (a !== skipAtt && !attentionMatch(p, a, f.flag)) return false;
  if (f.q && !matchesPostSearch({ name: p.name, name_history: p.name_history, title: p.title, subtopicName: p.subtopicName, caption: p.caption }, f.q)) return false;
  return true;
}

export const libraryFilter = <T extends LibPost>(posts: readonly T[], f: LibraryFilters): T[] => posts.filter((p) => libraryMatches(p, f));

/** Name order (topic letter, subtopic letter with no subtopic first, number as a number), or newest first. */
export function librarySort<T extends LibPost>(posts: readonly T[], sort: LibraryFilters["sort"]): T[] {
  const out = [...posts];
  if (sort === "newest") return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  return out.sort(
    (a, b) =>
      compareNames(
        { pillarCode: a.pillarCode, subtopicCode: a.subtopicCode, number: a.post_number, fallback: a.name },
        { pillarCode: b.pillarCode, subtopicCode: b.subtopicCode, number: b.post_number, fallback: b.name },
      ) || a.id.localeCompare(b.id),
  );
}

/** The table's rows: filter, then sort. */
export const libraryList = <T extends LibPost>(posts: readonly T[], f: LibraryFilters): T[] => librarySort(libraryFilter(posts, f), f.sort);

/**
 * The posts Copy captions copies, in table order. With `bothTabs`, the same
 * filters applied to Picture posts first, then Reels, each in name order.
 */
export function copyList<T extends LibPost>(posts: readonly T[], f: LibraryFilters, bothTabs: boolean): T[] {
  if (!bothTabs) return libraryList(posts, f);
  return [...libraryList(posts, { ...f, cat: "picture_post", sort: "name" }), ...libraryList(posts, { ...f, cat: "reel", sort: "name" })];
}

/** Reads the filters from the page address (lib_* keys). */
export function filtersFromParams(get: (k: string) => string): LibraryFilters {
  return {
    cat: get("lib_cat") === "picture_post" ? "picture_post" : "reel",
    topic: get("lib_topic"),
    subtopic: get("lib_sub"),
    status: get("lib_status"),
    intent: get("lib_intent"),
    product: get("lib_product"),
    att: get("lib_att") ? get("lib_att").split(",").filter(Boolean) : [],
    flag: get("lib_flag"),
    q: get("lib_q"),
    paused: get("lib_paused") === "1",
    sort: get("lib_sort") === "newest" ? "newest" : "name",
  };
}
