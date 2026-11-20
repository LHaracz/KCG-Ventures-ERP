/**
 * Ad Library server code (service role, after the route's growth.marketing
 * check): pillars, series, library items (reels and picture posts) with
 * their flags, claims, assets and needs, closing lines, and the data the
 * Ad Library, Pillars, Calendar and Best Times tabs show.
 *
 * Display names ("{letter} - {title}") are computed, never stored.
 */
import { GrowthError, idOrThrow, isUuid } from "./errors";
import {
  FLAG_KEYS,
  LIBRARY_PLATFORMS,
  PREMADE_INTENTS,
  PREMADE_STATUSES,
  displayName,
  hashPremadeText,
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
import { calendarEntriesFromPremade } from "./scheduling";
import type { Db } from "./routeHelpers";

export type Pillar = { id: string; code: string; name: string; description: string | null; recurring: boolean; sort_order: number; archived_at: string | null };
export type Series = { id: string; pillar_id: string; name: string; cover_text: string | null; default_hashtags: string | null; notes: string | null; sort_order: number; archived_at: string | null };
export type Flag = { id: string; premade_post_id: string; flag_key: FlagKey; detail: Record<string, unknown>; dismissed_by_name: string | null; dismissed_at: string | null; created_at: string };
export type Premade = {
  id: string;
  title: string;
  category: "reel" | "picture_post";
  picture_format: "carousel" | "single_image" | "story" | "unknown" | null;
  business: "botaniqals" | "minileaf" | "brand";
  pillar_id: string;
  series_id: string | null;
  series_position: number | null;
  status: "idea" | "drafting" | "ready" | "paused";
  intent: "organic" | "paid" | "both";
  is_recurring: boolean;
  platforms: string[];
  products_mentioned: string[];
  hook: string | null;
  caption: string | null;
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
  display_name: string;
  flags: Flag[];
  claim_ids: string[];
  asset_ids: string[];
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

const PREMADE_COLUMNS =
  "id, title, category, picture_format, business, pillar_id, series_id, series_position, status, intent, is_recurring, platforms, products_mentioned, hook, caption, hashtags, cta_text, style_tag, duration_text, duration_min_seconds, duration_max_seconds, script_beats, visual_direction, why_it_converts, visual_notes, best_window_text, best_window_why, asset_needs, needs_customer_permission, permission_confirmed_by_name, permission_confirmed_at, risky_ack_hash, risky_ack_by_name, risky_ack_at, notes, sort_order, created_by_name, archived_at, created_at, updated_at";
const PILLAR_COLUMNS = "id, code, name, description, recurring, sort_order, archived_at";

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
  if (/premade_posts_title_unique/.test(m)) throw new GrowthError("A library item with this title already exists in this pillar.", 409, { title: "Already used in this pillar." });
  if (/content_pillars_code_unique/.test(m)) throw new GrowthError("Another pillar already uses that letter.", 409, { code: "Letter already used." });
  if (/content_pillars_name_unique/.test(m)) throw new GrowthError("Another pillar already has that name.", 409, { name: "Name already used." });
  if (/content_series_name_unique/.test(m)) throw new GrowthError("A series with that name already exists.", 409, { name: "Name already used." });
  if (/closing_lines_text_unique/.test(m)) throw new GrowthError("That closing line is already on the list.", 409, { text: "Already on the list." });
  if (/avoid_phrases_phrase_unique/.test(m)) throw new GrowthError("That phrase is already on the list (it may be archived).", 409, { phrase: "Already on the list." });
  if (/asset_ingredient_tags_name_unique/.test(m)) throw new GrowthError("A tag with that name already exists.", 409, { name: "Already exists." });
  if (error?.code === "23514" || /check constraint/i.test(m)) throw new GrowthError(`${message} A value is not valid.`, 400);
  throw new GrowthError(message, 500);
}

// --- Loading ---------------------------------------------------------------------------------------
export async function loadLibraryData(db: Db) {
  const [pl, se, pp, fl, pc, pa, cl, ap, tw, dn, rh, rn, tags, apl, ail, posts] = await Promise.all([
    db.from("content_pillars").select(PILLAR_COLUMNS),
    db.from("content_series").select("id, pillar_id, name, cover_text, default_hashtags, notes, sort_order, archived_at"),
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
  ]);
  for (const r of [pl, se, pp, fl, pc, pa, cl, ap, tw, dn, rh, rn, tags, apl, ail, posts]) if (r.error) fail(r.error, "Could not load the Ad Library.");
  const pillars = ((pl.data ?? []) as Pillar[]).sort((a, b) => a.code.localeCompare(b.code) || (a.archived_at ? 1 : -1));
  const code = new Map(pillars.map((p) => [p.id, p.code]));
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
  const premades: PremadeRow[] = ((pp.data ?? []) as Premade[]).map((p) => ({
    ...p,
    script_beats: Array.isArray(p.script_beats) ? p.script_beats : [],
    asset_needs: Array.isArray(p.asset_needs) ? p.asset_needs : [],
    display_name: displayName(code.get(p.pillar_id) ?? "?", p.title),
    flags: by(fl.data as Flag[], p.id),
    claim_ids: by(pc.data as Array<{ premade_post_id: string; claim_id: string }>, p.id).map((r) => r.claim_id),
    asset_ids: by(pa.data as Array<{ premade_post_id: string; asset_id: string }>, p.id).map((r) => r.asset_id),
    next_scheduled: usage.get(p.id)?.next ?? null,
    last_posted: usage.get(p.id)?.last ?? null,
  }));
  return {
    pillars,
    series: ((se.data ?? []) as Series[]).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    premades,
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
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && v ? v.slice(0, 10) : null);

async function activeWords(db: Db) {
  const [rw, ap] = await Promise.all([db.from("risky_words").select("phrase, archived_at"), db.from("avoid_phrases").select("phrase, archived_at")]);
  const live = (r: { data: Array<{ phrase: string; archived_at: string | null }> | null }) => (r.data ?? []).filter((w) => !w.archived_at).map((w) => w.phrase);
  return { risky: live(rw), avoid: live(ap) };
}

// --- Pillars ---------------------------------------------------------------------------------------
async function getPillar(db: Db, id: unknown): Promise<Pillar> {
  const { data } = await db.from("content_pillars").select(PILLAR_COLUMNS).eq("id", idOrThrow(id, "pillar")).maybeSingle();
  if (!data) throw new GrowthError("Unknown pillar.", 404);
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
  if (error) fail(error, "Could not save the pillar.");
  return data as Pillar;
}

/** Edit a pillar, or { archive }, { restore }, or { move_items_to } (bulk reassign of its live items). */
export async function updatePillar(db: Db, id: unknown, input: Record<string, unknown>) {
  const p = await getPillar(db, id);
  if (input.move_items_to !== undefined) {
    const to = await getPillar(db, input.move_items_to);
    if (to.archived_at) throw new GrowthError("Choose an active pillar.", 400);
    const { data: items } = await db.from("premade_posts").select("id, title, archived_at").eq("pillar_id", p.id);
    const live = ((items ?? []) as Array<{ id: string; title: string; archived_at: string | null }>).filter((i) => !i.archived_at);
    await assertNoCollisions(db, live, to.id);
    for (const i of live) {
      const { error } = await db.from("premade_posts").update({ pillar_id: to.id }).eq("id", i.id);
      if (error) fail(error, "Could not move the items.");
    }
    return { moved: live.length };
  }
  if (input.archive === true) {
    const { data: items } = await db.from("premade_posts").select("id, archived_at").eq("pillar_id", p.id);
    const live = ((items ?? []) as Array<{ archived_at: string | null }>).filter((i) => !i.archived_at).length;
    if (live) throw new GrowthError(`${live} library item${live === 1 ? " uses" : "s use"} this pillar. Move them to another pillar first.`, 409);
    const { error } = await db.from("content_pillars").update({ archived_at: new Date().toISOString() }).eq("id", p.id);
    if (error) fail(error, "Could not archive the pillar.");
    return { ok: true };
  }
  if (input.restore === true) {
    const { error } = await db.from("content_pillars").update({ archived_at: null }).eq("id", p.id);
    if (error) fail(error, "Could not restore the pillar (its letter or name may be in use).");
    return { ok: true };
  }
  const v = pillarFields(input);
  const { data, error } = await db.from("content_pillars").update(v).eq("id", p.id).select(PILLAR_COLUMNS).single();
  if (error) fail(error, "Could not save the pillar.");
  return data as Pillar;
}

async function assertNoCollisions(db: Db, items: Array<{ id: string; title: string }>, pillarId: string) {
  const { data } = await db.from("premade_posts").select("id, title, archived_at").eq("pillar_id", pillarId);
  const taken = new Set(((data ?? []) as Array<{ id: string; title: string; archived_at: string | null }>).filter((r) => !r.archived_at).map((r) => r.title.trim().toLowerCase()));
  const clash = items.filter((i) => taken.has(i.title.trim().toLowerCase()));
  const seen = new Set<string>();
  for (const i of items) {
    const k = i.title.trim().toLowerCase();
    if (seen.has(k)) clash.push(i);
    seen.add(k);
  }
  if (clash.length) throw new GrowthError(`These titles already exist in that pillar: ${clash.map((c) => `"${c.title}"`).join(", ")}. Rename them first.`, 409);
}

/** Preview (apply: false) or apply the alphabetical re-lettering in one transaction. */
export async function reletterPillars(db: Db, apply: boolean) {
  const [{ data: pillars }, { data: items }] = await Promise.all([db.from("content_pillars").select(PILLAR_COLUMNS), db.from("premade_posts").select("id, pillar_id, title, archived_at")]);
  let plan;
  try {
    plan = reletterAlphabetically((pillars ?? []) as Pillar[], items ?? []);
  } catch (e) {
    throw new GrowthError((e as Error).message, 400);
  }
  if (apply && plan.changes.length) {
    const { error } = await db.rpc("reletter_pillars", { p_codes: plan.codes });
    if (error) fail(error, "Could not re-letter the pillars.");
  }
  return plan;
}

// --- Series ------------------------------------------------------------------------------------------
export async function saveSeries(db: Db, id: unknown | null, input: Record<string, unknown>) {
  if (id && (input.archive === true || input.restore === true)) {
    const { error } = await db.from("content_series").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", idOrThrow(id, "series"));
    if (error) fail(error, "Could not update the series.");
    return;
  }
  const errors: Errors = {};
  const name = txt(input, "name");
  if (!name) errors.name = "Enter a name.";
  else if (name.length > 200) errors.name = "Keep the name under 200 characters.";
  const row = {
    name,
    pillar_id: (await getPillar(db, input.pillar_id)).id,
    cover_text: textField(input, "cover_text", 300, "Cover text", errors),
    default_hashtags: textField(input, "default_hashtags", 1500, "Default hashtags", errors),
    notes: textField(input, "notes", 1000, "Notes", errors),
  };
  check(errors);
  const r = id ? await db.from("content_series").update(row).eq("id", idOrThrow(id, "series")) : await db.from("content_series").insert(row);
  if (r.error) fail(r.error, "Could not save the series.");
}

// --- Library items -------------------------------------------------------------------------------------
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

/** Validated item fields from the editor (title, pillar, text, settings). Category is fixed after creation. */
async function premadeFields(db: Db, raw: Record<string, unknown>, category: "reel" | "picture_post") {
  const errors: Errors = {};
  const title = txt(raw, "title");
  if (!title) errors.title = "Enter a title.";
  else if (title.length > 150) errors.title = "Keep the title under 150 characters.";
  const pillarId = raw.pillar_id;
  if (!isUuid(pillarId)) errors.pillar_id = "Choose a pillar.";
  const business = txt(raw, "business") || "botaniqals";
  if (!["botaniqals", "minileaf", "brand"].includes(business)) errors.business = "Choose a business.";
  const status = txt(raw, "status") || "drafting";
  if (!(PREMADE_STATUSES as string[]).includes(status)) errors.status = "Choose a status.";
  const intent = txt(raw, "intent") || "organic";
  if (!(PREMADE_INTENTS as string[]).includes(intent)) errors.intent = "Choose an intent.";
  const platforms = Array.isArray(raw.platforms) ? [...new Set((raw.platforms as unknown[]).map(String))] : [];
  if (platforms.some((p) => !(LIBRARY_PLATFORMS as readonly string[]).includes(p))) errors.platforms = "Choose platforms from the list.";
  const products = Array.isArray(raw.products_mentioned) ? [...new Set((raw.products_mentioned as unknown[]).map((p) => String(p).trim()).filter(Boolean))] : [];
  if (products.length > 20 || products.some((p) => p.length > 60)) errors.products_mentioned = "Too many products.";
  const picture_format = category === "picture_post" ? txt(raw, "picture_format") || "unknown" : null;
  if (picture_format && !["carousel", "single_image", "story", "unknown"].includes(picture_format)) errors.picture_format = "Choose a format.";
  const series_position = raw.series_position === "" || raw.series_position === null || raw.series_position === undefined ? null : Number(raw.series_position);
  if (series_position !== null && (!Number.isInteger(series_position) || series_position < 1 || series_position > 1000)) errors.series_position = "Enter a whole number.";
  const duration_text = textField(raw, "duration_text", 30, "Duration", errors);
  const parsed = parseDuration(duration_text);
  const v = {
    title,
    pillar_id: String(pillarId ?? ""),
    series_id: raw.series_id && isUuid(raw.series_id) ? String(raw.series_id) : null,
    series_position,
    business,
    status,
    intent,
    is_recurring: raw.is_recurring === true,
    platforms,
    products_mentioned: products,
    picture_format,
    hook: textField(raw, "hook", 300, "Hook", errors),
    caption: textField(raw, "caption", 4000, "Caption", errors),
    hashtags: textField(raw, "hashtags", 1500, "Hashtags", errors),
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
  const pillar = await getPillar(db, v.pillar_id);
  if (pillar.archived_at) throw new GrowthError("That pillar is archived. Choose an active pillar.", 400, { pillar_id: "Choose an active pillar." });
  if (v.series_id) {
    const { data } = await db.from("content_series").select("id").eq("id", v.series_id).maybeSingle();
    if (!data) throw new GrowthError("Choose a series from the list.", 400, { series_id: "Choose a series from the list." });
  }
  return { v, pillar };
}

async function setLinks(db: Db, table: "premade_post_claims" | "premade_post_assets", key: "claim_id" | "asset_id", premadeId: string, ids: unknown) {
  if (ids === undefined) return;
  const list = Array.isArray(ids) ? [...new Set((ids as unknown[]).map(String))] : [];
  if (list.some((x) => !isUuid(x))) throw new GrowthError("Unknown claim or asset.", 400);
  if (list.length) {
    const { data } = await db.from(key === "claim_id" ? "claims" : "marketing_assets").select("id").in("id", list);
    if ((data ?? []).length !== list.length) throw new GrowthError("Unknown claim or asset.", 404);
  }
  const { data: cur } = await db.from(table).select(`premade_post_id, ${key}`).eq("premade_post_id", premadeId);
  const have = new Set(((cur ?? []) as Array<Record<string, string>>).map((r) => r[key]));
  for (const x of have) if (!list.includes(x)) await db.from(table).delete().eq("premade_post_id", premadeId).eq(key, x);
  for (const x of list) if (!have.has(x)) await db.from(table).insert({ premade_post_id: premadeId, [key]: x });
}

/** The server-side Ready gate for an item as it is in the database now. */
export async function gateFor(db: Db, p: Premade): Promise<{ blockers: ReadyBlocker[]; hash: string; hits: ReturnType<typeof scanBoth> }> {
  const { data: links } = await db.from("premade_post_claims").select("claim_id").eq("premade_post_id", p.id);
  const ids = ((links ?? []) as Array<{ claim_id: string }>).map((l) => l.claim_id);
  const { data: claims } = ids.length ? await db.from("claims").select("id, claim_text, status").in("id", ids) : { data: [] };
  const words = await activeWords(db);
  const hits = scanBoth(premadeScanText(p), words.risky, words.avoid);
  const hash = hashPremadeText(p);
  return { blockers: premadeReadyCheck({ premade: p, selectedClaims: claims ?? [], hits, currentTextHash: hash }), hash, hits };
}

export async function createPremade(db: Db, input: Record<string, unknown>, actor: string | null) {
  const category = txt(input, "category");
  if (category !== "reel" && category !== "picture_post") throw new GrowthError("Choose Reel or Picture post.", 400, { category: "Choose a category." });
  const { v } = await premadeFields(db, input, category);
  if (v.status === "ready") v.status = "drafting"; // Ready is set from the editor after the gate passes.
  const errors: Errors = {};
  const asset_needs = needsFrom(input.asset_needs, errors);
  check(errors);
  const { data, error } = await db.from("premade_posts").insert({ ...v, category, asset_needs, created_by_name: actor }).select("id").single();
  if (error) fail(error, "Could not save the library item.");
  await setLinks(db, "premade_post_claims", "claim_id", data.id, input.claim_ids);
  await setLinks(db, "premade_post_assets", "asset_id", data.id, input.asset_ids);
  return { id: data.id as string, notice: null as string | null };
}

/**
 * Saves the editor. Setting Ready runs the gate (400 with the blockers).
 * Saving a Ready item whose gate no longer passes moves it back to Drafting
 * and says why. Editing the title dismisses an open auto-name flag.
 */
export async function updatePremade(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null) {
  const cur = await getPremade(db, id);
  const { v } = await premadeFields(db, input, cur.category);
  const errors: Errors = {};
  const asset_needs = input.asset_needs === undefined ? cur.asset_needs : needsFrom(input.asset_needs, errors);
  check(errors);
  const wantReady = v.status === "ready";
  const { error } = await db.from("premade_posts").update({ ...v, asset_needs, status: wantReady && cur.status !== "ready" ? cur.status : v.status }).eq("id", cur.id);
  if (error) fail(error, "Could not save the library item.");
  await setLinks(db, "premade_post_claims", "claim_id", cur.id, input.claim_ids);
  await setLinks(db, "premade_post_assets", "asset_id", cur.id, input.asset_ids);
  if (v.title !== cur.title) await dismissFlag(db, cur.id, "auto_name", actor, null, true);
  const saved = await getPremade(db, cur.id);
  let notice: string | null = null;
  if (wantReady) {
    const gate = await gateFor(db, saved);
    if (gate.blockers.length) {
      if (cur.status === "ready") {
        await db.from("premade_posts").update({ status: "drafting" }).eq("id", cur.id);
        notice = `Moved back to Drafting: ${gate.blockers.map((b) => b.message).join(" ")}`;
      } else {
        throw new GrowthError(`Not ready yet. ${gate.blockers.map((b) => b.message).join(" ")}`, 400, { status: "Not ready yet." });
      }
    } else if (cur.status !== "ready") {
      await db.from("premade_posts").update({ status: "ready" }).eq("id", cur.id);
    }
  }
  return { id: cur.id, notice };
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

/** Item actions: duplicate, pause, reactivate, archive, restore, confirm_permission, clear_permission, ack_words, dismiss_flag. */
export async function premadeAction(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null) {
  const p = await getPremade(db, id);
  const action = txt(input, "action");
  const now = new Date().toISOString();
  const set = async (patch: Record<string, unknown>) => {
    const { error } = await db.from("premade_posts").update(patch).eq("id", p.id);
    if (error) fail(error, "Could not update the library item.");
  };
  switch (action) {
    case "duplicate": {
      const { id: _i, created_at: _c, updated_at: _u, archived_at: _a, created_by_name: _b, ...rest } = p;
      void _i; void _c; void _u; void _a; void _b;
      let title = `${p.title} (copy)`.slice(0, 150);
      const { data: taken } = await db.from("premade_posts").select("title, archived_at").eq("pillar_id", p.pillar_id);
      const names = new Set(((taken ?? []) as Array<{ title: string; archived_at: string | null }>).filter((t) => !t.archived_at).map((t) => t.title.toLowerCase()));
      for (let n = 2; names.has(title.toLowerCase()) && n < 100; n++) title = `${p.title} (copy ${n})`.slice(0, 150);
      const { data, error } = await db
        .from("premade_posts")
        .insert({
          ...rest,
          title,
          status: "drafting",
          permission_confirmed_by_name: null,
          permission_confirmed_at: null,
          risky_ack_hash: null,
          risky_ack_by_name: null,
          risky_ack_at: null,
          source_ref: null,
          created_by_name: actor,
        })
        .select("id")
        .single();
      if (error) fail(error, "Could not duplicate the item.");
      const { data: claims } = await db.from("premade_post_claims").select("claim_id").eq("premade_post_id", p.id);
      for (const c of (claims ?? []) as Array<{ claim_id: string }>) await db.from("premade_post_claims").insert({ premade_post_id: data.id, claim_id: c.claim_id });
      const { data: assets } = await db.from("premade_post_assets").select("asset_id").eq("premade_post_id", p.id);
      for (const a of (assets ?? []) as Array<{ asset_id: string }>) await db.from("premade_post_assets").insert({ premade_post_id: data.id, asset_id: a.asset_id });
      return { id: data.id as string };
    }
    case "pause":
      await set({ status: "paused" });
      break;
    case "reactivate":
      if (p.status !== "paused") throw new GrowthError("This item is not paused.", 400);
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
      const hash = hashPremadeText(p);
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

/** Bulk: pause, reactivate, archive, set_pillar, set_series, dismiss_flag (with a note). */
export async function premadeBulk(db: Db, input: Record<string, unknown>, actor: string | null) {
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map(String))] : [];
  if (!ids.length || ids.length > 500 || ids.some((x) => !isUuid(x))) throw new GrowthError("Select the items first.", 400);
  const { data } = await db.from("premade_posts").select("id, title, status, pillar_id, archived_at").in("id", ids);
  const items = (data ?? []) as Array<{ id: string; title: string; status: string; pillar_id: string; archived_at: string | null }>;
  if (items.length !== ids.length) throw new GrowthError("Unknown library item.", 404);
  const action = txt(input, "action");
  const now = new Date().toISOString();
  const each = async (patch: (i: (typeof items)[number]) => Record<string, unknown> | null) => {
    for (const i of items) {
      const p = patch(i);
      if (!p) continue;
      const { error } = await db.from("premade_posts").update(p).eq("id", i.id);
      if (error) fail(error, "Could not update the items.");
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
    case "set_pillar": {
      const to = await getPillar(db, input.pillar_id);
      if (to.archived_at) throw new GrowthError("Choose an active pillar.", 400);
      await assertNoCollisions(db, items.filter((i) => i.pillar_id !== to.id && !i.archived_at), to.id);
      await each((i) => (i.pillar_id === to.id ? null : { pillar_id: to.id }));
      break;
    }
    case "set_series": {
      const sid = input.series_id ? idOrThrow(input.series_id, "series") : null;
      if (sid) {
        const { data: s } = await db.from("content_series").select("id").eq("id", sid).maybeSingle();
        if (!s) throw new GrowthError("Unknown series.", 404);
      }
      await each(() => ({ series_id: sid }));
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

// --- Calendar: add from the library, and update from the library -----------------------------------------
/**
 * Creates one calendar entry per platform from a library item, copying its
 * claims and attached assets. A non-recurring item already on the calendar
 * needs { confirm_duplicate: true }.
 */
export async function scheduleFromLibrary(db: Db, id: unknown, input: Record<string, unknown>) {
  const p = await getPremade(db, id);
  if (p.archived_at) throw new GrowthError("This item is archived.", 400);
  const pillar = await getPillar(db, p.pillar_id);
  const date = txt(input, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new GrowthError("Choose a date.", 400, { date: "Choose a date." });
  const time = txt(input, "time");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new GrowthError("Enter a time like 09:30.", 400, { time: "Enter a time like 09:30." });
  const platforms = Array.isArray(input.platforms) ? (input.platforms as unknown[]).map(String) : p.platforms;
  if (platforms.some((x) => !(LIBRARY_PLATFORMS as readonly string[]).includes(x))) throw new GrowthError("Choose platforms from the list.", 400);
  let owner: string | null = null;
  if (input.owner_account_id) {
    owner = idOrThrow(input.owner_account_id, "employee");
    const { data } = await db.from("employee_accounts").select("id, status").eq("id", owner).maybeSingle();
    if (!data || data.status !== "active") throw new GrowthError("Choose an active employee.", 400, { owner_account_id: "Choose an active employee." });
  }
  const { data: existing } = await db.from("content_posts").select("id, status, scheduled_date, archived_at").eq("premade_post_id", p.id);
  const live = ((existing ?? []) as Array<{ status: string; scheduled_date: unknown; archived_at: string | null }>).filter((e) => !e.archived_at);
  if (!p.is_recurring && live.length && input.confirm_duplicate !== true) {
    const dates = live.map((e) => iso(e.scheduled_date)).filter(Boolean).sort();
    throw new GrowthError(`Already on the calendar for ${dates[0] ?? "an earlier date"}. Confirm to add it again.`, 409, { confirm_duplicate: "Confirm to add it again." });
  }
  const series = p.series_id ? (await db.from("content_series").select("default_hashtags").eq("id", p.series_id).maybeSingle()).data : null;
  const gate = await gateFor(db, p);
  const r = calendarEntriesFromPremade({ premade: { ...p, pillar_code: pillar.code }, series, date, time, platforms, owner, gateResult: gate });
  if (!r.ok) throw new GrowthError(r.error, 400);
  const warnings = [...r.warnings];
  const rows = r.rows.map((row) => {
    if (row.status === "ready" && !(row.caption ?? "").trim()) {
      warnings.push("Write a caption on the calendar entry before it can be Ready.");
      return { ...row, status: "editing" as const, risky_words_checked: false };
    }
    return row;
  });
  const [{ data: claims }, { data: assets }] = await Promise.all([
    db.from("premade_post_claims").select("claim_id").eq("premade_post_id", p.id),
    db.from("premade_post_assets").select("asset_id").eq("premade_post_id", p.id),
  ]);
  const ids: string[] = [];
  for (const row of rows) {
    const { data, error } = await db.from("content_posts").insert({ ...row, created_by_name: null }).select("id").single();
    if (error) fail(error, "Could not add the calendar entry.");
    ids.push(data.id);
    for (const c of (claims ?? []) as Array<{ claim_id: string }>) await db.from("content_post_claims").insert({ post_id: data.id, claim_id: c.claim_id });
    for (const a of (assets ?? []) as Array<{ asset_id: string }>) await db.from("content_post_assets").insert({ post_id: data.id, asset_id: a.asset_id });
  }
  const openNeeds = p.asset_needs.filter((n) => n.status !== "ready").length;
  return { ids, warnings: [...new Set(warnings)], open_needs: openNeeds };
}

/** "Update from library": copies caption, hashtags, assets and claims onto a calendar entry that isn't Posted. */
export async function syncFromLibrary(db: Db, postId: unknown) {
  const pid = idOrThrow(postId, "post");
  const { data: post } = await db.from("content_posts").select("id, status, premade_post_id").eq("id", pid).maybeSingle();
  if (!post) throw new GrowthError("Unknown post.", 404);
  if (!post.premade_post_id) throw new GrowthError("This entry wasn't made from the library.", 400);
  if (post.status === "posted") throw new GrowthError("Posted entries can't be updated from the library.", 400);
  const p = await getPremade(db, post.premade_post_id);
  const series = p.series_id ? (await db.from("content_series").select("default_hashtags").eq("id", p.series_id).maybeSingle()).data : null;
  const caption = p.caption;
  const hashtags = (p.hashtags ?? "").trim() ? p.hashtags : series?.default_hashtags ?? null;
  const patch: Record<string, unknown> = { caption, hashtags, premade_synced_at: new Date().toISOString() };
  const notices: string[] = [];
  if (["ready", "scheduled"].includes(post.status) && !(caption ?? "").trim()) {
    patch.status = "editing";
    notices.push("The library item has no caption, so the entry went back to Editing.");
  }
  if (["ready", "scheduled"].includes(post.status)) {
    patch.risky_words_checked = false;
    if (!patch.status) {
      patch.status = "editing";
      notices.push("The text changed, so the entry went back to Editing. Check it and set it Ready again.");
    }
  }
  const { error } = await db.from("content_posts").update(patch).eq("id", pid);
  if (error) fail(error, "Could not update the entry.");
  for (const [from, to, key] of [["premade_post_claims", "content_post_claims", "claim_id"], ["premade_post_assets", "content_post_assets", "asset_id"]] as const) {
    const { data: want } = await db.from(from).select(key).eq("premade_post_id", p.id);
    const wanted = ((want ?? []) as Array<Record<string, string>>).map((r) => r[key]);
    const { data: have } = await db.from(to).select(`post_id, ${key}`).eq("post_id", pid);
    const current = ((have ?? []) as Array<Record<string, string>>).map((r) => r[key]);
    for (const x of current) if (!wanted.includes(x)) await db.from(to).delete().eq("post_id", pid).eq(key, x);
    for (const x of wanted) if (!current.includes(x)) await db.from(to).insert({ post_id: pid, [key]: x });
  }
  return { notices };
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
