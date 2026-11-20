/**
 * Marketing Hub server code (service role, after the route's feature
 * check). Product profiles, claims (Admins approve, reject and retire; the
 * route checks Admin and the database trigger does too), assets in the
 * private "marketing-assets" bucket (server-signed URLs only), the content
 * calendar with its guardrails, caption templates and the risky-word list.
 *
 * Nothing here reads formulas: label ingredients are typed by hand.
 */
import { assetExtension, assetNameError, safeDownloadName } from "./assetNames";
import { PREVIEW_MAX_BYTES, SNIFF_BYTES, UPLOAD_MIME, detectFileKind, isJpegBytes, sizeError, type FileKind } from "./fileKinds";
import { GrowthError, idOrThrow, isUuid } from "./errors";
import { isIsoDate } from "./dates";
import { claimsReadyCheck, isReadyStatus, scanText } from "./text";
import { validateAssetCategory } from "./assetCategories";
import { listAssignableEmployees } from "./employees";
import type { Db } from "./routeHelpers";

export const MARKETING_BUCKET = "marketing-assets";
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const ASSET_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" };
export const SIGNED_URL_SECONDS = 300;

export type Business = "botaniqals" | "minileaf" | "brand";
export type Claim = {
  id: string;
  claim_text: string;
  formulation_product_id: string | null;
  claim_type: string;
  status: "draft" | "in_review" | "approved" | "rejected" | "retired";
  evidence_note: string | null;
  evidence_url: string | null;
  review_note: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_again_on: string | null;
  created_by_name: string | null;
  updated_at: string;
};
export type ClaimEvent = { id: string; claim_id: string; event: string; actor_name: string | null; note: string | null; claim_text_snapshot: string | null; created_at: string };
export type Asset = {
  id: string;
  title: string;
  business: Business;
  formulation_product_id: string | null;
  asset_type: string;
  source: "upload" | "link";
  file_path: string | null;
  url: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  project_url: string | null;
  status: "draft" | "ready" | "archived";
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  category: "product" | "group_product" | "ingredient" | "market" | "retail" | "other" | null;
  context_label: string | null;
  shot_date: string | null;
  is_full_lineup: boolean | null;
  /** HEIC: the JPG made in the browser. */
  preview_path: string | null;
  /** GIF and MP4: a still frame (JPG). */
  poster_path: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
};
export type Profile = {
  id: string;
  formulation_product_id: string;
  tagline: string | null;
  short_description: string | null;
  long_description: string | null;
  label_ingredients: string | null;
  key_points: string | null;
  hashtags: string | null;
  do_not_say: string | null;
  primary_asset_id: string | null;
  updated_by_name: string | null;
  updated_at: string;
};
export type Post = {
  id: string;
  title: string;
  business: Business;
  formulation_product_id: string | null;
  platform: string;
  post_type: string;
  status: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  owner_account_id: string | null;
  caption: string | null;
  hashtags: string | null;
  project_url: string | null;
  posted_url: string | null;
  posted_at: string | null;
  notes: string | null;
  risky_words_checked: boolean;
  archived_at: string | null;
  created_by_name: string | null;
  premade_post_id: string | null;
  premade_synced_at: string | null;
  asset_ids: string[];
  claim_ids: string[];
};
export type Template = { id: string; name: string; platform: string | null; body: string; archived_at: string | null };
export type RiskyWord = { id: string; phrase: string; note: string | null; archived_at: string | null };

const CLAIM_COLUMNS =
  "id, claim_text, formulation_product_id, claim_type, status, evidence_note, evidence_url, review_note, reviewed_by_name, reviewed_at, review_again_on, created_by_name, updated_at";
const ASSET_COLUMNS =
  "id, title, business, formulation_product_id, asset_type, source, file_path, url, mime_type, size_bytes, project_url, status, notes, created_by_name, created_at, category, context_label, shot_date, is_full_lineup, preview_path, poster_path, width, height, duration_seconds";
const PROFILE_COLUMNS = "id, formulation_product_id, tagline, short_description, long_description, label_ingredients, key_points, hashtags, do_not_say, primary_asset_id, updated_by_name, updated_at";
const POST_COLUMNS =
  "id, title, business, formulation_product_id, platform, post_type, status, scheduled_date, scheduled_time, owner_account_id, caption, hashtags, project_url, posted_url, posted_at, notes, risky_words_checked, archived_at, created_by_name, premade_post_id, premade_synced_at";

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && v ? v.slice(0, 10) : null);
const time = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 5) : null);
function fail(error: { message?: string; code?: string } | null, message: string): never {
  if (/Only an Admin/.test(error?.message ?? "")) throw new GrowthError("Only an Admin can approve, reject or retire a claim.", 403);
  if (error?.code === "23505") throw new GrowthError(`${message} It already exists.`, 409);
  if (error?.code === "23514" || /check constraint/i.test(error?.message ?? "")) throw new GrowthError(`${message} A value is not valid.`, 400);
  throw new GrowthError(message, 500);
}
type Errors = Record<string, string>;
const txt = (raw: Record<string, unknown>, k: string) => (raw[k] === null || raw[k] === undefined ? "" : String(raw[k]).trim());
const httpOk = (u: string) => /^https?:\/\/[^\s]+$/i.test(u) && u.length <= 2000;
function textField(raw: Record<string, unknown>, k: string, max: number, label: string, errors: Errors): string | null {
  const v = txt(raw, k);
  if (v.length > max) errors[k] = `${label}: keep it under ${max} characters.`;
  return v || null;
}
function urlField(raw: Record<string, unknown>, k: string, errors: Errors): string | null {
  const v = txt(raw, k);
  if (v && !httpOk(v)) errors[k] = "Enter a full link starting with http:// or https://.";
  return v || null;
}
function check(errors: Errors) {
  if (Object.keys(errors).length) throw new GrowthError("Some fields are missing or not valid.", 400, errors);
}

