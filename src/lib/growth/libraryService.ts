/**
 * Ad Library server code (service role, after the route's growth.marketing
 * check): topics (pillars), subtopics (the content_series table), library
 * posts (reels and picture posts) with their flags, products, assets and
 * needs, caption edits and history, closing lines, scheduling on the
 * calendar, and the data the Ad Library, Pillars, Calendar and Best Times
 * tabs show.
 *
 * Names are short and computed, never stored on the post: topic letter +
 * subtopic letter + "-" + number ("AA-1"), or topic letter + "-" + number
 * ("B-1"). Numbers come from the database functions create_premade_post and
 * move_premade_posts and are never reused.
 */
import { GrowthError, idOrThrow, isUuid } from "./errors";
import {
  FLAG_KEYS,
  PREMADE_INTENTS,
  PREMADE_STATUSES,
  hashPremadeText,
  premadeGateText,
  premadeReadyCheck,
  premadeScanText,
  reletterAlphabetically,
  scanBoth,
  type AssetNeed,
  type FlagKey,
  type ReadyBlocker,
  type ScriptBeat,
} from "./adLibrary";
import { parseDuration } from "./playbookParse";
import { categoryDeleteBlocker, categoryNameError, validateAssetCategory } from "./assetCategories";
import { assetTagsFrom, categoryKeys, setAssetTags } from "./marketingService";
import { todayNy } from "./dates";
import { calendarEntriesFromPremade, CALENDAR_PLATFORMS } from "./scheduling";
import { composeFinalCaption, currentPostName, normalizeHashtagList, postHashtags, scheduleGroupDiff } from "./naming";
import type { Db } from "./routeHelpers";

export type Pillar = { id: string; code: string; name: string; description: string | null; recurring: boolean; sort_order: number; archived_at: string | null; last_unsorted_post_number: number };
/** A subtopic (stored in content_series). */
export type Series = {
  id: string;
  pillar_id: string;
  name: string;
  code: string | null;
  last_post_number: number;
  cover_text: string | null;
  default_hashtags: string | null;
  notes: string | null;
  sort_order: number;
  archived_at: string | null;
};
export type Flag = { id: string; premade_post_id: string; flag_key: FlagKey; detail: Record<string, unknown>; dismissed_by_name: string | null; dismissed_at: string | null; created_at: string };
export type Premade = {
  id: string;
  /** The imported title (optional; new posts have none). */
  title: string | null;
  category: "reel" | "picture_post";
  picture_format: "carousel" | "single_image" | "story" | "unknown" | null;
  business: "botaniqals" | "minileaf" | "brand";
  pillar_id: string;
  series_id: string | null;
  series_position: number | null;
  post_number: number | null;
  name_history: Array<{ name: string; changed_at: string }>;
  status: "idea" | "drafting" | "ready" | "paused";
  intent: "organic" | "paid" | "both";
  is_recurring: boolean;
  platforms: string[];
  /** Imported product tags (read-only; products are linked in premade_post_products). */
  products_mentioned: string[];
  hook: string | null;
  caption: string | null;
  /** Legacy extra hashtags typed on the post before this build (merged last). */
  hashtags: string | null;
  cta_text: string | null;
  style_tag: string | null;
  duration_text: string | null;
  duration_min_seconds: number | null;
  duration_max_seconds: number | null;
  script_beats: ScriptBeat[];
  visual_direction: string | null;
  why_it_converts: string | null;
  visual_notes: string | null;
  best_window_text: string | null;
  best_window_why: string | null;
  asset_needs: AssetNeed[];
  needs_customer_permission: boolean;
  permission_confirmed_by_name: string | null;
  permission_confirmed_at: string | null;
  risky_ack_hash: string | null;
  risky_ack_by_name: string | null;
  risky_ack_at: string | null;
  notes: string | null;
  sort_order: number;
  created_by_name: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};
export type PremadeRow = Premade & {
  /** The short name ("AA-1"), or the old "{letter} - {title}" until the conversion numbers it. */
  name: string;
  /** Same as name (kept for screens that still read display_name). */
  display_name: string;
  flags: Flag[];
  claim_ids: string[];
  asset_ids: string[];
  /** Linked BotanIQals products (formulation product ids). */
  product_ids: string[];
  next_scheduled: string | null;
  last_posted: string | null;
};
export type ClosingLine = { id: string; text: string; used_with_note: string | null; archived_at: string | null };
export type AvoidPhrase = { id: string; phrase: string; note: string | null; source: "playbook" | "manual"; archived_at: string | null };
export type WindowRowDb = {
  id: string;
  day_of_week: number;
  platform: "instagram" | "tiktok" | "facebook";
  window_text: string | null;
  ranges: Array<{ start: string; end: string; note?: string | null }>;
  quality: "peak" | "good" | "weak" | "avoid" | "none";
  source: "playbook" | "own_data";
  updated_by_name: string | null;
  updated_at: string;
};
export type RhythmDb = { id: string; days: number[]; label: string; pillar_ids: string[]; active: boolean; note: string | null; archived_at: string | null };
export type IngredientTag = { id: string; name: string; archived_at: string | null };
export type CaptionVersion = { id: string; caption: string; changed_by_name: string | null; changed_at: string; source: string };

const PREMADE_COLUMNS =
  "id, title, category, picture_format, business, pillar_id, series_id, series_position, post_number, name_history, status, intent, is_recurring, platforms, products_mentioned, hook, caption, hashtags, cta_text, style_tag, duration_text, duration_min_seconds, duration_max_seconds, script_beats, visual_direction, why_it_converts, visual_notes, best_window_text, best_window_why, asset_needs, needs_customer_permission, permission_confirmed_by_name, permission_confirmed_at, risky_ack_hash, risky_ack_by_name, risky_ack_at, notes, sort_order, created_by_name, archived_at, created_at, updated_at";
const PILLAR_COLUMNS = "id, code, name, description, recurring, sort_order, archived_at, last_unsorted_post_number";
const SERIES_COLUMNS = "id, pillar_id, name, code, last_post_number, cover_text, default_hashtags, notes, sort_order, archived_at";
export const CAPTION_MAX = 100000;

type Errors = Record<string, string>;
const txt = (raw: Record<string, unknown>, k: string) => (raw[k] === null || raw[k] === undefined ? "" : String(raw[k]).trim());
function textField(raw: Record<string, unknown>, k: string, max: number, label: string, errors: Errors): string | null {
  const v = txt(raw, k);
  if (v.length > max) errors[k] = `${label}: keep it under ${max} characters.`;
  return v || null;
}
function check(errors: Errors) {
  if (Object.keys(errors).length) throw new GrowthError("Some fields are missing or not valid.", 400, errors);
}
function fail(error: { message?: string; code?: string } | null, message: string): never {
  const m = error?.message ?? "";
  if (/content_pillars_code_unique/.test(m)) throw new GrowthError("Another topic already uses that letter.", 409, { code: "Letter already used." });
  if (/content_pillars_name_unique/.test(m)) throw new GrowthError("Another topic already has that name.", 409, { name: "Name already used." });
  if (/content_series_pillar_name_unique|content_series_name_unique/.test(m)) throw new GrowthError("This topic already has a subtopic with that name.", 409, { name: "Name already used in this topic." });
  if (/premade_posts_group_number_unique/.test(m)) throw new GrowthError("That number was just taken. Try again.", 409);
  if (/26 subtopics|subtopic of this topic|no letter yet|topic is archived|Choose a topic|Enter a subtopic name|Unknown library post|Select the posts/.test(m)) throw new GrowthError(m.replace(/^.*?ERROR:\s*/, ""), 400);
  if (/closing_lines_text_unique/.test(m)) throw new GrowthError("That closing line is already on the list.", 409, { text: "Already on the list." });
  if (/avoid_phrases_phrase_unique/.test(m)) throw new GrowthError("That phrase is already on the list (it may be archived).", 409, { phrase: "Already on the list." });
  if (/asset_ingredient_tags_name_unique/.test(m)) throw new GrowthError("A tag with that name already exists.", 409, { name: "Already exists." });
  if (error?.code === "23514" || /check constraint/i.test(m)) throw new GrowthError(`${message} A value is not valid.`, 400);
  throw new GrowthError(message, 500);
}

