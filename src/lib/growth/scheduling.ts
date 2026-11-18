/**
 * Calendar helpers for the Ad Library (pure, tested): turning a library item
 * into calendar entries, best-time hints, the weekly rhythm and the pillar
 * mix. Dates are date-only strings (YYYY-MM-DD); times are Eastern Time
 * "HH:MM" as entered.
 */
import { displayName, type PictureFormat, type PremadeCategory, type PremadeIntent, type PremadeStatus, type ReadyBlocker } from "./adLibrary";

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook", youtube: "YouTube Shorts", other: "Other" };
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const dayName = (d: number) => DAY[d];

// --- Calendar entries from a library item ---------------------------------------------------------------
export type PremadeForCalendar = {
  id: string;
  title: string;
  pillar_code: string;
  category: PremadeCategory;
  picture_format: PictureFormat | null;
  intent: PremadeIntent;
  status: PremadeStatus;
  business: string;
  caption: string | null;
  hashtags: string | null;
  products_mentioned?: readonly string[] | null;
};
export type CalendarRow = {
  title: string;
  business: string;
  platform: string;
  post_type: "reel" | "story" | "post" | "ad";
  status: "idea" | "scripting" | "editing" | "ready";
  scheduled_date: string;
  scheduled_time: string | null;
  owner_account_id: string | null;
  caption: string | null;
  hashtags: string | null;
  notes: string | null;
  risky_words_checked: boolean;
  premade_post_id: string;
  premade_synced_at: string;
};

export function postTypeFor(p: Pick<PremadeForCalendar, "category" | "intent" | "picture_format">): CalendarRow["post_type"] {
  if (p.intent === "paid") return "ad";
  if (p.category === "reel") return "reel";
  return p.picture_format === "story" ? "story" : "post";
}

/**
 * One content_posts row per platform. Paused items are refused. A Ready item
 * whose gates no longer pass goes in as Editing, with the blockers returned
 * as warnings.
 */
export function calendarEntriesFromPremade(args: {
  premade: PremadeForCalendar;
  series?: { default_hashtags: string | null } | null;
  date: string;
  time?: string | null;
  platforms: readonly string[];
  owner?: string | null;
  gateResult: { blockers: readonly ReadyBlocker[] };
  now?: string;
}): { ok: true; rows: CalendarRow[]; warnings: string[] } | { ok: false; error: string } {
  const { premade: p, date, platforms } = args;
  if (p.status === "paused") return { ok: false, error: "This item is paused. Reactivate it first." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Choose a date." };
  const plats = [...new Set(platforms)];
  if (!plats.length) return { ok: false, error: "Choose at least one platform." };
  const warnings: string[] = [];
  let status: CalendarRow["status"];
  if (p.status === "idea") status = "idea";
  else if (p.status === "drafting") status = p.category === "reel" ? "scripting" : "editing";
  else if (args.gateResult.blockers.length === 0) status = "ready";
  else {
    status = "editing";
    warnings.push(...args.gateResult.blockers.map((b) => b.message));
  }
  const products = (p.products_mentioned ?? []).filter(Boolean);
  const now = args.now ?? new Date().toISOString();
  const rows = plats.map((platform) => ({
    title: displayName(p.pillar_code, p.title).slice(0, 200),
    business: p.business,
    platform,
    post_type: postTypeFor(p),
    status,
    scheduled_date: date,
    scheduled_time: args.time || null,
    owner_account_id: args.owner || null,
    caption: p.caption,
    hashtags: (p.hashtags ?? "").trim() ? p.hashtags : args.series?.default_hashtags ?? null,
    notes: products.length ? `Products: ${products.join(", ")}` : null,
    risky_words_checked: status === "ready",
    premade_post_id: p.id,
    premade_synced_at: now,
  }));
  return { ok: true, rows, warnings };
}

// --- Best-time hints ------------------------------------------------------------------------------------
export type WindowRange = { start: string; end: string; note?: string | null };
export type WindowRow = { day_of_week: number; platform: string; window_text: string | null; ranges: readonly WindowRange[]; quality: "peak" | "good" | "weak" | "avoid" | "none" };
export type HintState = "in_window" | "outside_window" | "avoid" | "weak" | "no_data" | "paid_skip";
const QUALITY_TEXT: Record<WindowRow["quality"], string> = { peak: "peak", good: "good", weak: "weak", avoid: "avoid", none: "no reliable peak" };
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** A non-blocking hint for a date, optional time and platform. Ranges include both ends. */
export function scheduleHint(args: { date: string; time?: string | null; platform: string; windows: readonly WindowRow[]; intent?: string | null }): {
  state: HintState;
  message: string;
  windowsText: string | null;
} {
  const { date, platform, windows } = args;
  if (args.intent === "paid") return { state: "paid_skip", message: "Paid ads follow the ad platform's delivery, not posting windows.", windowsText: null };
  const d = weekdayOf(date);
  const row = windows.find((w) => w.day_of_week === d && w.platform === platform);
  const who = `${dayName(d)} on ${PLATFORM_LABEL[platform] ?? platform}`;
  if (!row) return { state: "no_data", message: `${who}: no data.`, windowsText: null };
  const text = row.window_text ?? "";
  const base = `${who}: ${text || "no window"} (${QUALITY_TEXT[row.quality]})`;
  if (row.quality === "avoid") return { state: "avoid", message: `${base}. Best avoided.`, windowsText: text };
  if (row.quality === "none") return { state: "no_data", message: base, windowsText: text };
  if (row.quality === "weak") return { state: "weak", message: base, windowsText: text };
  const time = (args.time ?? "").trim();
  if (!/^\d{2}:\d{2}/.test(time)) return { state: "no_data", message: base, windowsText: text };
  if (!row.ranges.length) return { state: "no_data", message: base, windowsText: text };
  const t = minutes(time.slice(0, 5));
  const inside = row.ranges.some((r) => t >= minutes(r.start) && t <= minutes(r.end));
  return { state: inside ? "in_window" : "outside_window", message: inside ? `${base}. In the window.` : `${base}. Outside the window.`, windowsText: text };
}

// --- Rhythm and pillar mix -----------------------------------------------------------------------------------
export type RhythmRow = { id: string; days: readonly number[]; label: string; pillar_ids: readonly string[]; active: boolean; archived_at?: string | null; note?: string | null };

/** The active rhythm row for the date's weekday, or null. */
export function rhythmFor<T extends RhythmRow>(date: string, rows: readonly T[]): T | null {
  const d = weekdayOf(date);
  return rows.find((r) => r.active && !r.archived_at && r.days.includes(d)) ?? null;
}

/** Counts per pillar (zeros included) of library-based calendar entries in [from, to] that are past Idea. */
export function pillarMix(args: {
  posts: ReadonlyArray<{ scheduled_date: string | null; status: string; premade_post_id: string | null; pillar_id: string | null; archived_at?: string | null }>;
  pillars: ReadonlyArray<{ id: string; code: string; name: string; archived_at?: string | null }>;
  from: string;
  to: string;
}): Array<{ pillar_id: string; code: string; name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of args.posts) {
    if (!p.premade_post_id || !p.pillar_id || p.status === "idea" || p.archived_at) continue;
    if (!p.scheduled_date || p.scheduled_date < args.from || p.scheduled_date > args.to) continue;
    counts.set(p.pillar_id, (counts.get(p.pillar_id) ?? 0) + 1);
  }
  return args.pillars
    .filter((p) => !p.archived_at)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => ({ pillar_id: p.id, code: p.code, name: p.name, count: counts.get(p.id) ?? 0 }));
}
