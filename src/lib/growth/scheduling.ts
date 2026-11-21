/**
 * Calendar helpers for the Ad Library (pure, tested): turning a library item
 * into calendar entries, best-time hints, the weekly rhythm and the pillar
 * mix. Dates are date-only strings (YYYY-MM-DD); times are Eastern Time
 * "HH:MM" as entered.
 */
import type { PictureFormat, PremadeCategory, PremadeIntent, PremadeStatus } from "./adLibrary";

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook", youtube: "YouTube Shorts", other: "Other" };
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const dayName = (d: number) => DAY[d];

// --- Calendar entries from a library item ---------------------------------------------------------------
export const CALENDAR_PLATFORMS = ["instagram", "facebook", "tiktok", "youtube", "other"] as const;
export const PLATFORM_SHORT: Record<string, string> = { instagram: "IG", facebook: "FB", tiktok: "TT", youtube: "YT", other: "Other" };

export type PremadeForCalendar = {
  id: string;
  name: string;
  category: PremadeCategory;
  picture_format: PictureFormat | null;
  intent: PremadeIntent;
  status: PremadeStatus;
  business: string;
};
export type CalendarRow = {
  title: string;
  business: string;
  platform: string;
  post_type: "reel" | "story" | "post" | "ad";
  status: "scheduled";
  scheduled_date: string;
  scheduled_time: string | null;
  owner_account_id: null;
  caption: null;
  hashtags: null;
  notes: null;
  risky_words_checked: false;
  premade_post_id: string;
  premade_synced_at: null;
  schedule_group_id: string;
};

export function postTypeFor(p: Pick<PremadeForCalendar, "category" | "intent" | "picture_format">): CalendarRow["post_type"] {
  if (p.intent === "paid") return "ad";
  if (p.category === "reel") return "reel";
  return p.picture_format === "story" ? "story" : "post";
}

/**
 * One content_posts row per platform from the scheduling form, all sharing a
 * schedule_group_id, status Scheduled. Entries copy no content: the calendar
 * reads the library post's name, final caption and assets live, and the
 * caption is frozen into the entry only at Mark posted. The stored title is
 * the short name (a fallback). Paused posts are refused.
 */
export function calendarEntriesFromPremade(args: {
  premade: PremadeForCalendar;
  date: string;
  time?: string | null;
  platforms: readonly string[];
  groupId: string;
}): { ok: true; rows: CalendarRow[] } | { ok: false; error: string } {
  const { premade: p, date } = args;
  if (p.status === "paused") return { ok: false, error: "This post is paused. Reactivate it first." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Choose a date." };
  const plats = [...new Set(args.platforms)];
  if (!plats.length) return { ok: false, error: "Choose at least one platform." };
  if (plats.some((x) => !(CALENDAR_PLATFORMS as readonly string[]).includes(x))) return { ok: false, error: "Choose platforms from the list." };
  const time = (args.time ?? "").trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: "Enter a time like 09:30." };
  const rows = plats.map((platform) => ({
    title: p.name.slice(0, 200),
    business: p.business,
    platform,
    post_type: postTypeFor(p),
    status: "scheduled" as const,
    scheduled_date: date,
    scheduled_time: time || null,
    owner_account_id: null,
    caption: null,
    hashtags: null,
    notes: null,
    risky_words_checked: false as const,
    premade_post_id: p.id,
    premade_synced_at: null,
    schedule_group_id: args.groupId,
  }));
  return { ok: true, rows };
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