// --- Loading ---------------------------------------------------------------------------------------
export async function loadLibraryData(db: Db) {
  const [pl, se, pp, fl, pc, pa, cl, ap, tw, dn, rh, rn, tags, apl, ail, posts, ppp] = await Promise.all([
    db.from("content_pillars").select(PILLAR_COLUMNS),
    db.from("content_series").select(SERIES_COLUMNS),
    db.from("premade_posts").select(PREMADE_COLUMNS),
    db.from("premade_post_flags").select("id, premade_post_id, flag_key, detail, dismissed_by_name, dismissed_at, created_at"),
    db.from("premade_post_claims").select("premade_post_id, claim_id"),
    db.from("premade_post_assets").select("premade_post_id, asset_id"),
    db.from("closing_lines").select("id, text, used_with_note, archived_at"),
    db.from("avoid_phrases").select("id, phrase, note, source, archived_at"),
    db.from("posting_time_windows").select("id, day_of_week, platform, window_text, ranges, quality, source, updated_by_name, updated_at"),
    db.from("posting_day_notes").select("day_of_week, note"),
    db.from("posting_rhythm").select("id, days, label, pillar_ids, active, note, archived_at"),
    db.from("reference_notes").select("key, body"),
    db.from("asset_ingredient_tags").select("id, name, archived_at"),
    db.from("asset_product_links").select("asset_id, formulation_product_id"),
    db.from("asset_ingredient_links").select("asset_id, ingredient_tag_id"),
    db.from("content_posts").select("id, premade_post_id, status, scheduled_date, posted_at, archived_at"),
    db.from("premade_post_products").select("premade_post_id, formulation_product_id"),
  ]);
  for (const r of [pl, se, pp, fl, pc, pa, cl, ap, tw, dn, rh, rn, tags, apl, ail, posts, ppp]) if (r.error) fail(r.error, "Could not load the Ad Library.");
  const dupes = await db.rpc("find_duplicate_post_names", {});
  const pillars = ((pl.data ?? []) as Pillar[]).sort((a, b) => a.code.localeCompare(b.code) || (a.archived_at ? 1 : -1));
  const series = ((se.data ?? []) as Series[]).sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~") || a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const code = new Map(pillars.map((p) => [p.id, p.code]));
  const subCode = new Map(series.map((s) => [s.id, s.code]));
  const today = todayNy();
  const usage = new Map<string, { next: string | null; last: string | null }>();
  for (const p of (posts.data ?? []) as Array<{ premade_post_id: string | null; status: string; scheduled_date: string | null; posted_at: string | null; archived_at: string | null }>) {
    if (!p.premade_post_id || p.archived_at) continue;
    const u = usage.get(p.premade_post_id) ?? { next: null, last: null };
    const d = iso(p.scheduled_date);
    if (p.status === "posted") {
      const when = iso(p.posted_at) ?? d;
      if (when && (!u.last || when > u.last)) u.last = when;
    } else if (d && d >= today && (!u.next || d < u.next)) u.next = d;
    usage.set(p.premade_post_id, u);
  }
  const by = <T extends { premade_post_id: string }>(rows: T[] | null, id: string) => (rows ?? []).filter((r) => r.premade_post_id === id);
  const premades: PremadeRow[] = ((pp.data ?? []) as Premade[]).map((p) => {
    const name = currentPostName(p, code.get(p.pillar_id) ?? "?", p.series_id ? subCode.get(p.series_id) ?? null : null);
    return {
      ...p,
      script_beats: Array.isArray(p.script_beats) ? p.script_beats : [],
      asset_needs: Array.isArray(p.asset_needs) ? p.asset_needs : [],
      name_history: Array.isArray(p.name_history) ? p.name_history : [],
      name,
      display_name: name,
      flags: by(fl.data as Flag[], p.id),
      claim_ids: by(pc.data as Array<{ premade_post_id: string; claim_id: string }>, p.id).map((r) => r.claim_id),
      asset_ids: by(pa.data as Array<{ premade_post_id: string; asset_id: string }>, p.id).map((r) => r.asset_id),
      product_ids: by(ppp.data as Array<{ premade_post_id: string; formulation_product_id: string }>, p.id).map((r) => r.formulation_product_id),
      next_scheduled: usage.get(p.id)?.next ?? null,
      last_posted: usage.get(p.id)?.last ?? null,
    };
  });
  return {
    pillars,
    series,
    premades,
    /** From find_duplicate_post_names(): names shared by more than one non-archived post. */
    duplicateNames: (dupes.error ? [] : ((dupes.data ?? []) as Array<{ name: string; post_ids: string[] }>)) as Array<{ name: string; post_ids: string[] }>,
    closingLines: ((cl.data ?? []) as ClosingLine[]).sort((a, b) => a.text.localeCompare(b.text)),
    avoidPhrases: ((ap.data ?? []) as AvoidPhrase[]).sort((a, b) => a.phrase.localeCompare(b.phrase)),
    windows: (tw.data ?? []) as WindowRowDb[],
    dayNotes: (dn.data ?? []) as Array<{ day_of_week: number; note: string | null }>,
    rhythm: (rh.data ?? []) as RhythmDb[],
    referenceNotes: Object.fromEntries(((rn.data ?? []) as Array<{ key: string; body: string | null }>).map((r) => [r.key, r.body])) as Record<string, string | null>,
    ingredientTags: ((tags.data ?? []) as IngredientTag[]).sort((a, b) => a.name.localeCompare(b.name)),
    assetProductLinks: (apl.data ?? []) as Array<{ asset_id: string; formulation_product_id: string }>,
    assetIngredientLinks: (ail.data ?? []) as Array<{ asset_id: string; ingredient_tag_id: string }>,
  };
}
/** A timestamp as text (database clients may hand back a Date). */
const stamp = (v: unknown): string => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? "" : String(v).trim());
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && v ? v.slice(0, 10) : null);

async function activeWords(db: Db) {
  const [rw, ap] = await Promise.all([db.from("risky_words").select("phrase, archived_at"), db.from("avoid_phrases").select("phrase, archived_at")]);
  const live = (r: { data: Array<{ phrase: string; archived_at: string | null }> | null }) => (r.data ?? []).filter((w) => !w.archived_at).map((w) => w.phrase);
  return { risky: live(rw), avoid: live(ap) };
}

// --- Topics (pillars) --------------------------------------------------------------------------------
async function getPillar(db: Db, id: unknown): Promise<Pillar> {
  const { data } = await db.from("content_pillars").select(PILLAR_COLUMNS).eq("id", idOrThrow(id, "topic")).maybeSingle();
  if (!data) throw new GrowthError("Unknown topic.", 404);
  return data;
}

function pillarFields(raw: Record<string, unknown>) {
  const errors: Errors = {};
  const code = txt(raw, "code").toUpperCase();
  if (!/^[A-Z]$/.test(code)) errors.code = "Choose one letter from A to Z.";
  const name = txt(raw, "name");
  if (!name) errors.name = "Enter a name.";
  else if (name.length > 100) errors.name = "Keep the name under 100 characters.";
  const description = textField(raw, "description", 500, "Description", errors);
  check(errors);
  return { code, name, description, recurring: raw.recurring === true };
}

export async function createPillar(db: Db, input: Record<string, unknown>) {
  const v = pillarFields(input);
  const { data, error } = await db.from("content_pillars").insert(v).select(PILLAR_COLUMNS).single();
  if (error) fail(error, "Could not save the topic.");
  return data as Pillar;
}

/** After a topic letter changes: calendar entries that aren't Posted get the posts' new names as their stored titles. */
async function syncCalendarTitles(db: Db, postIds: string[] | null) {
  const { error } = await db.rpc("sync_calendar_titles", { p_post_ids: postIds });
  if (error) fail(error, "Could not update the calendar titles.");
}