// --- Loading ---------------------------------------------------------------------------------
export async function activeRiskyWords(db: Db): Promise<string[]> {
  const { data, error } = await db.from("risky_words").select("phrase, archived_at");
  if (error) fail(error, "Could not load the risky-word list.");
  return ((data ?? []) as Array<{ phrase: string; archived_at: string | null }>).filter((w) => !w.archived_at).map((w) => w.phrase);
}

export async function loadMarketing(db: Db) {
  const [fp, pr, cl, ev, as, po, pa, pc, tp, rw] = await Promise.all([
    db.from("formulation_products").select("id, name, status, deleted_at"),
    db.from("marketing_product_profiles").select(PROFILE_COLUMNS),
    db.from("claims").select(CLAIM_COLUMNS),
    db.from("claim_events").select("id, claim_id, event, actor_name, note, claim_text_snapshot, created_at"),
    db.from("marketing_assets").select(ASSET_COLUMNS),
    db.from("content_posts").select(POST_COLUMNS),
    db.from("content_post_assets").select("post_id, asset_id"),
    db.from("content_post_claims").select("post_id, claim_id"),
    db.from("caption_templates").select("id, name, platform, body, archived_at"),
    db.from("risky_words").select("id, phrase, note, archived_at"),
  ]);
  for (const r of [fp, pr, cl, ev, as, po, pa, pc, tp, rw]) if (r.error) fail(r.error, "Could not load the Marketing Hub.");
  const links = (rows: Array<{ post_id: string }>, key: "asset_id" | "claim_id", id: string) =>
    (rows as Array<Record<string, string>>).filter((r) => r.post_id === id).map((r) => r[key]);
  return {
    products: ((fp.data ?? []) as Array<{ id: string; name: string; status: string; deleted_at: string | null }>)
      .filter((p) => !p.deleted_at)
      .map((p) => ({ id: p.id, name: p.name, in_development: p.status === "in_development" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    profiles: (pr.data ?? []) as Profile[],
    claims: ((cl.data ?? []) as Claim[]).map((c) => ({ ...c, review_again_on: iso(c.review_again_on) })).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
    claimEvents: ((ev.data ?? []) as ClaimEvent[]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    assets: ((as.data ?? []) as Asset[]).map((a) => ({ ...a, shot_date: iso(a.shot_date) })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    posts: ((po.data ?? []) as Post[]).map((p) => ({
      ...p,
      scheduled_date: iso(p.scheduled_date),
      scheduled_time: time(p.scheduled_time),
      posted_at: iso(p.posted_at),
      asset_ids: links(pa.data ?? [], "asset_id", p.id),
      claim_ids: links(pc.data ?? [], "claim_id", p.id),
    })),
    templates: ((tp.data ?? []) as Template[]).sort((a, b) => a.name.localeCompare(b.name)),
    riskyWords: ((rw.data ?? []) as RiskyWord[]).sort((a, b) => a.phrase.localeCompare(b.phrase)),
    employees: await listAssignableEmployees(db),
  };
}

async function productOrThrow(db: Db, id: unknown, field = "formulation_product_id"): Promise<string | null> {
  if (id === null || id === undefined || id === "") return null;
  if (!isUuid(id)) throw new GrowthError("Choose a product from the list.", 400, { [field]: "Choose a product from the list." });
  const { data } = await db.from("formulation_products").select("id, deleted_at").eq("id", id).maybeSingle();
  if (!data || data.deleted_at) throw new GrowthError("Choose a product from the list.", 400, { [field]: "Choose a product from the list." });
  return id;
}

// --- Profiles --------------------------------------------------------------------------------
export async function saveProfile(db: Db, productId: unknown, input: Record<string, unknown>, actor: string | null): Promise<Profile> {
  const pid = await productOrThrow(db, productId);
  if (!pid) throw new GrowthError("Unknown product.", 404);
  const errors: Errors = {};
  const v = {
    tagline: textField(input, "tagline", 150, "Tagline", errors),
    short_description: textField(input, "short_description", 300, "Short description", errors),
    long_description: textField(input, "long_description", 2000, "Long description", errors),
    label_ingredients: textField(input, "label_ingredients", 2000, "Ingredients", errors),
    key_points: textField(input, "key_points", 1500, "Key points", errors),
    hashtags: textField(input, "hashtags", 500, "Hashtags", errors),
    do_not_say: textField(input, "do_not_say", 1000, "Do not say", errors),
    primary_asset_id: null as string | null,
  };
  const a = input.primary_asset_id;
  if (a) {
    if (!isUuid(a)) errors.primary_asset_id = "Choose a photo from the library.";
    else {
      const { data } = await db.from("marketing_assets").select("id, mime_type, source, status").eq("id", a).maybeSingle();
      if (!data || data.status === "archived" || data.source !== "upload" || !String(data.mime_type).startsWith("image/")) errors.primary_asset_id = "Choose an uploaded image from the library.";
      else v.primary_asset_id = data.id;
    }
  }
  check(errors);
  const { data, error } = await db
    .from("marketing_product_profiles")
    .upsert({ formulation_product_id: pid, ...v, updated_by_name: actor }, { onConflict: "formulation_product_id" })
    .select(PROFILE_COLUMNS)
    .single();
  if (error) fail(error, "Could not save the profile.");
  return data;
}

// --- Claims ----------------------------------------------------------------------------------
const CLAIM_TYPES = ["ingredient_fact", "benefit", "comparison", "certification", "other"];

async function getClaim(db: Db, id: unknown): Promise<Claim> {
  const cid = idOrThrow(id, "claim");
  const { data, error } = await db.from("claims").select(CLAIM_COLUMNS).eq("id", cid).maybeSingle();
  if (error) fail(error, "Could not load the claim.");
  if (!data) throw new GrowthError("Unknown claim.", 404);
  return data;
}

async function claimFields(db: Db, raw: Record<string, unknown>) {
  const errors: Errors = {};
  const claim_text = txt(raw, "claim_text");
  if (!claim_text) errors.claim_text = "Enter the claim.";
  else if (claim_text.length > 500) errors.claim_text = "Keep the claim under 500 characters.";
  const claim_type = txt(raw, "claim_type") || "other";
  if (!CLAIM_TYPES.includes(claim_type)) errors.claim_type = "Choose a type.";
  const evidence_note = textField(raw, "evidence_note", 2000, "Evidence", errors);
  const evidence_url = urlField(raw, "evidence_url", errors);
  const again = txt(raw, "review_again_on");
  if (again && !isIsoDate(again)) errors.review_again_on = "Enter a valid date.";
  check(errors);
  const formulation_product_id = await productOrThrow(db, raw.formulation_product_id);
  return { claim_text, claim_type, evidence_note, evidence_url, review_again_on: again || null, formulation_product_id };
}

export async function createClaim(db: Db, input: Record<string, unknown>, actor: string | null): Promise<Claim> {
  const v = await claimFields(db, input);
  const { data, error } = await db
    .from("claims")
    .insert({ ...v, status: input.submit === true ? "in_review" : "draft", created_by_name: actor, updated_by_name: actor })
    .select(CLAIM_COLUMNS)
    .single();
  if (error) fail(error, "Could not save the claim.");
  return data;
}

/** Edits a claim's text and details. Editing an approved claim's text sends it back to draft (database trigger). */
export async function updateClaim(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null): Promise<Claim> {
  const current = await getClaim(db, id);
  if (current.status === "retired") throw new GrowthError("Retired claims can't be edited.", 400);
  const v = await claimFields(db, input);
  const patch: Record<string, unknown> = { ...v, updated_by_name: actor };
  if (current.status === "rejected") Object.assign(patch, { status: "draft" });
  const { data, error } = await db.from("claims").update(patch).eq("id", current.id).select(CLAIM_COLUMNS).single();
  if (error) fail(error, "Could not save the claim.");
  return data;
}

export async function submitClaim(db: Db, id: unknown, actor: string | null): Promise<Claim> {
  const c = await getClaim(db, id);
  if (c.status !== "draft" && c.status !== "rejected") throw new GrowthError("Only draft or rejected claims can be submitted.", 400);
  const { data, error } = await db.from("claims").update({ status: "in_review", updated_by_name: actor }).eq("id", c.id).select(CLAIM_COLUMNS).single();
  if (error) fail(error, "Could not submit the claim.");
  return data;
}

/** Admin only (the route checks): approve, reject (a note is required) or retire. */
export async function reviewClaim(db: Db, id: unknown, input: Record<string, unknown>, actor: string | null): Promise<Claim> {
  const c = await getClaim(db, id);
  const action = txt(input, "action");
  const note = txt(input, "note");
  const again = txt(input, "review_again_on");
  if (note.length > 1000) throw new GrowthError("Keep the note under 1000 characters.", 400, { note: "Keep the note under 1000 characters." });
  if (again && !isIsoDate(again)) throw new GrowthError("Enter a valid date.", 400, { review_again_on: "Enter a valid date." });
  let status: Claim["status"];
  if (action === "approve") {
    if (c.status === "retired") throw new GrowthError("Retired claims can't be approved.", 400);
    status = "approved";
  } else if (action === "reject") {
    if (!note) throw new GrowthError("Enter a note explaining the rejection.", 400, { note: "Enter a note explaining the rejection." });
    status = "rejected";
  } else if (action === "retire") status = "retired";
  else throw new GrowthError("Unknown action.", 400);
  const { data, error } = await db
    .from("claims")
    .update({
      status,
      review_note: note || null,
      reviewed_by_name: actor,
      reviewed_at: new Date().toISOString(),
      updated_by_name: actor,
      ...(action === "approve" && again ? { review_again_on: again } : {}),
    })
    .eq("id", c.id)
    .select(CLAIM_COLUMNS)
    .single();
  if (error) fail(error, "Could not update the claim.");
  return data;
}

// --- Assets ------------------------------------------------------------------------------------
const ASSET_TYPES = ["photo", "video", "logo", "template", "packaging", "document", "other"];
const BUSINESSES = ["botaniqals", "minileaf", "brand"];

/**
 * Asset fields with the category and its tags. Product and ingredient tags
 * are written to the link tables; the legacy formulation_product_id column
 * is no longer written. A category is required for new assets; an existing
 * asset with none stays Uncategorized until someone sorts it.
 */
async function assetFields(db: Db, raw: Record<string, unknown>, opts: { isNew: boolean; currentCategory?: string | null } = { isNew: true }) {
  const errors: Errors = {};
  const title = txt(raw, "title");
  if (!title) errors.title = "Enter a title.";
  else if (title.length > 200) errors.title = "Keep the title under 200 characters.";
  const business = txt(raw, "business") || "botaniqals";
  if (!BUSINESSES.includes(business)) errors.business = "Choose a business.";
  const asset_type = txt(raw, "asset_type") || "photo";
  if (!ASSET_TYPES.includes(asset_type)) errors.asset_type = "Choose a type.";
  const project_url = urlField(raw, "project_url", errors);
  const notes = textField(raw, "notes", 1000, "Notes", errors);
  const shot_date = txt(raw, "shot_date");
  if (shot_date && !isIsoDate(shot_date)) errors.shot_date = "Enter a valid date.";
  const tags = await assetTagsFrom(db, raw);
  const category = txt(raw, "category") || null;
  const context_label = textField(raw, "context_label", 200, "Label", errors);
  const is_full_lineup = raw.is_full_lineup === true;
  Object.assign(
    errors,
    validateAssetCategory({ category, productIds: tags.productIds, ingredientIds: tags.ingredientIds, isFullLineup: is_full_lineup, contextLabel: context_label, requireCategory: opts.isNew || !!opts.currentCategory }),
  );
  check(errors);
  return {
    row: { title, business, asset_type, project_url, notes, category, context_label, shot_date: shot_date || null, is_full_lineup },
    productIds: tags.productIds,
    ingredientIds: tags.ingredientIds,
  };
}

/** Product and ingredient tag ids from the request, checked against the database. */
export async function assetTagsFrom(db: Db, raw: Record<string, unknown>) {
  const list = (k: string) => (Array.isArray(raw[k]) ? [...new Set((raw[k] as unknown[]).map(String))] : []);
  const productIds = list("product_ids");
  const ingredientIds = list("ingredient_ids");
  if ([...productIds, ...ingredientIds].some((x) => !isUuid(x))) throw new GrowthError("Unknown product or ingredient tag.", 400);
  if (productIds.length) {
    const { data } = await db.from("formulation_products").select("id, deleted_at").in("id", productIds);
    if (((data ?? []) as Array<{ deleted_at: string | null }>).filter((p) => !p.deleted_at).length !== productIds.length) throw new GrowthError("Choose products from the list.", 400, { products: "Choose products from the list." });
  }
  if (ingredientIds.length) {
    const { data } = await db.from("asset_ingredient_tags").select("id").in("id", ingredientIds);
    if ((data ?? []).length !== ingredientIds.length) throw new GrowthError("Choose ingredient tags from the list.", 400, { ingredients: "Choose tags from the list." });
  }
  return { productIds, ingredientIds };
}

/** Replaces an asset's product and ingredient tags (link rows). */
export async function setAssetTags(db: Db, assetId: string, productIds: readonly string[], ingredientIds: readonly string[]) {
  for (const [table, key, ids] of [["asset_product_links", "formulation_product_id", productIds], ["asset_ingredient_links", "ingredient_tag_id", ingredientIds]] as const) {
    const { data: cur } = await db.from(table).select(`asset_id, ${key}`).eq("asset_id", assetId);
    const have = new Set(((cur ?? []) as Array<Record<string, string>>).map((r) => r[key]));
    for (const x of have) if (!ids.includes(x)) await db.from(table).delete().eq("asset_id", assetId).eq(key, x);
    for (const x of ids) if (!have.has(x)) await db.from(table).insert({ asset_id: assetId, [key]: x });
  }
}

export async function createLinkAsset(db: Db, input: Record<string, unknown>, actor: string | null): Promise<Asset> {
  const v = await assetFields(db, input);
  const errors: Errors = {};
  const url = urlField(input, "url", errors);
  if (!url) errors.url = "Paste the share link (starting with http:// or https://).";
  check(errors);
  const { data, error } = await db.from("marketing_assets").insert({ ...v.row, source: "link", url, created_by_name: actor }).select(ASSET_COLUMNS).single();
  if (error) fail(error, "Could not save the asset.");
  await setAssetTags(db, data.id, v.productIds, v.ingredientIds);
  return data;
}

/** The extra JPG stored next to an original: a preview for HEIC, a poster for GIF and MP4. */
const EXTRA_FOR: Partial<Record<FileKind, "preview" | "poster">> = { heic: "preview", gif: "poster", mp4: "poster" };
const extraPath = (path: string, extra: "preview" | "poster") => `${path}.${extra}.jpg`;
const UPLOAD_TYPES_MSG = "Only PNG, JPG, WebP, PDF, HEIC, GIF and MP4 files can be uploaded. Paste a link for other videos.";

/**
 * Step 1 of an upload: signed upload URLs for a new private path (the
 * original) and, when asked, its preview or poster JPG. The browser uploads
 * straight to storage. Input: { mime_type, size_bytes, extra?, extra_size_bytes? }.
 */
export async function createAssetUploadUrl(db: Db, input: Record<string, unknown>) {
  const mime = txt(input, "mime_type");
  const size = Number(input.size_bytes);
  const type = UPLOAD_MIME[mime];
  if (!type) throw new GrowthError(UPLOAD_TYPES_MSG, 400);
  const tooBig = sizeError(type.kind, size);
  if (tooBig) throw new GrowthError(tooBig, 400);
  const extra = txt(input, "extra");
  if (extra && extra !== EXTRA_FOR[type.kind]) throw new GrowthError("This file type has no preview.", 400);
  if (extra) {
    const es = Number(input.extra_size_bytes);
    if (!Number.isFinite(es) || es <= 0 || es > PREVIEW_MAX_BYTES) throw new GrowthError("The preview image is too large.", 400);
  }
  const path = `assets/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${type.extension}`;
  const sign = async (p: string) => {
    const { data, error } = await db.storage.from(MARKETING_BUCKET).createSignedUploadUrl(p);
    if (error || !data) throw new GrowthError("Could not start the upload.", 500);
    return { path: data.path ?? p, token: data.token as string, signedUrl: (data.signedUrl as string | undefined) ?? null };
  };
  const original = await sign(path);
  return { ...original, extra: extra ? { kind: extra as "preview" | "poster", ...(await sign(extraPath(path, extra as "preview" | "poster"))) } : null };
}

/** File signatures: PNG, JPEG, WebP (RIFF....WEBP) and PDF. */
export function sniffMime(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i];
  if (bytes.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return "image/png";
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

/**
 * The first bytes and total size of a stored object, read with a ranged
 * request on a short-lived signed URL (the file itself is never downloaded
 * whole). Null when the object doesn't exist.
 */
export async function readObjectHead(db: Db, path: string): Promise<{ size: number; head: Uint8Array } | null> {
  const { data, error } = await db.storage.from(MARKETING_BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return null;
  const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` }, cache: "no-store" });
  if (res.status !== 200 && res.status !== 206) return null;
  const range = res.headers.get("content-range");
  const size = range ? Number(range.split("/")[1]) : Number(res.headers.get("content-length"));
  // Read only the first chunk(s), even if the server ignored the range.
  const chunks: Uint8Array[] = [];
  let got = 0;
  const reader = res.body?.getReader();
  if (reader) {
    while (got < SNIFF_BYTES) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => undefined);
  }
  const head = new Uint8Array(Math.min(got, SNIFF_BYTES));
  let at = 0;
  for (const c of chunks) {
    const part = c.slice(0, head.length - at);
    head.set(part, at);
    at += part.length;
    if (at >= head.length) break;
  }
  return { size: Number.isFinite(size) ? size : got, head };
}

const intOrNull = (v: unknown, max: number) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
};

/**
 * Step 2: the server checks what was actually uploaded (the first bytes and
 * the size must match the stated type and its limit; a preview or poster must
 * be a small JPG next to it) before the asset is saved. If anything is wrong,
 * every uploaded object for this asset is removed.
 */
export async function finalizeUpload(db: Db, input: Record<string, unknown>, actor: string | null): Promise<Asset> {
  const path = txt(input, "path");
  if (!/^assets\/\d{4}-\d{2}\/[0-9a-f-]{36}\.(png|jpg|webp|pdf|heic|heif|gif|mp4)$/.test(path)) throw new GrowthError("Unknown upload.", 400);
  const v = await assetFields(db, input);
  const mime = txt(input, "mime_type");
  const type = UPLOAD_MIME[mime];
  const previewPath = txt(input, "preview_path") || null;
  const posterPath = txt(input, "poster_path") || null;
  const extras = [previewPath === extraPath(path, "preview") ? previewPath : null, posterPath === extraPath(path, "poster") ? posterPath : null].filter((x): x is string => !!x);
  const reject = async (message: string): Promise<never> => {
    await db.storage.from(MARKETING_BUCKET).remove([path, ...extras]);
    throw new GrowthError(message, 400);
  };
  if (!type || !path.endsWith(`.${type.extension}`)) return reject("The file type doesn't match.");
  if ((previewPath && (previewPath !== extraPath(path, "preview") || EXTRA_FOR[type.kind] !== "preview")) || (posterPath && (posterPath !== extraPath(path, "poster") || EXTRA_FOR[type.kind] !== "poster"))) {
    return reject("The preview doesn't belong to this upload.");
  }
  const original = await readObjectHead(db, path);
  if (!original) return reject("The upload wasn't found. Try again.");
  const detected = detectFileKind({ name: path, firstBytes: original.head });
  if (!detected.ok || detected.file.mime !== mime) return reject(detected.ok ? "The file's contents don't match its type." : detected.error);
  const tooBig = sizeError(type.kind, original.size);
  if (tooBig) return reject(tooBig);
  for (const p of extras) {
    const h = await readObjectHead(db, p);
    if (!h || !isJpegBytes(h.head) || h.size <= 0 || h.size > PREVIEW_MAX_BYTES) return reject("The preview image is missing or not valid. Try again.");
  }
  const duration = input.duration_seconds === null || input.duration_seconds === undefined || input.duration_seconds === "" ? null : Number(input.duration_seconds);
  const media = {
    preview_path: previewPath,
    poster_path: posterPath,
    width: intOrNull(input.width, 100000),
    height: intOrNull(input.height, 100000),
    duration_seconds: duration !== null && Number.isFinite(duration) && duration >= 0 && duration <= 86400 ? Math.round(duration * 100) / 100 : null,
  };
  const { data, error } = await db
    .from("marketing_assets")
    .insert({ ...v.row, source: "upload", file_path: path, mime_type: mime, size_bytes: original.size, created_by_name: actor, ...media })
    .select(ASSET_COLUMNS)
    .single();
  if (error) {
    await db.storage.from(MARKETING_BUCKET).remove([path, ...extras]);
    fail(error, "Could not save the asset.");
  }
  await setAssetTags(db, data.id, v.productIds, v.ingredientIds);
  return data;
}

export async function updateAsset(db: Db, id: unknown, input: Record<string, unknown>): Promise<Asset> {
  const aid = idOrThrow(id, "asset");
  const { data: cur } = await db.from("marketing_assets").select(ASSET_COLUMNS).eq("id", aid).maybeSingle();
  if (!cur) throw new GrowthError("Unknown asset.", 404);
  let patch: Record<string, unknown>;
  let tags: { productIds: string[]; ingredientIds: string[] } | null = null;
  if (input.status !== undefined && Object.keys(input).length === 1) {
    const s = txt(input, "status");
    if (!["draft", "ready", "archived"].includes(s)) throw new GrowthError("Choose a status.", 400);
    patch = { status: s };
  } else if (input.title !== undefined && Object.keys(input).length === 1) {
    // Rename only.
    const title = txt(input, "title");
    const err = assetNameError(title);
    if (err) throw new GrowthError(err, 400, { title: err });
    patch = { title };
  } else {
    const v = await assetFields(db, input, { isNew: false, currentCategory: cur.category });
    patch = v.row;
    tags = { productIds: v.productIds, ingredientIds: v.ingredientIds };
    if (cur.source === "link") {
      const errors: Errors = {};
      const url = urlField(input, "url", errors);
      if (!url) errors.url = "Paste the share link.";
      check(errors);
      patch.url = url;
    }
  }
  const { data, error } = await db.from("marketing_assets").update(patch).eq("id", aid).select(ASSET_COLUMNS).single();
  if (error) fail(error, "Could not save the asset.");
  // Tags change only after the asset itself saved.
  if (tags) await setAssetTags(db, aid, tags.productIds, tags.ingredientIds);
  return data;
}

/**
 * Short-lived signed URLs for uploaded assets. variant "original" (default)
 * is the stored file; "thumb" is the poster or preview JPG when there is one,
 * else the file itself for browser images; "preview" is the HEIC's JPG.
 * Downloads are named "{title}.{extension}".
 */
export async function signedAssetUrls(db: Db, ids: unknown, opts: { download?: boolean; variant?: unknown } = {}) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw new GrowthError("Choose the assets.", 400);
  for (const id of ids) idOrThrow(id, "asset");
  const variant = opts.variant === "thumb" || opts.variant === "preview" ? opts.variant : "original";
  const { data, error } = await db.from("marketing_assets").select("id, title, file_path, source, mime_type, preview_path, poster_path").in("id", ids);
  if (error) fail(error, "Could not load assets.");
  const out: Record<string, string> = {};
  type Row = { id: string; title: string; file_path: string | null; source: string; mime_type: string | null; preview_path: string | null; poster_path: string | null };
  for (const a of (data ?? []) as Row[]) {
    if (a.source !== "upload" || !a.file_path) continue;
    const browserImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(a.mime_type ?? "");
    const path =
      variant === "thumb" ? (a.poster_path ?? a.preview_path ?? (browserImage ? a.file_path : null)) : variant === "preview" ? a.preview_path : a.file_path;
    if (!path) continue;
    const name = variant === "original" ? safeDownloadName(a.title, assetExtension(a.file_path, a.mime_type)) : safeDownloadName(a.title, "jpg");
    const { data: s } = await db.storage.from(MARKETING_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS, opts.download ? { download: name } : undefined);
    if (s?.signedUrl) out[a.id] = s.signedUrl;
  }
  return out;
}

// --- Posts -------------------------------------------------------------------------------------
const PLATFORMS = ["instagram", "tiktok", "facebook", "youtube", "other"];
const POST_TYPES = ["reel", "story", "post", "ad", "other"];
const POST_STATUSES = ["idea", "scripting", "filming", "editing", "ready", "scheduled", "posted"];

export type PostCheck = { unapproved: Array<{ id: string; claim_text: string; status: string }>; risky: string[]; missingCaption: boolean };

/** The Ready gate: caption, approved claims only, and risky words acknowledged. */
export async function checkPost(db: Db, p: { status: string; caption: string | null; hashtags: string | null; claim_ids: string[]; risky_words_checked: boolean }): Promise<PostCheck> {
  let claims: Array<{ id: string; claim_text: string; status: string }> = [];
  if (p.claim_ids.length) {
    const { data, error } = await db.from("claims").select("id, claim_text, status").in("id", p.claim_ids);
    if (error) fail(error, "Could not load claims.");
    claims = data ?? [];
    if (claims.length !== new Set(p.claim_ids).size) throw new GrowthError("Unknown claim.", 404);
  }
  const words = await activeRiskyWords(db);
  return {
    unapproved: claimsReadyCheck(claims),
    risky: scanText(`${p.caption ?? ""}\n${p.hashtags ?? ""}`, words).map((m) => m.phrase),
    missingCaption: !(p.caption ?? "").trim(),
  };
}

export async function savePost(db: Db, id: unknown | null, input: Record<string, unknown>, actor: string | null) {
  const errors: Errors = {};
  const title = txt(input, "title");
  if (!title) errors.title = "Enter a title.";
  else if (title.length > 200) errors.title = "Keep the title under 200 characters.";
  const business = txt(input, "business") || "botaniqals";
  if (!BUSINESSES.includes(business)) errors.business = "Choose a business.";
  const platform = txt(input, "platform") || "instagram";
  if (!PLATFORMS.includes(platform)) errors.platform = "Choose a platform.";
  const post_type = txt(input, "post_type") || "reel";
  if (!POST_TYPES.includes(post_type)) errors.post_type = "Choose a type.";
  const status = txt(input, "status") || "idea";
  if (!POST_STATUSES.includes(status)) errors.status = "Choose a status.";
  const scheduled_date = txt(input, "scheduled_date");
  if (scheduled_date && !isIsoDate(scheduled_date)) errors.scheduled_date = "Enter a valid date.";
  const scheduled_time = txt(input, "scheduled_time");
  if (scheduled_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduled_time)) errors.scheduled_time = "Enter a time like 09:30.";
  const posted_at = txt(input, "posted_at");
  if (posted_at && !isIsoDate(posted_at)) errors.posted_at = "Enter a valid date.";
  const owner = input.owner_account_id;
  if (owner && !isUuid(owner)) errors.owner_account_id = "Choose someone from the list.";
  const caption = textField(input, "caption", 4000, "Caption", errors);
  const hashtags = textField(input, "hashtags", 1000, "Hashtags", errors);
  const notes = textField(input, "notes", 2000, "Notes", errors);
  const project_url = urlField(input, "project_url", errors);
  const posted_url = urlField(input, "posted_url", errors);
  const asset_ids = Array.isArray(input.asset_ids) ? [...new Set(input.asset_ids as unknown[])] : [];
  const claim_ids = Array.isArray(input.claim_ids) ? [...new Set(input.claim_ids as unknown[])] : [];
  for (const x of [...asset_ids, ...claim_ids]) if (!isUuid(x)) errors.links = "Unknown asset or claim.";
  check(errors);
  const risky_words_checked = input.risky_words_checked === true;
  const gate = await checkPost(db, { status, caption, hashtags, claim_ids: claim_ids as string[], risky_words_checked });
  if (isReadyStatus(status)) {
    if (gate.missingCaption) throw new GrowthError("Write the caption before marking the post Ready, Scheduled or Posted.", 400, { caption: "Write the caption first." });
    if (gate.unapproved.length) {
      throw new GrowthError(`These claims aren't approved yet: ${gate.unapproved.map((c) => `"${c.claim_text}"`).join(", ")}. Remove them or get them approved first.`, 400, { claim_ids: "Only approved claims can be used." });
    }
    if (gate.risky.length && !risky_words_checked) {
      throw new GrowthError(`Check these words first: ${gate.risky.join(", ")}. Then tick "I have checked these words".`, 400, { risky_words_checked: "Tick to confirm you checked these words." });
    }
  }
  if (asset_ids.length) {
    const { data } = await db.from("marketing_assets").select("id").in("id", asset_ids);
    if ((data ?? []).length !== asset_ids.length) throw new GrowthError("Unknown asset.", 404);
  }
  const row = {
    title,
    business,
    formulation_product_id: await productOrThrow(db, input.formulation_product_id),
    platform,
    post_type,
    status,
    scheduled_date: scheduled_date || null,
    scheduled_time: scheduled_time || null,
    owner_account_id: owner || null,
    caption,
    hashtags,
    project_url,
    posted_url,
    posted_at: posted_at || null,
    notes,
    risky_words_checked: gate.risky.length > 0 && risky_words_checked,
  };
  let postId: string;
  if (id) {
    const pid = idOrThrow(id, "post");
    const { data, error } = await db.from("content_posts").update(row).eq("id", pid).select("id").maybeSingle();
    if (error) fail(error, "Could not save the post.");
    if (!data) throw new GrowthError("Unknown post.", 404);
    postId = pid;
  } else {
    const { data, error } = await db.from("content_posts").insert({ ...row, created_by_name: actor }).select("id").single();
    if (error) fail(error, "Could not save the post.");
    postId = data.id;
  }
  // Attachments are join rows (the post and the assets/claims are never deleted).
  for (const [table, key, ids] of [["content_post_assets", "asset_id", asset_ids], ["content_post_claims", "claim_id", claim_ids]] as const) {
    const { data: cur } = await db.from(table).select(`post_id, ${key}`).eq("post_id", postId);
    const have = new Set(((cur ?? []) as Array<Record<string, string>>).map((r) => r[key]));
    for (const x of have) if (!ids.includes(x)) await db.from(table).delete().eq("post_id", postId).eq(key, x);
    for (const x of ids as string[]) if (!have.has(x)) await db.from(table).insert({ post_id: postId, [key]: x });
  }
  return { id: postId, warnings: gate.risky };
}

export async function archivePost(db: Db, id: unknown, archive: boolean) {
  const pid = idOrThrow(id, "post");
  const { error } = await db.from("content_posts").update({ archived_at: archive ? new Date().toISOString() : null }).eq("id", pid);
  if (error) fail(error, "Could not update the post.");
}

// --- Templates and risky words -----------------------------------------------------------------
export async function saveTemplate(db: Db, id: unknown | null, input: Record<string, unknown>) {
  if (input.archive === true || input.restore === true) {
    const { error } = await db.from("caption_templates").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", idOrThrow(id, "template"));
    if (error) fail(error, "Could not update the template.");
    return;
  }
  const errors: Errors = {};
  const name = txt(input, "name");
  if (!name) errors.name = "Enter a name.";
  else if (name.length > 150) errors.name = "Keep the name under 150 characters.";
  const body = String(input.body ?? "");
  if (!body.trim()) errors.body = "Write the template.";
  else if (body.length > 2000) errors.body = "Keep the template under 2000 characters.";
  const platform = txt(input, "platform");
  if (platform && !PLATFORMS.includes(platform)) errors.platform = "Choose a platform.";
  check(errors);
  const row = { name, body, platform: platform || null };
  const r = id ? await db.from("caption_templates").update(row).eq("id", idOrThrow(id, "template")) : await db.from("caption_templates").insert(row);
  if (r.error) fail(r.error, "Could not save the template.");
}

/** Admin only (the route checks). */
export async function saveRiskyWord(db: Db, id: unknown | null, input: Record<string, unknown>) {
  if (input.archive === true || input.restore === true) {
    const { error } = await db.from("risky_words").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", idOrThrow(id, "word"));
    if (error) fail(error, "Could not update the word.");
    return;
  }
  const errors: Errors = {};
  const phrase = txt(input, "phrase").replace(/\s+/g, " ");
  if (!phrase) errors.phrase = "Enter a word or phrase.";
  else if (phrase.length > 80) errors.phrase = "Keep it under 80 characters.";
  const note = textField(input, "note", 200, "Note", errors);
  check(errors);
  const r = id ? await db.from("risky_words").update({ phrase, note }).eq("id", idOrThrow(id, "word")) : await db.from("risky_words").insert({ phrase, note });
  if (r.error) {
    if (r.error.code === "23505" || /unique/i.test(r.error.message ?? "")) throw new GrowthError("That word is already on the list (it may be archived).", 409, { phrase: "Already on the list." });
    fail(r.error, "Could not save the word.");
  }
}