/** Edit a topic, or { archive }, { restore }. Archive is blocked while the topic has active posts or active subtopics. */
export async function updatePillar(db: Db, id: unknown, input: Record<string, unknown>) {
  const p = await getPillar(db, id);
  if (input.archive === true) {
    const [{ data: items }, { data: subs }] = await Promise.all([
      db.from("premade_posts").select("id, archived_at").eq("pillar_id", p.id),
      db.from("content_series").select("id, archived_at").eq("pillar_id", p.id),
    ]);
    const live = ((items ?? []) as Array<{ archived_at: string | null }>).filter((i) => !i.archived_at).length;
    const liveSubs = ((subs ?? []) as Array<{ archived_at: string | null }>).filter((i) => !i.archived_at).length;
    if (live || liveSubs) {
      const parts = [live ? `${live} post${live === 1 ? "" : "s"}` : "", liveSubs ? `${liveSubs} subtopic${liveSubs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
      throw new GrowthError(`This topic still has ${parts}. Move or archive them first.`, 409);
    }
    const { error } = await db.from("content_pillars").update({ archived_at: new Date().toISOString() }).eq("id", p.id);
    if (error) fail(error, "Could not archive the topic.");
    return { ok: true };
  }
  if (input.restore === true) {
    const { error } = await db.from("content_pillars").update({ archived_at: null }).eq("id", p.id);
    if (error) fail(error, "Could not restore the topic (its letter or name may be in use).");
    return { ok: true };
  }
  const v = pillarFields(input);
  if (v.code !== p.code) {
    const plan = await reletterPlan(db, { [p.id]: v.code });
    if (plan.duplicates.length) throw new GrowthError(`That letter would give duplicate names: ${plan.duplicates.join(", ")}.`, 409, { code: "Would create duplicate names." });
  }
  const { data, error } = await db.from("content_pillars").update(v).eq("id", p.id).select(PILLAR_COLUMNS).single();
  if (error) fail(error, "Could not save the topic.");
  if (v.code !== p.code) await syncCalendarTitles(db, null);
  return data as Pillar;
}

async function reletterInputs(db: Db) {
  const [{ data: pillars }, { data: items }, { data: subs }] = await Promise.all([
    db.from("content_pillars").select(PILLAR_COLUMNS),
    db.from("premade_posts").select("id, pillar_id, series_id, post_number, title, archived_at"),
    db.from("content_series").select("id, code"),
  ]);
  const code = new Map(((subs ?? []) as Array<{ id: string; code: string | null }>).map((s) => [s.id, s.code]));
  const posts = ((items ?? []) as Array<{ id: string; pillar_id: string; series_id: string | null; post_number: number | null; title: string | null; archived_at: string | null }>).map((i) => ({
    ...i,
    subtopicCode: i.series_id ? code.get(i.series_id) ?? null : null,
  }));
  return { pillars: (pillars ?? []) as Pillar[], posts };
}

/** The effect of new letters on post names: affected posts (old to new) and any duplicates they would create. */
async function reletterPlan(db: Db, codes: Record<string, string>) {
  const { pillars, posts } = await reletterInputs(db);
  return reletterAlphabetically(pillars, posts, codes);
}

/** Preview (apply: false) or apply the alphabetical re-lettering in one transaction. Blocked if it would create duplicate names. */
export async function reletterPillars(db: Db, apply: boolean) {
  const { pillars, posts } = await reletterInputs(db);
  let plan;
  try {
    plan = reletterAlphabetically(pillars, posts);
  } catch (e) {
    throw new GrowthError((e as Error).message, 400);
  }
  if (apply && plan.changes.length) {
    if (plan.duplicates.length) throw new GrowthError(`Re-lettering would create duplicate names: ${plan.duplicates.join(", ")}. Nothing changed.`, 409);
    const { error } = await db.rpc("reletter_pillars", { p_codes: plan.codes });
    if (error) fail(error, "Could not re-letter the topics.");
    await syncCalendarTitles(db, null);
  }
  return plan;
}

// --- Subtopics (content_series) ---------------------------------------------------------------------------
/**
 * New subtopic: { pillar_id, name } (the letter is assigned in the database).
 * Edit: name, hashtags (normalized to "#tag #tag"), notes, cover text.
 * { archive } is blocked while active posts use it; { restore }.
 */
export async function saveSeries(db: Db, id: unknown | null, input: Record<string, unknown>) {
  if (!id) {
    const pillar = await getPillar(db, input.pillar_id);
    const name = txt(input, "name");
    if (!name || name.length > 200) throw new GrowthError("Enter a subtopic name (up to 200 characters).", 400, { name: "Enter a name." });
    const { data, error } = await db.rpc("create_subtopic", { p_pillar_id: pillar.id, p_name: name });
    if (error) fail(error, "Could not add the subtopic.");
    return data as { id: string; code: string };
  }
  const sid = idOrThrow(id, "subtopic");
  const { data: cur } = await db.from("content_series").select(SERIES_COLUMNS).eq("id", sid).maybeSingle();
  if (!cur) throw new GrowthError("Unknown subtopic.", 404);
  if (input.archive === true) {
    const { data: items } = await db.from("premade_posts").select("id, archived_at").eq("series_id", sid);
    const live = ((items ?? []) as Array<{ archived_at: string | null }>).filter((i) => !i.archived_at).length;
    if (live) throw new GrowthError(`${live} post${live === 1 ? " uses" : "s use"} this subtopic. Move them to another subtopic first.`, 409);
    const { error } = await db.from("content_series").update({ archived_at: new Date().toISOString() }).eq("id", sid);
    if (error) fail(error, "Could not archive the subtopic.");
    return { id: sid, code: cur.code };
  }
  if (input.restore === true) {
    const { error } = await db.from("content_series").update({ archived_at: null }).eq("id", sid);
    if (error) fail(error, "Could not restore the subtopic (its name may be in use).");
    return { id: sid, code: cur.code };
  }
  const errors: Errors = {};
  const name = txt(input, "name");
  if (!name) errors.name = "Enter a name.";
  else if (name.length > 200) errors.name = "Keep the name under 200 characters.";
  const hashtags = normalizeHashtagList(input.default_hashtags === undefined ? cur.default_hashtags : String(input.default_hashtags ?? ""));
  if ((hashtags ?? "").length > 2000) errors.default_hashtags = "Keep the hashtags under 2000 characters.";
  const row = {
    name,
    default_hashtags: hashtags,
    cover_text: textField(input, "cover_text", 300, "Cover text", errors),
    notes: textField(input, "notes", 1000, "Notes", errors),
  };
  check(errors);
  const { error } = await db.from("content_series").update(row).eq("id", sid);
  if (error) fail(error, "Could not save the subtopic.");
  return { id: sid, code: cur.code };
}

// --- Library posts -------------------------------------------------------------------------------------
async function getPremade(db: Db, id: unknown): Promise<Premade> {
  const { data, error } = await db.from("premade_posts").select(PREMADE_COLUMNS).eq("id", idOrThrow(id, "library item")).maybeSingle();
  if (error) fail(error, "Could not load the library item.");
  if (!data) throw new GrowthError("Unknown library item.", 404);
  return { ...data, script_beats: data.script_beats ?? [], asset_needs: data.asset_needs ?? [] };
}

function beatsFrom(raw: unknown, errors: Errors): ScriptBeat[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.script_beats = "Script beats are not valid.";
    return [];
  }
  const beats = (raw as Array<Record<string, unknown>>)
    .map((b) => ({ time: String(b?.time ?? "").trim(), beat: String(b?.beat ?? "").trim() }))
    .filter((b) => b.time || b.beat);
  if (beats.length > 20) errors.script_beats = "At most 20 script beats.";
  if (beats.some((b) => !b.beat)) errors.script_beats = "Every beat needs text.";
  if (beats.some((b) => b.beat.length > 1000 || b.time.length > 20)) errors.script_beats = "A beat is too long.";
  return beats.map((b) => (b.time ? b : { beat: b.beat }));
}

export function needsFrom(raw: unknown, errors: Errors): AssetNeed[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) {
    errors.asset_needs = "At most 20 needs.";
    return [];
  }
  const out: AssetNeed[] = [];
  for (const n of raw as Array<Record<string, unknown>>) {
    const key = String(n?.key ?? "").trim();
    const label = String(n?.label ?? "").trim();
    const kind = String(n?.kind ?? "other");
    const status = n?.status === "ready" ? "ready" : "needed";
    const asset_id = n?.asset_id && isUuid(n.asset_id) ? String(n.asset_id) : null;
    if (!key || key.length > 80 || !label || label.length > 120 || !["graphic", "photo", "video", "other"].includes(kind)) {
      errors.asset_needs = "Each need needs a key, a label and a kind.";
      continue;
    }
    if (out.some((x) => x.key === key)) {
      errors.asset_needs = `Two needs use the key "${key}".`;
      continue;
    }
    const note = String(n?.note ?? "").trim().slice(0, 200) || null;
    out.push({ key, label, kind: kind as AssetNeed["kind"], status, asset_id, note });
  }
  return out;
}

/** Linked product ids from the request, checked against Formulation (active products only). */
async function productIdsFrom(db: Db, raw: unknown): Promise<string[] | undefined> {
  if (raw === undefined) return undefined;
  const ids = Array.isArray(raw) ? [...new Set((raw as unknown[]).map(String))] : [];
  if (ids.some((x) => !isUuid(x))) throw new GrowthError("Choose products from the list.", 400, { product_ids: "Choose products from the list." });
  if (ids.length) {
    const { data } = await db.from("formulation_products").select("id, deleted_at").in("id", ids);
    if (((data ?? []) as Array<{ deleted_at: string | null }>).filter((p) => !p.deleted_at).length !== ids.length) throw new GrowthError("Choose products from the list.", 400, { product_ids: "Choose products from the list." });
  }
  return ids;
}

async function assetIdsFrom(db: Db, raw: unknown): Promise<string[] | undefined> {
  if (raw === undefined) return undefined;
  const ids = Array.isArray(raw) ? [...new Set((raw as unknown[]).map(String))] : [];
  if (ids.some((x) => !isUuid(x))) throw new GrowthError("Unknown asset.", 400);
  if (ids.length) {
    const { data } = await db.from("marketing_assets").select("id").in("id", ids);
    if ((data ?? []).length !== ids.length) throw new GrowthError("Unknown asset.", 404);
  }
  return ids;
}

/**
 * Validated post fields from the form. Topic (pillar) and subtopic are
 * handled by the numbering functions, not here. Picture posts have no hook in
 * the form (an existing hook is kept as it is).
 */
function premadeFields(raw: Record<string, unknown>, category: "reel" | "picture_post", cur?: Premade) {
  const errors: Errors = {};
  if (!isUuid(raw.pillar_id)) errors.pillar_id = "Choose a topic.";
  if (raw.series_id && !isUuid(raw.series_id)) errors.series_id = "Choose a subtopic from the list.";
  const newSub = txt(raw, "new_subtopic_name");
  if (newSub.length > 200) errors.new_subtopic_name = "Keep the subtopic name under 200 characters.";
  const business = txt(raw, "business") || "botaniqals";
  if (!["botaniqals", "minileaf", "brand"].includes(business)) errors.business = "Choose a business.";
  const status = txt(raw, "status") || "drafting";
  if (!(PREMADE_STATUSES as string[]).includes(status)) errors.status = "Choose a status.";
  const intent = txt(raw, "intent") || "organic";
  if (!(PREMADE_INTENTS as string[]).includes(intent)) errors.intent = "Choose an intent.";
  const picture_format = category === "picture_post" ? txt(raw, "picture_format") || "unknown" : null;
  if (picture_format && !["carousel", "single_image", "story", "unknown"].includes(picture_format)) errors.picture_format = "Choose a format.";
  const caption = raw.caption === undefined || raw.caption === null ? null : String(raw.caption).replace(/\s+$/u, "") || null;
  if ((caption ?? "").length > CAPTION_MAX) errors.caption = `Keep the caption under ${CAPTION_MAX} characters.`;
  const duration_text = textField(raw, "duration_text", 30, "Duration", errors);
  const parsed = parseDuration(duration_text);
  const v = {
    business,
    status,
    intent,
    picture_format,
    hook: category === "reel" ? textField(raw, "hook", 300, "Hook", errors) : cur?.hook ?? null,
    caption,
    cta_text: textField(raw, "cta_text", 200, "CTA", errors),
    style_tag: textField(raw, "style_tag", 60, "Style", errors),
    duration_text,
    duration_min_seconds: parsed?.min ?? null,
    duration_max_seconds: parsed?.max ?? null,
    script_beats: beatsFrom(raw.script_beats, errors),
    visual_direction: textField(raw, "visual_direction", 2000, "Visual direction", errors),
    why_it_converts: textField(raw, "why_it_converts", 2000, "Why it converts", errors),
    visual_notes: textField(raw, "visual_notes", 500, "Visual notes", errors),
    best_window_text: textField(raw, "best_window_text", 200, "Best window", errors),
    best_window_why: textField(raw, "best_window_why", 300, "Why this window", errors),
    needs_customer_permission: raw.needs_customer_permission === true,
    notes: textField(raw, "notes", 2000, "Notes", errors),
  };
  check(errors);
  return { v, pillarId: String(raw.pillar_id), seriesId: raw.series_id ? String(raw.series_id) : null, newSub: newSub || null };
}

/** The hashtags posting adds for a post: subtopic, then linked products (by name order, like the form), then legacy extras. */
export async function hashtagsFor(db: Db, p: Pick<Premade, "id" | "series_id" | "hashtags">): Promise<string[]> {
  const [{ data: s }, { data: links }] = await Promise.all([
    p.series_id ? db.from("content_series").select("default_hashtags").eq("id", p.series_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from("premade_post_products").select("formulation_product_id").eq("premade_post_id", p.id),
  ]);
  const ids = ((links ?? []) as Array<{ formulation_product_id: string }>).map((l) => l.formulation_product_id);
  let productTags: Array<string | null> = [];
  if (ids.length) {
    const [{ data: prods }, { data: profiles }] = await Promise.all([
      db.from("formulation_products").select("id, name").in("id", ids),
      db.from("marketing_product_profiles").select("formulation_product_id, hashtags").in("formulation_product_id", ids),
    ]);
    const tags = new Map(((profiles ?? []) as Array<{ formulation_product_id: string; hashtags: string | null }>).map((r) => [r.formulation_product_id, r.hashtags]));
    productTags = ((prods ?? []) as Array<{ id: string; name: string }>).sort((a, b) => a.name.localeCompare(b.name)).map((x) => tags.get(x.id) ?? null);
  }
  return postHashtags((s as { default_hashtags: string | null } | null)?.default_hashtags ?? null, productTags, p.hashtags);
}

/** The caption as it will be posted: the body, two blank lines, then the hashtags. */
export async function finalCaptionFor(db: Db, p: Premade): Promise<string> {
  return composeFinalCaption(p.caption, await hashtagsFor(db, p));
}

/** The server-side Ready gate for a post as it is in the database now (words are checked in the FINAL caption). */
export async function gateFor(db: Db, p: Premade): Promise<{ blockers: ReadyBlocker[]; hash: string; hits: ReturnType<typeof scanBoth> }> {
  const words = await activeWords(db);
  const text = premadeGateText(p, await finalCaptionFor(db, p));
  const hits = scanBoth(premadeScanText(text), words.risky, words.avoid);
  const hash = hashPremadeText(text);
  return { blockers: premadeReadyCheck({ premade: p, hits, currentTextHash: hash }), hash, hits };
}

/** The post's current name (computed; "AA-1"). */
export async function nameFor(db: Db, p: Pick<Premade, "pillar_id" | "series_id" | "post_number" | "title">): Promise<string> {
  const pillar = await getPillar(db, p.pillar_id);
  const sub = p.series_id ? (await db.from("content_series").select("code").eq("id", p.series_id).maybeSingle()).data : null;
  return currentPostName(p, pillar.code, (sub as { code: string | null } | null)?.code ?? null);
}

async function setProductLinks(db: Db, premadeId: string, ids: string[]) {
  const { data: cur } = await db.from("premade_post_products").select("formulation_product_id").eq("premade_post_id", premadeId);
  const have = new Set(((cur ?? []) as Array<{ formulation_product_id: string }>).map((r) => r.formulation_product_id));
  for (const x of have) if (!ids.includes(x)) await db.from("premade_post_products").delete().eq("premade_post_id", premadeId).eq("formulation_product_id", x);
  for (const x of ids) if (!have.has(x)) await db.from("premade_post_products").insert({ premade_post_id: premadeId, formulation_product_id: x });
}

async function setAssetLinks(db: Db, premadeId: string, ids: string[]) {
  const { data: cur } = await db.from("premade_post_assets").select("asset_id").eq("premade_post_id", premadeId);
  const have = new Set(((cur ?? []) as Array<{ asset_id: string }>).map((r) => r.asset_id));
  for (const x of have) if (!ids.includes(x)) await db.from("premade_post_assets").delete().eq("premade_post_id", premadeId).eq("asset_id", x);
  for (const x of ids) if (!have.has(x)) await db.from("premade_post_assets").insert({ premade_post_id: premadeId, asset_id: x });
}

/**
 * New post. Assets, needs and products chosen before the first save are
 * saved with it in one transaction (create_premade_post), which also
 * creates a new subtopic when one is named and assigns the number.
 */
export async function createPremade(db: Db, input: Record<string, unknown>, actor: string | null) {
  const category = txt(input, "category");
  if (category !== "reel" && category !== "picture_post") throw new GrowthError("Choose Reel or Picture post.", 400, { category: "Choose a category." });
  const { v, pillarId, seriesId, newSub } = premadeFields(input, category);
  if (v.status === "ready") v.status = "drafting"; // Ready is set after the gate passes.
  const errors: Errors = {};
  const asset_needs = needsFrom(input.asset_needs, errors);
  check(errors);
  const productIds = (await productIdsFrom(db, input.product_ids)) ?? [];
  const assetIds = [...new Set([...((await assetIdsFrom(db, input.asset_ids)) ?? []), ...asset_needs.filter((n) => n.status === "ready" && n.asset_id).map((n) => n.asset_id!)])];
  const pillar = await getPillar(db, pillarId);
  if (pillar.archived_at) throw new GrowthError("That topic is archived. Choose an active topic.", 400, { pillar_id: "Choose an active topic." });
  const { data, error } = await db.rpc("create_premade_post", {
    payload: {
      pillar_id: pillarId,
      series_id: newSub ? null : seriesId,
      new_subtopic_name: newSub,
      actor_name: actor,
      post: { ...v, category, asset_needs, hashtags: null, title: null },
      asset_ids: assetIds,
      product_ids: productIds,
    },
  });
  if (error) fail(error, "Could not save the post.");
  const r = data as { id: string; name: string };
  return { id: r.id, name: r.name, notice: null as string | null };
}

/**
 * Saves the form. A caption change goes through update_premade_caption
 * (recorded in the caption history with the editor's name). Changing the
 * topic or subtopic renumbers the post (move_premade_posts). Setting Ready
 * runs the gate; a Ready post whose gate no longer passes goes back to
 * Drafting and says why.
 */
export async function updatePremade(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null) {
  const cur = await getPremade(db, id);
  const { v, pillarId, seriesId, newSub } = premadeFields(input, cur.category, cur);
  const errors: Errors = {};
  const asset_needs = input.asset_needs === undefined ? cur.asset_needs : needsFrom(input.asset_needs, errors);
  check(errors);
  const productIds = await productIdsFrom(db, input.product_ids);
  const assetIds = await assetIdsFrom(db, input.asset_ids);
  const notices: string[] = [];
  const { caption, ...rest } = v;
  if ((caption ?? null) !== (cur.caption ?? null)) {
    const { data, error } = await db.rpc("update_premade_caption", { p_post_id: cur.id, p_expected_updated_at: stamp(input.expected_updated_at) || stamp(cur.updated_at), p_caption: caption ?? "", p_actor_name: actor ?? "Unknown", p_source: "form" });
    if (error) fail(error, "Could not save the caption.");
    if ((data as { conflict?: boolean }).conflict) throw new GrowthError("This post was changed by someone else. Reload it and try again.", 409);
  }
  const wantReady = rest.status === "ready";
  const patch: Record<string, unknown> = { ...rest, asset_needs, status: wantReady && cur.status !== "ready" ? cur.status : rest.status };
  if (!(caption ?? "")) patch.caption = null;
  else delete patch.caption;
  if (input.clear_title === true) patch.title = null;
  if (input.clear_imported_tags === true) patch.products_mentioned = [];
  if (input.clear_extra_hashtags === true) patch.hashtags = null;
  const { error } = await db.from("premade_posts").update(patch).eq("id", cur.id);
  if (error) fail(error, "Could not save the post.");
  if (productIds) await setProductLinks(db, cur.id, productIds);
  if (assetIds) await setAssetLinks(db, cur.id, assetIds);
  if (pillarId !== cur.pillar_id || (seriesId ?? null) !== (cur.series_id ?? null) || newSub) {
    const moved = await movePosts(db, [cur.id], pillarId, newSub ? null : seriesId, newSub, actor);
    if (moved[0]) notices.push(`Renamed ${moved[0].old_name} to ${moved[0].new_name}.`);
  }
  const saved = await getPremade(db, cur.id);
  if (wantReady) {
    const gate = await gateFor(db, saved);
    if (gate.blockers.length) {
      if (cur.status === "ready") {
        await db.from("premade_posts").update({ status: "drafting" }).eq("id", cur.id);
        notices.push(`Moved back to Drafting: ${gate.blockers.map((b) => b.message).join(" ")}`);
      } else {
        throw new GrowthError(`Not ready yet. ${gate.blockers.map((b) => b.message).join(" ")}`, 400, { status: "Not ready yet." });
      }
    } else if (cur.status !== "ready") {
      await db.from("premade_posts").update({ status: "ready" }).eq("id", cur.id);
    }
  }
  return { id: cur.id, name: await nameFor(db, saved), notice: notices.join(" ") || null };
}

/** Moves posts to a topic and subtopic (or none, or a new one); each gets the next number of its new group. */
export async function movePosts(db: Db, ids: string[], pillarId: string, subtopicId: string | null, newSubtopicName: string | null, actor: string | null) {
  const pillar = await getPillar(db, pillarId);
  if (pillar.archived_at) throw new GrowthError("That topic is archived. Choose an active topic.", 400);
  const { data, error } = await db.rpc("move_premade_posts", { p_post_ids: ids, p_pillar_id: pillarId, p_subtopic_id: subtopicId, p_new_subtopic_name: newSubtopicName, p_actor_name: actor });
  if (error) fail(error, "Could not move the posts.");
  return (data ?? []) as Array<{ id: string; old_name: string; new_name: string }>;
}

/**
 * Edit caption (from the table): changes ONLY the caption, and only if the
 * post hasn't changed since the editor opened it. On a conflict, returns the
 * current caption so the editor can choose. A Ready post whose gate no longer
 * passes goes back to Drafting, with the reason.
 */
export async function updateCaption(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null) {
  const pid = idOrThrow(id, "library post");
  const caption = input.caption === undefined || input.caption === null ? "" : String(input.caption);
  if (caption.length > CAPTION_MAX) throw new GrowthError(`Keep the caption under ${CAPTION_MAX} characters.`, 400, { caption: "Too long." });
  const expected = stamp(input.expected_updated_at);
  if (!expected) throw new GrowthError("Reload the post and try again.", 400);
  const source = ["table_edit", "restore"].includes(txt(input, "source")) ? txt(input, "source") : "table_edit";
  const { data, error } = await db.rpc("update_premade_caption", { p_post_id: pid, p_expected_updated_at: expected, p_caption: caption, p_actor_name: actor ?? "Unknown", p_source: source });
  if (error) fail(error, "Could not save the caption.");
  const r = data as { ok?: boolean; updated_at?: string; conflict?: boolean; current_caption?: string | null; current_updated_at?: string };
  if (r.conflict) return { conflict: true as const, current_caption: r.current_caption ?? "", current_updated_at: r.current_updated_at ?? "" };
  const notice = await recheckReady(db, pid);
  const after = await getPremade(db, pid);
  return { ok: true as const, updated_at: stamp(after.updated_at), notice };
}

/** The last 10 earlier captions of a post (newest first). */
export async function captionHistory(db: Db, id: unknown): Promise<CaptionVersion[]> {
  const pid = idOrThrow(id, "library post");
  const { data, error } = await db.from("premade_post_caption_history").select("id, caption, changed_by_name, changed_at, source").eq("premade_post_id", pid).order("changed_at", { ascending: false }).limit(10);
  if (error) fail(error, "Could not load the earlier captions.");
  return (data ?? []) as CaptionVersion[];
}

async function dismissFlag(db: Db, premadeId: string, key: FlagKey, actor: string | null, note: string | null, quiet = false) {
  const { data } = await db.from("premade_post_flags").select("id, detail, dismissed_at").eq("premade_post_id", premadeId).eq("flag_key", key).maybeSingle();
  if (!data || data.dismissed_at) {
    if (quiet) return;
    throw new GrowthError("That flag is not open.", 400);
  }
  const detail = note ? { ...(data.detail ?? {}), dismiss_note: note } : data.detail ?? {};
  const { error } = await db.from("premade_post_flags").update({ dismissed_by_name: actor ?? "Unknown", dismissed_at: new Date().toISOString(), detail }).eq("id", data.id);
  if (error) fail(error, "Could not dismiss the flag.");
}

/** Post actions: duplicate, pause, reactivate, archive, restore, confirm_permission, clear_permission, ack_words, dismiss_flag. */
export async function premadeAction(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null) {
  const p = await getPremade(db, id);
  const action = txt(input, "action");
  const now = new Date().toISOString();
  const set = async (patch: Record<string, unknown>) => {
    const { error } = await db.from("premade_posts").update(patch).eq("id", p.id);
    if (error) fail(error, "Could not update the post.");
  };
  switch (action) {
    case "duplicate": {
      // A copy as the next number of the same group.
      const [{ data: assets }, { data: prods }] = await Promise.all([
        db.from("premade_post_assets").select("asset_id").eq("premade_post_id", p.id),
        db.from("premade_post_products").select("formulation_product_id").eq("premade_post_id", p.id),
      ]);
      const post = {
        category: p.category,
        picture_format: p.picture_format,
        business: p.business,
        status: "drafting",
        intent: p.intent,
        products_mentioned: p.products_mentioned,
        hook: p.hook,
        caption: p.caption,
        hashtags: p.hashtags,
        cta_text: p.cta_text,
        style_tag: p.style_tag,
        duration_text: p.duration_text,
        duration_min_seconds: p.duration_min_seconds,
        duration_max_seconds: p.duration_max_seconds,
        script_beats: p.script_beats,
        visual_direction: p.visual_direction,
        why_it_converts: p.why_it_converts,
        visual_notes: p.visual_notes,
        best_window_text: p.best_window_text,
        best_window_why: p.best_window_why,
        asset_needs: p.asset_needs,
        needs_customer_permission: p.needs_customer_permission,
        notes: p.notes,
      };
      const { data, error } = await db.rpc("create_premade_post", {
        payload: {
          pillar_id: p.pillar_id,
          series_id: p.series_id,
          actor_name: actor,
          post,
          asset_ids: ((assets ?? []) as Array<{ asset_id: string }>).map((a) => a.asset_id),
          product_ids: ((prods ?? []) as Array<{ formulation_product_id: string }>).map((a) => a.formulation_product_id),
        },
      });
      if (error) fail(error, "Could not duplicate the post.");
      return { id: (data as { id: string }).id, name: (data as { name: string }).name };
    }
    case "pause":
      await set({ status: "paused" });
      break;
    case "reactivate":
      if (p.status !== "paused") throw new GrowthError("This post is not paused.", 400);
      await set({ status: "drafting" });
      break;
    case "archive":
      await set({ archived_at: now });
      break;
    case "restore":
      await set({ archived_at: null });
      break;
    case "confirm_permission":
      await set({ permission_confirmed_by_name: actor ?? "Unknown", permission_confirmed_at: now });
      break;
    case "clear_permission":
      await set({ permission_confirmed_by_name: null, permission_confirmed_at: null, ...(p.status === "ready" && p.needs_customer_permission ? { status: "drafting" } : {}) });
      break;
    case "ack_words": {
      const { hash } = await gateFor(db, p);
      if (input.hash && input.hash !== hash) throw new GrowthError("The text changed after you reviewed it. Save first, then tick Words reviewed again.", 409);
      await set({ risky_ack_hash: hash, risky_ack_by_name: actor ?? "Unknown", risky_ack_at: now });
      break;
    }
    case "dismiss_flag": {
      const key = txt(input, "flag_key") as FlagKey;
      if (!(FLAG_KEYS as readonly string[]).includes(key)) throw new GrowthError("Unknown flag.", 400);
      await dismissFlag(db, p.id, key, actor, txt(input, "note") || null);
      break;
    }
    default:
      throw new GrowthError("Unknown action.", 400);
  }
  return { id: p.id };
}

/** Bulk: set_topic (renumbers; can create a subtopic), set_products, pause, reactivate, archive, dismiss_flag (with a note). */
export async function premadeBulk(db: Db, input: Record<string, unknown>, actor: string | null) {
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map(String))] : [];
  if (!ids.length || ids.length > 500 || ids.some((x) => !isUuid(x))) throw new GrowthError("Select the posts first.", 400);
  const { data } = await db.from("premade_posts").select("id, status, pillar_id, archived_at").in("id", ids);
  const items = (data ?? []) as Array<{ id: string; status: string; pillar_id: string; archived_at: string | null }>;
  if (items.length !== ids.length) throw new GrowthError("Unknown library post.", 404);
  const action = txt(input, "action");
  const now = new Date().toISOString();
  const each = async (patch: (i: (typeof items)[number]) => Record<string, unknown> | null) => {
    for (const i of items) {
      const p = patch(i);
      if (!p) continue;
      const { error } = await db.from("premade_posts").update(p).eq("id", i.id);
      if (error) fail(error, "Could not update the posts.");
    }
  };
  switch (action) {
    case "pause":
      await each(() => ({ status: "paused" }));
      break;
    case "reactivate":
      await each((i) => (i.status === "paused" ? { status: "drafting" } : null));
      break;
    case "archive":
      await each(() => ({ archived_at: now }));
      break;
    case "set_topic": {
      if (!isUuid(input.pillar_id)) throw new GrowthError("Choose a topic.", 400);
      const sub = input.subtopic_id ? idOrThrow(input.subtopic_id, "subtopic") : null;
      const newName = txt(input, "new_subtopic_name") || null;
      const moved = await movePosts(db, ids, String(input.pillar_id), newName ? null : sub, newName, actor);
      return { count: items.length, moved };
    }
    case "set_products": {
      const productIds = (await productIdsFrom(db, input.product_ids)) ?? [];
      for (const i of items) await setProductLinks(db, i.id, productIds);
      break;
    }
    case "dismiss_flag": {
      const key = txt(input, "flag_key") as FlagKey;
      if (!(FLAG_KEYS as readonly string[]).includes(key)) throw new GrowthError("Unknown flag.", 400);
      const note = txt(input, "note");
      if (note.length < 3) throw new GrowthError("Add a short note saying why.", 400, { note: "Add a short note." });
      if (note.length > 200) throw new GrowthError("Keep the note under 200 characters.", 400, { note: "Too long." });
      for (const i of items) await dismissFlag(db, i.id, key, actor, note, true);
      break;
    }
    default:
      throw new GrowthError("Unknown action.", 400);
  }
  return { count: items.length };
}

// --- Closing lines ---------------------------------------------------------------------------------------
export async function saveClosingLine(db: Db, id: unknown | null, input: Record<string, unknown>) {
  if (id && (input.archive === true || input.restore === true)) {
    const { error } = await db.from("closing_lines").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", idOrThrow(id, "closing line"));
    if (error) fail(error, "Could not update the closing line.");
    return;
  }
  const errors: Errors = {};
  const text = txt(input, "text").replace(/\s+/g, " ");
  if (!text) errors.text = "Enter the closing line.";
  else if (text.length > 300) errors.text = "Keep it under 300 characters.";
  const used_with_note = textField(input, "used_with_note", 100, "Used with", errors);
  check(errors);
  const r = id ? await db.from("closing_lines").update({ text, used_with_note }).eq("id", idOrThrow(id, "closing line")) : await db.from("closing_lines").insert({ text, used_with_note });
  if (r.error) fail(r.error, "Could not save the closing line.");
}

export { fail as libraryFail, getPremade, getPillar };

// --- Needs (assets a library item still needs) ------------------------------------------------------
type NeedRow = { id: string; status: string; asset_needs: AssetNeed[] };

async function assetExists(db: Db, id: unknown) {
  const aid = idOrThrow(id, "asset");
  const { data } = await db.from("marketing_assets").select("id, status").eq("id", aid).maybeSingle();
  if (!data || data.status === "archived") throw new GrowthError("Choose an asset from the library.", 400);
  return aid;
}
async function attach(db: Db, premadeId: string, assetId: string) {
  const { data } = await db.from("premade_post_assets").select("premade_post_id").eq("premade_post_id", premadeId).eq("asset_id", assetId).maybeSingle();
  if (!data) await db.from("premade_post_assets").insert({ premade_post_id: premadeId, asset_id: assetId });
}
async function writeNeeds(db: Db, id: string, needs: AssetNeed[]) {
  const { error } = await db.from("premade_posts").update({ asset_needs: needs }).eq("id", id);
  if (error) fail(error, "Could not save the needs.");
}
/** A Ready item whose gate fails after a needs change goes back to Drafting. Returns a notice or null. */
async function recheckReady(db: Db, id: string): Promise<string | null> {
  const p = await getPremade(db, id);
  if (p.status !== "ready") return null;
  const gate = await gateFor(db, p);
  if (!gate.blockers.length) return null;
  await db.from("premade_posts").update({ status: "drafting" }).eq("id", id);
  return `Moved back to Drafting: ${gate.blockers.map((b) => b.message).join(" ")}`;
}

/**
 * One item's needs: attach (sets the need ready with the asset, adds the
 * attachment, and optionally does the same on other items with that need),
 * unlink, add, remove; and plain attach_asset / detach_asset.
 */
export async function needsAction(db: Db, id: unknown, input: Record<string, unknown>) {
  const p = await getPremade(db, id);
  const op = txt(input, "op");
  const key = txt(input, "key");
  const notices: string[] = [];
  if (op === "attach") {
    const assetId = await assetExists(db, input.asset_id);
    if (!p.asset_needs.some((n) => n.key === key)) throw new GrowthError("Unknown need.", 404);
    const also = Array.isArray(input.also_ids) ? (input.also_ids as unknown[]).map(String).filter((x) => isUuid(x) && x !== p.id) : [];
    return needsGroupAction(db, { op: "attach", key, asset_id: assetId, item_ids: [p.id, ...also] });
  }
  if (op === "unlink") return needsGroupAction(db, { op: "unlink", key, item_ids: [p.id] });
  if (op === "add") {
    const errors: Errors = {};
    const label = txt(input, "label");
    if (!label || label.length > 120) errors.label = "Enter a label (up to 120 characters).";
    const kind = txt(input, "kind") || "other";
    if (!["graphic", "photo", "video", "other"].includes(kind)) errors.kind = "Choose a kind.";
    const note = textField(input, "note", 200, "Note", errors);
    check(errors);
    if (p.asset_needs.length >= 20) throw new GrowthError("At most 20 needs per item.", 400);
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "need";
    let k = `custom:${slug}`;
    for (let i = 2; p.asset_needs.some((n) => n.key === k); i++) k = `custom:${slug}_${i}`;
    await writeNeeds(db, p.id, [...p.asset_needs, { key: k, label, kind: kind as AssetNeed["kind"], status: "needed", asset_id: null, note }]);
  } else if (op === "remove") {
    if (!p.asset_needs.some((n) => n.key === key)) throw new GrowthError("Unknown need.", 404);
    await writeNeeds(db, p.id, p.asset_needs.filter((n) => n.key !== key));
  } else if (op === "attach_asset") {
    await attach(db, p.id, await assetExists(db, input.asset_id));
  } else if (op === "detach_asset") {
    const aid = idOrThrow(input.asset_id, "asset");
    if (p.asset_needs.some((n) => n.asset_id === aid && n.status === "ready")) throw new GrowthError("A need uses this asset. Unlink it from the need instead.", 409);
    await db.from("premade_post_assets").delete().eq("premade_post_id", p.id).eq("asset_id", aid);
  } else throw new GrowthError("Unknown action.", 400);
  const n = await recheckReady(db, p.id);
  if (n) notices.push(n);
  return { notices };
}

/** The Needs panel: attach or unlink one need key on the chosen items. */
export async function needsGroupAction(db: Db, input: Record<string, unknown>) {
  const op = txt(input, "op");
  const key = txt(input, "key");
  if (!key) throw new GrowthError("Choose a need.", 400);
  const ids = Array.isArray(input.item_ids) ? [...new Set((input.item_ids as unknown[]).map(String))] : [];
  if (!ids.length || ids.length > 200 || ids.some((x) => !isUuid(x))) throw new GrowthError("Choose the items.", 400);
  const assetId = op === "attach" ? await assetExists(db, input.asset_id) : null;
  if (op !== "attach" && op !== "unlink") throw new GrowthError("Unknown action.", 400);
  const { data } = await db.from("premade_posts").select("id, status, asset_needs").in("id", ids);
  const rows = (data ?? []) as NeedRow[];
  const notices: string[] = [];
  let changed = 0;
  for (const r of rows) {
    const needs = (r.asset_needs ?? []) as AssetNeed[];
    const need = needs.find((n) => n.key === key);
    if (!need) continue;
    if (op === "attach") {
      await writeNeeds(db, r.id, needs.map((n) => (n.key === key ? { ...n, status: "ready" as const, asset_id: assetId } : n)));
      await attach(db, r.id, assetId!);
    } else {
      const old = need.asset_id;
      const next = needs.map((n) => (n.key === key ? { ...n, status: "needed" as const, asset_id: null } : n));
      await writeNeeds(db, r.id, next);
      if (old && !next.some((n) => n.asset_id === old)) await db.from("premade_post_assets").delete().eq("premade_post_id", r.id).eq("asset_id", old);
      const n = await recheckReady(db, r.id);
      if (n) notices.push(n);
    }
    changed += 1;
  }
  return { changed, notices };
}

// --- Asset bulk actions and ingredient tags -------------------------------------------------------------
/** Bulk on selected assets: set_category (with tags), set_status, archive. Returns the ones that failed validation. */
export async function assetBulk(db: Db, input: Record<string, unknown>) {
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map(String))] : [];
  if (!ids.length || ids.length > 500 || ids.some((x) => !isUuid(x))) throw new GrowthError("Select the assets first.", 400);
  const { data } = await db.from("marketing_assets").select("id, title, category, context_label, is_full_lineup").in("id", ids);
  const assets = (data ?? []) as Array<{ id: string; title: string; category: string | null; context_label: string | null; is_full_lineup: boolean | null }>;
  if (assets.length !== ids.length) throw new GrowthError("Unknown asset.", 404);
  const action = txt(input, "action");
  const failed: Array<{ id: string; title: string; error: string }> = [];
  if (action === "set_status" || action === "archive") {
    const status = action === "archive" ? "archived" : txt(input, "status");
    if (!["draft", "ready", "archived"].includes(status)) throw new GrowthError("Choose a status.", 400);
    for (const a of assets) await db.from("marketing_assets").update({ status }).eq("id", a.id);
    return { updated: assets.length, failed };
  }
  if (action !== "set_category") throw new GrowthError("Unknown action.", 400);
  const category = txt(input, "category");
  const replaceTags = Array.isArray(input.product_ids) || Array.isArray(input.ingredient_ids);
  const tags = await assetTagsFrom(db, input);
  const known = await categoryKeys(db);
  const [{ data: pl }, { data: il }] = await Promise.all([
    db.from("asset_product_links").select("asset_id, formulation_product_id").in("asset_id", ids),
    db.from("asset_ingredient_links").select("asset_id, ingredient_tag_id").in("asset_id", ids),
  ]);
  let updated = 0;
  for (const a of assets) {
    const productIds = replaceTags ? tags.productIds : ((pl ?? []) as Array<{ asset_id: string; formulation_product_id: string }>).filter((l) => l.asset_id === a.id).map((l) => l.formulation_product_id);
    const ingredientIds = replaceTags ? tags.ingredientIds : ((il ?? []) as Array<{ asset_id: string; ingredient_tag_id: string }>).filter((l) => l.asset_id === a.id).map((l) => l.ingredient_tag_id);
    const isFullLineup = input.is_full_lineup === undefined ? !!a.is_full_lineup : input.is_full_lineup === true;
    const contextLabel = input.context_label === undefined ? a.context_label : txt(input, "context_label") || null;
    const errs = validateAssetCategory({ category, productIds, ingredientIds, isFullLineup, contextLabel, known });
    if (Object.keys(errs).length) {
      failed.push({ id: a.id, title: a.title, error: Object.values(errs).join(" ") });
      continue;
    }
    const { error } = await db.from("marketing_assets").update({ category, is_full_lineup: isFullLineup, context_label: contextLabel }).eq("id", a.id);
    if (error) fail(error, "Could not update the assets.");
    if (replaceTags) await setAssetTags(db, a.id, productIds, ingredientIds);
    updated += 1;
  }
  return { updated, failed };
}

// --- Asset categories --------------------------------------------------------------------------
/**
 * Adds an asset category (anyone with the Marketing feature). Added
 * categories have no rules; they go before "Other" in the list.
 */
export async function createAssetCategory(db: Db, input: Record<string, unknown>, actor: string | null) {
  const label = txt(input, "label").replace(/\s+/g, " ");
  const { data: rows, error: lErr } = await db.from("asset_categories").select("key, label, sort_order");
  if (lErr) fail(lErr, "Could not load the asset categories.");
  const existing = (rows ?? []) as Array<{ key: string; label: string; sort_order: number }>;
  const err = categoryNameError(label, existing);
  if (err) throw new GrowthError(err, err.startsWith("A category") ? 409 : 400, { label: err });
  const before = existing.filter((c) => c.sort_order < 1000).map((c) => c.sort_order);
  const sort_order = Math.min(999, (before.length ? Math.max(...before) : 0) + 10);
  const key = `c_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const { data, error } = await db.from("asset_categories").insert({ key, label, sort_order, is_builtin: false, created_by_name: actor }).select("key, label, sort_order, is_builtin").single();
  if (error) {
    if (/asset_categories_label_unique|duplicate key/.test(error.message ?? "")) throw new GrowthError("A category with this name already exists.", 409, { label: "A category with this name already exists." });
    fail(error, "Could not add the category.");
  }
  return { category: data };
}

/** Deletes a category, but only while no asset uses it (archived ones count too). The database enforces this as well. */
export async function deleteAssetCategory(db: Db, key: unknown) {
  const k = typeof key === "string" ? key : "";
  if (!/^[a-z0-9_]{1,40}$/.test(k)) throw new GrowthError("Unknown category.", 404);
  const { data: cat } = await db.from("asset_categories").select("key, label").eq("key", k).maybeSingle();
  if (!cat) throw new GrowthError("This category was already deleted.", 404);
  const { data: used, error: uErr } = await db.from("marketing_assets").select("id, status").eq("category", k);
  if (uErr) fail(uErr, "Could not check the category.");
  const blocker = categoryDeleteBlocker(k, ((used ?? []) as Array<{ status: string }>).map((a) => ({ category: k, status: a.status })));
  if (blocker) throw new GrowthError(blocker, 409);
  const { error } = await db.from("asset_categories").delete().eq("key", k);
  if (error) {
    if (/marketing_assets_category_fk|foreign key/.test(error.message ?? "")) throw new GrowthError("Assets were just added to this category. Move them to another category first.", 409);
    fail(error, "Could not delete the category.");
  }
  return { deleted: cat.label as string };
}

export async function saveIngredientTag(db: Db, id: unknown | null, input: Record<string, unknown>, actor: string | null) {
  if (id && (input.archive === true || input.restore === true)) {
    const { error } = await db.from("asset_ingredient_tags").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", idOrThrow(id, "tag"));
    if (error) fail(error, "Could not update the tag (the name may be in use).");
    return { id: String(id) };
  }
  const name = txt(input, "name").replace(/\s+/g, " ");
  if (!name || name.length > 100) throw new GrowthError("Enter a tag name (up to 100 characters).", 400, { name: "Enter a name." });
  if (id) {
    const { error } = await db.from("asset_ingredient_tags").update({ name }).eq("id", idOrThrow(id, "tag"));
    if (error) fail(error, "Could not rename the tag.");
    return { id: String(id) };
  }
  const { data, error } = await db.from("asset_ingredient_tags").insert({ name, created_by_name: actor }).select("id").single();
  if (error) fail(error, "Could not add the tag.");
  return { id: data.id as string };
}

/** Admin only (the route checks): raw material names, never quantities, costs or suppliers. */
export async function rawMaterialNames(db: Db): Promise<string[]> {
  const { data, error } = await db.from("inventory_items").select("name");
  if (error) fail(error, "Could not load raw materials.");
  return [...new Set(((data ?? []) as Array<{ name: string | null }>).map((r) => (r.name ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Admin only: creates ingredient tags from chosen raw material names (copied, never linked). Existing names are skipped. */
export async function tagsFromRawMaterials(db: Db, input: Record<string, unknown>, actor: string | null) {
  const wanted = Array.isArray(input.names) ? [...new Set((input.names as unknown[]).map((n) => String(n).trim()).filter(Boolean))] : [];
  if (!wanted.length) throw new GrowthError("Choose at least one name.", 400);
  const allowed = new Set(await rawMaterialNames(db));
  const { data } = await db.from("asset_ingredient_tags").select("name, archived_at");
  const have = new Set(((data ?? []) as Array<{ name: string; archived_at: string | null }>).filter((t) => !t.archived_at).map((t) => t.name.toLowerCase()));
  let added = 0;
  for (const n of wanted) {
    if (!allowed.has(n) || have.has(n.toLowerCase())) continue;
    const { error } = await db.from("asset_ingredient_tags").insert({ name: n.slice(0, 100), created_by_name: actor });
    if (!error) {
      added += 1;
      have.add(n.toLowerCase());
    }
  }
  return { added };
}

// --- Calendar: schedule from the library, edit a schedule group, mark posted, remove ---------------------------
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
type PostRow = {
  id: string;
  title: string;
  business: string;
  platform: string;
  post_type: string;
  status: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  caption: string | null;
  premade_post_id: string | null;
  schedule_group_id: string | null;
  archived_at: string | null;
};
const POST_ROW_COLUMNS = "id, title, business, platform, post_type, status, scheduled_date, scheduled_time, caption, premade_post_id, schedule_group_id, archived_at";

function dateTimeFrom(input: Record<string, unknown>) {
  const date = txt(input, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new GrowthError("Choose a date.", 400, { date: "Choose a date." });
  const time = txt(input, "time");
  if (time && !HHMM_RE.test(time)) throw new GrowthError("Enter a time like 09:30.", 400, { time: "Enter a time like 09:30." });
  return { date, time: time || null };
}
function platformsFrom(input: Record<string, unknown>): string[] {
  const list = Array.isArray(input.platforms) ? [...new Set((input.platforms as unknown[]).map(String))] : [];
  if (!list.length) throw new GrowthError("Choose at least one platform.", 400, { platforms: "Choose at least one platform." });
  if (list.some((x) => !(CALENDAR_PLATFORMS as readonly string[]).includes(x))) throw new GrowthError("Choose platforms from the list.", 400, { platforms: "Choose platforms from the list." });
  return list;
}

/**
 * Schedules a library post: one calendar entry per platform, same date and
 * time, a shared schedule_group_id, status Scheduled. Entries copy no
 * content. A post that isn't Ready needs { schedule_anyway: true }.
 */
export async function scheduleFromLibrary(db: Db, id: unknown, input: Record<string, unknown>) {
  const p = await getPremade(db, id);
  if (p.archived_at) throw new GrowthError("This post is archived.", 400);
  if (p.status === "paused") throw new GrowthError("Paused: reactivate it first.", 400);
  const { date, time } = dateTimeFrom(input);
  const platforms = platformsFrom(input);
  const gate = await gateFor(db, p);
  const notReady = p.status !== "ready" || gate.blockers.length > 0;
  if (notReady && input.schedule_anyway !== true) {
    const why = gate.blockers.length ? gate.blockers.map((b) => b.message).join(" ") : "The post isn't marked Ready.";
    throw new GrowthError(`Not ready yet. ${why} Tick "Schedule anyway" to schedule it.`, 400, { schedule_anyway: "Tick to schedule it anyway." });
  }
  const groupId = crypto.randomUUID();
  const r = calendarEntriesFromPremade({ premade: { ...p, name: await nameFor(db, p) }, date, time, platforms, groupId });
  if (!r.ok) throw new GrowthError(r.error, 400);
  const ids: string[] = [];
  for (const row of r.rows) {
    const { data, error } = await db.from("content_posts").insert({ ...row, created_by_name: null }).select("id").single();
    if (error) fail(error, "Could not add the calendar entry.");
    ids.push(data.id);
  }
  return { ids, group_id: groupId };
}

async function getPostRow(db: Db, id: unknown): Promise<PostRow> {
  const { data } = await db.from("content_posts").select(POST_ROW_COLUMNS).eq("id", idOrThrow(id, "calendar entry")).maybeSingle();
  if (!data) throw new GrowthError("Unknown calendar entry.", 404);
  return { ...data, scheduled_date: iso(data.scheduled_date) };
}

/** The entry's schedule group (live rows), or just the entry when it has none. */
async function groupRows(db: Db, post: PostRow): Promise<PostRow[]> {
  if (!post.schedule_group_id) return [post];
  const { data } = await db.from("content_posts").select(POST_ROW_COLUMNS).eq("schedule_group_id", post.schedule_group_id);
  return ((data ?? []) as PostRow[]).filter((r) => !r.archived_at);
}

/**
 * Edit schedule for a whole group: platforms can be added or removed
 * (removed ones are archived; Posted ones are locked) and the date and time
 * apply to every row not yet Posted. An entry without a library post keeps a
 * single platform: { date, time, platform }.
 */
export async function editSchedule(db: Db, postId: unknown, input: Record<string, unknown>) {
  const post = await getPostRow(db, postId);
  if (post.archived_at) throw new GrowthError("This entry was removed from the calendar.", 400);
  const { date, time } = dateTimeFrom(input);
  if (!post.premade_post_id) {
    if (post.status === "posted") throw new GrowthError("Posted entries can't be rescheduled.", 400);
    const platform = txt(input, "platform") || post.platform;
    if (!(CALENDAR_PLATFORMS as readonly string[]).includes(platform)) throw new GrowthError("Choose a platform from the list.", 400);
    const { error } = await db.from("content_posts").update({ scheduled_date: date, scheduled_time: time, platform }).eq("id", post.id);
    if (error) fail(error, "Could not save the schedule.");
    return { added: 0, archived: 0, updated: 1 };
  }
  const platforms = platformsFrom(input);
  const rows = await groupRows(db, post);
  const groupId = post.schedule_group_id ?? crypto.randomUUID();
  if (!post.schedule_group_id) await db.from("content_posts").update({ schedule_group_id: groupId }).eq("id", post.id);
  const diff = scheduleGroupDiff(rows, platforms);
  const now = new Date().toISOString();
  for (const r of diff.archive) await db.from("content_posts").update({ archived_at: now }).eq("id", r.id);
  for (const r of diff.keep) {
    const { error } = await db.from("content_posts").update({ scheduled_date: date, scheduled_time: time }).eq("id", r.id);
    if (error) fail(error, "Could not save the schedule.");
  }
  const template = rows[0];
  const p = await getPremade(db, post.premade_post_id);
  const name = await nameFor(db, p);
  for (const platform of diff.add) {
    const { error } = await db.from("content_posts").insert({
      title: name.slice(0, 200),
      business: template.business,
      platform,
      post_type: template.post_type,
      status: "scheduled",
      scheduled_date: date,
      scheduled_time: time,
      premade_post_id: post.premade_post_id,
      schedule_group_id: groupId,
      risky_words_checked: false,
    });
    if (error) fail(error, "Could not add the platform.");
  }
  return { added: diff.add.length, archived: diff.archive.length, updated: diff.keep.length };
}

/**
 * Mark posted (one entry): sets the posted date (New York) and the optional
 * posted link, and freezes the FINAL caption (with hashtags) and the name
 * into the entry, in one update. From then on the entry shows its frozen
 * values and never changes when the library post does.
 */
export async function markPosted(db: Db, postId: unknown, input: Record<string, unknown>) {
  const post = await getPostRow(db, postId);
  if (post.archived_at) throw new GrowthError("This entry was removed from the calendar.", 400);
  if (post.status === "posted") throw new GrowthError("This entry is already marked posted.", 400);
  const url = txt(input, "posted_url");
  if (url && !(/^https?:\/\/\S+$/i.test(url) && url.length <= 2000)) throw new GrowthError("Enter a full link starting with http:// or https://.", 400, { posted_url: "Enter a full link." });
  const patch: Record<string, unknown> = { status: "posted", posted_at: todayNy(), posted_url: url || null };
  if (post.premade_post_id) {
    const p = await getPremade(db, post.premade_post_id);
    patch.caption = (await finalCaptionFor(db, p)) || null;
    patch.hashtags = null;
    patch.title = (await nameFor(db, p)).slice(0, 200);
  } else if (!(post.caption ?? "").trim()) {
    throw new GrowthError("This entry has no caption, so it can't be marked posted.", 400);
  }
  const { error } = await db.from("content_posts").update(patch).eq("id", post.id);
  if (error) fail(error, "Could not mark the entry posted.");
  return { ok: true };
}

/** Remove from calendar: archives every entry of the group that isn't Posted (entries are never deleted). */
export async function removeFromCalendar(db: Db, postId: unknown) {
  const post = await getPostRow(db, postId);
  const rows = (await groupRows(db, post)).filter((r) => r.status !== "posted");
  const now = new Date().toISOString();
  const targets = rows.length ? rows : [post];
  for (const r of targets) {
    const { error } = await db.from("content_posts").update({ archived_at: now }).eq("id", r.id);
    if (error) fail(error, "Could not remove the entry.");
  }
  return { removed: targets.length };
}

// --- Best Times: windows, rhythm; Settings: avoid list ------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Edit a posting window (text, ranges, quality). The row becomes "own data" with the editor's name. */
export async function updateWindow(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null) {
  const wid = idOrThrow(id, "window");
  const errors: Errors = {};
  const window_text = textField(input, "window_text", 100, "Window", errors);
  const quality = txt(input, "quality");
  if (!["peak", "good", "weak", "avoid", "none"].includes(quality)) errors.quality = "Choose a quality.";
  const raw = Array.isArray(input.ranges) ? (input.ranges as Array<Record<string, unknown>>) : [];
  if (raw.length > 6) errors.ranges = "At most 6 ranges.";
  const ranges = raw.map((r) => ({ start: String(r?.start ?? "").trim(), end: String(r?.end ?? "").trim(), note: String(r?.note ?? "").trim().slice(0, 60) || null }));
  if (ranges.some((r) => !HHMM.test(r.start) || !HHMM.test(r.end) || r.start > r.end)) errors.ranges = "Use 24-hour times like 14:00 to 18:00, with the start before the end.";
  check(errors);
  const { data, error } = await db
    .from("posting_time_windows")
    .update({ window_text, quality, ranges: ranges.map((r) => (r.note ? r : { start: r.start, end: r.end })), source: "own_data", updated_by_name: actor })
    .eq("id", wid)
    .select("id")
    .maybeSingle();
  if (error) fail(error, "Could not save the window.");
  if (!data) throw new GrowthError("Unknown window.", 404);
}

/** Add (id null), edit, archive or restore a rhythm row. */
export async function saveRhythm(db: Db, id: unknown | null, input: Record<string, unknown>) {
  if (id && (input.archive === true || input.restore === true)) {
    const { error } = await db.from("posting_rhythm").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", idOrThrow(id, "rhythm row"));
    if (error) fail(error, "Could not update the rhythm.");
    return;
  }
  const errors: Errors = {};
  const days = Array.isArray(input.days) ? [...new Set((input.days as unknown[]).map(Number))].sort() : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.days = "Choose at least one day.";
  const label = txt(input, "label");
  if (!label || label.length > 200) errors.label = "Enter a label (up to 200 characters).";
  const pillar_ids = Array.isArray(input.pillar_ids) ? [...new Set((input.pillar_ids as unknown[]).map(String))] : [];
  if (pillar_ids.some((x) => !isUuid(x))) errors.pillar_ids = "Choose pillars from the list.";
  const note = textField(input, "note", 300, "Note", errors);
  check(errors);
  if (pillar_ids.length) {
    const { data } = await db.from("content_pillars").select("id").in("id", pillar_ids);
    if ((data ?? []).length !== pillar_ids.length) throw new GrowthError("Choose pillars from the list.", 400, { pillar_ids: "Choose pillars from the list." });
  }
  const row = { days, label, pillar_ids, note, active: input.active !== false };
  const r = id ? await db.from("posting_rhythm").update(row).eq("id", idOrThrow(id, "rhythm row")) : await db.from("posting_rhythm").insert(row);
  if (r.error) fail(r.error, "Could not save the rhythm.");
}

/** Admin only (the route checks; the database checks too). Never changes any post text. */
export async function saveAvoidPhrase(db: Db, id: unknown | null, input: Record<string, unknown>) {
  if (id && (input.archive === true || input.restore === true)) {
    const { error } = await db.from("avoid_phrases").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", idOrThrow(id, "phrase"));
    if (error) fail(error, "Could not update the phrase.");
    return;
  }
  const errors: Errors = {};
  const phrase = txt(input, "phrase").replace(/\s+/g, " ");
  if (!phrase) errors.phrase = "Enter a phrase.";
  else if (phrase.length > 80) errors.phrase = "Keep it under 80 characters.";
  const note = textField(input, "note", 200, "Note", errors);
  check(errors);
  const r = id ? await db.from("avoid_phrases").update({ phrase, note }).eq("id", idOrThrow(id, "phrase")) : await db.from("avoid_phrases").insert({ phrase, note, source: "manual" });
  if (r.error) fail(r.error, "Could not save the phrase.");
}
