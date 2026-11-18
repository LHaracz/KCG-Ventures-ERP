/**
 * Line sheets (Admin only; the routes check). Server code with the service
 * role. A saved line sheet keeps a copy of the business letterhead and each
 * line's prices; they change only when the builder asks to refresh them.
 * Photos come from the private marketing-assets bucket and are read on the
 * server only.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { downloadCompanyLogoBytes } from "@/lib/companyLogoStorage";
import { LineSheetPdfDocument } from "@/lib/pdf/lineSheetPdf";
import { loadRetailBootstrap, RetailError, type RetailBootstrap } from "./service";
import { BUSINESS_COLUMNS, type Business } from "./types";
import { validateLineSheet, type LineSheet, type LineSheetCompany, type LineSheetLine, type LineSheetWithLines } from "./lineSheets";

// The retail Db type has no storage; line sheets also read photos.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LsDb = any;

const SHEET_COLUMNS =
  "id, name, company_profile_id, retailer_id, prepared_for, price_basis, standard_wholesale_percent, show_margin, minimum_order_text, lead_time_text, payment_terms_text, contact_name, contact_email, contact_phone, notes, company_snapshot, prices_saved_at, created_by_name, deleted_at, last_downloaded_at, created_at, updated_at";
const LINE_COLUMNS = "line_number, product_id, name, description, size_text, case_pack_text, wholesale_price, msrp, photo_asset_id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(error: { message?: string } | null, message: string): never {
  const msg = error?.message ?? "";
  if (/at most 60 products/.test(msg)) throw new RetailError("A line sheet can have at most 60 products.", 400);
  if (/check constraint|violates/.test(msg)) throw new RetailError(`Some details are not valid (${msg.replace(/^.*constraint "([^"]+)".*$/, "$1")}).`, 400);
  throw new Error(msg ? `${message} (${msg})` : message);
}
const idOrThrow = (id: unknown, what: string): string => {
  if (typeof id !== "string" || !UUID.test(id)) throw new RetailError(`Unknown ${what}.`, 404);
  return id;
};

export function companySnapshot(b: Business): LineSheetCompany {
  return {
    display_name: b.display_name,
    legal_name: b.legal_name,
    address_line1: b.address_line1,
    address_line2: b.address_line2,
    city: b.city,
    state: b.state,
    zip: b.zip,
    country: b.country,
    phone: b.phone,
    email: b.email,
    website: b.website,
    logo_path: b.logo_path,
    accent_color: b.accent_color,
  };
}

export type ProductMarketing = { product_id: string; description: string | null; photo_asset_id: string | null; photo_title: string | null };
export type LineSheetBuilderData = RetailBootstrap & {
  prices: Array<{ retailer_id: string; product_id: string; wholesale_price: string | number | null; msrp: string | number | null }>;
  marketing: ProductMarketing[];
  riskyWords: string[];
};

/** Everything the builder needs: retail data, every price list, marketing copy and primary photos by product. */
export async function loadLineSheetBuilder(db: LsDb): Promise<LineSheetBuilderData> {
  const [boot, prices, fps, profiles, assets, words] = await Promise.all([
    loadRetailBootstrap(db),
    db.from("retailer_prices").select("retailer_id, product_id, wholesale_price, msrp"),
    db.from("formulation_products").select("id, product_id, deleted_at"),
    db.from("marketing_product_profiles").select("formulation_product_id, short_description, tagline, primary_asset_id"),
    db.from("marketing_assets").select("id, title, status, source, mime_type"),
    db.from("risky_words").select("phrase, archived_at"),
  ]);
  for (const r of [prices, fps, profiles, assets, words]) if (r.error) fail(r.error, "Could not load line sheet data.");
  const assetById = new Map((assets.data ?? []).map((a: { id: string }) => [a.id, a]));
  const marketing: ProductMarketing[] = [];
  for (const fp of (fps.data ?? []) as Array<{ id: string; product_id: string | null; deleted_at: string | null }>) {
    if (!fp.product_id || fp.deleted_at) continue;
    const prof = (profiles.data ?? []).find((p: { formulation_product_id: string }) => p.formulation_product_id === fp.id);
    if (!prof) continue;
    const a = prof.primary_asset_id ? (assetById.get(prof.primary_asset_id) as { id: string; title: string; status: string; source: string; mime_type: string | null } | undefined) : undefined;
    const usable = a && a.status !== "archived" && a.source === "upload" && (a.mime_type ?? "").startsWith("image/");
    marketing.push({ product_id: fp.product_id, description: prof.short_description ?? prof.tagline ?? null, photo_asset_id: usable ? a!.id : null, photo_title: usable ? a!.title : null });
  }
  return {
    ...boot,
    prices: prices.data ?? [],
    marketing,
    riskyWords: ((words.data ?? []) as Array<{ phrase: string; archived_at: string | null }>).filter((w) => !w.archived_at).map((w) => w.phrase),
  };
}

export type LineSheetListRow = Pick<LineSheet, "id" | "name" | "company_profile_id" | "retailer_id" | "prepared_for" | "price_basis" | "standard_wholesale_percent" | "created_at" | "deleted_at" | "last_downloaded_at" | "prices_saved_at"> & {
  business_name: string;
  retailer_name: string | null;
  product_count: number;
};

export async function listLineSheets(db: LsDb, opts: { deleted?: boolean } = {}): Promise<LineSheetListRow[]> {
  const [s, l, b, r] = await Promise.all([
    db.from("line_sheets").select(SHEET_COLUMNS),
    db.from("line_sheet_lines").select("line_sheet_id"),
    db.from("company_profiles").select("id, display_name"),
    db.from("retailers").select("id, name"),
  ]);
  for (const x of [s, l, b, r]) if (x.error) fail(x.error, "Could not load line sheets.");
  const counts = new Map<string, number>();
  for (const row of (l.data ?? []) as Array<{ line_sheet_id: string }>) counts.set(row.line_sheet_id, (counts.get(row.line_sheet_id) ?? 0) + 1);
  return ((s.data ?? []) as LineSheet[])
    .filter((x) => !!x.deleted_at === !!opts.deleted)
    .map((x) => ({
      id: x.id,
      name: x.name,
      company_profile_id: x.company_profile_id,
      retailer_id: x.retailer_id,
      prepared_for: x.prepared_for,
      price_basis: x.price_basis,
      standard_wholesale_percent: x.standard_wholesale_percent,
      created_at: x.created_at,
      deleted_at: x.deleted_at,
      last_downloaded_at: x.last_downloaded_at,
      prices_saved_at: x.prices_saved_at,
      business_name: (b.data ?? []).find((y: { id: string }) => y.id === x.company_profile_id)?.display_name ?? "",
      retailer_name: (r.data ?? []).find((y: { id: string }) => y.id === x.retailer_id)?.name ?? null,
      product_count: counts.get(x.id) ?? 0,
    }))
    .sort((a, b2) => (a.created_at < b2.created_at ? 1 : -1));
}

export async function getLineSheet(db: LsDb, id: unknown): Promise<LineSheetWithLines> {
  const sid = idOrThrow(id, "line sheet");
  const { data, error } = await db.from("line_sheets").select(SHEET_COLUMNS).eq("id", sid).maybeSingle();
  if (error) fail(error, "Could not load the line sheet.");
  if (!data) throw new RetailError("Unknown line sheet.", 404);
  const { data: lines, error: le } = await db.from("line_sheet_lines").select(LINE_COLUMNS).eq("line_sheet_id", sid).order("line_number", { ascending: true });
  if (le) fail(le, "Could not load the line sheet.");
  return { ...data, lines: lines ?? [] };
}

/** Validates and checks every reference; returns the row values and lines. */
async function prepare(db: LsDb, input: Record<string, unknown>) {
  const v = validateLineSheet(input);
  if (!v.ok) throw new RetailError("Some fields are missing or not valid.", 400, v.errors);
  const { sheet, lines } = v.value;
  const { data: biz } = await db.from("company_profiles").select(BUSINESS_COLUMNS).eq("id", sheet.company_profile_id).maybeSingle();
  if (!biz || biz.archived_at) throw new RetailError("Choose a business.", 400, { company_profile_id: "Choose a business." });
  if (sheet.retailer_id) {
    const { data: r } = await db.from("retailers").select("id").eq("id", sheet.retailer_id).maybeSingle();
    if (!r) throw new RetailError("Choose a retailer from the list.", 400, { retailer_id: "Choose a retailer from the list." });
  }
  const productIds = [...new Set(lines.map((l) => l.product_id).filter((x): x is string => !!x))];
  if (productIds.length) {
    const { data } = await db.from("products").select("id").in("id", productIds);
    if ((data ?? []).length !== productIds.length) throw new RetailError("A product on this line sheet no longer exists.", 400);
  }
  const photoIds = [...new Set(lines.map((l) => l.photo_asset_id).filter((x): x is string => !!x))];
  if (photoIds.length) {
    const { data } = await db.from("marketing_assets").select("id, source, mime_type").in("id", photoIds);
    const ok = (data ?? []).filter((a: { source: string; mime_type: string | null }) => a.source === "upload" && (a.mime_type ?? "").startsWith("image/"));
    if (ok.length !== photoIds.length) throw new RetailError("A photo on this line sheet isn't an uploaded image.", 400);
  }
  return { sheet, lines, company: companySnapshot(biz as Business) };
}

async function writeLines(db: LsDb, sheetId: string, lines: LineSheetLine[]) {
  const del = await db.from("line_sheet_lines").delete().eq("line_sheet_id", sheetId);
  if (del.error) fail(del.error, "Could not save the products.");
  if (!lines.length) return;
  const ins = await db.from("line_sheet_lines").insert(lines.map((l) => ({ ...l, line_sheet_id: sheetId })));
  if (ins.error) fail(ins.error, "Could not save the products.");
}

export async function createLineSheet(db: LsDb, input: Record<string, unknown>, actor: string | null): Promise<{ id: string }> {
  const { sheet, lines, company } = await prepare(db, input);
  const { data, error } = await db
    .from("line_sheets")
    .insert({ ...sheet, company_snapshot: company, prices_saved_at: new Date().toISOString(), created_by_name: actor })
    .select("id")
    .single();
  if (error) fail(error, "Could not save the line sheet.");
  await writeLines(db, data.id, lines);
  return { id: data.id };
}

/**
 * Saves edits. The letterhead and the "prices saved" date are refreshed
 * only with { refresh_prices: true } (the builder's Refresh prices, which
 * also re-reads the prices) or when the business changes.
 */
export async function updateLineSheet(db: LsDb, id: unknown, input: Record<string, unknown>): Promise<{ id: string }> {
  const current = await getLineSheet(db, id);
  if (current.deleted_at) throw new RetailError("Restore this line sheet before editing it.", 400);
  const { sheet, lines, company } = await prepare(db, input);
  const refresh = input.refresh_prices === true || sheet.company_profile_id !== current.company_profile_id;
  const patch: Record<string, unknown> = { ...sheet };
  if (refresh) Object.assign(patch, { company_snapshot: company, prices_saved_at: new Date().toISOString() });
  const { error } = await db.from("line_sheets").update(patch).eq("id", current.id);
  if (error) fail(error, "Could not save the line sheet.");
  await writeLines(db, current.id, lines);
  return { id: current.id };
}

/** A copy with the same products and saved prices (and their date). */
export async function duplicateLineSheet(db: LsDb, id: unknown, actor: string | null): Promise<{ id: string }> {
  const s = await getLineSheet(db, id);
  const { id: _id, lines, created_at: _c, updated_at: _u, deleted_at: _d, last_downloaded_at: _l, created_by_name: _b, ...rest } = s;
  void _id; void _c; void _u; void _d; void _l; void _b;
  const name = `${s.name} (copy)`.slice(0, 200);
  const { data, error } = await db.from("line_sheets").insert({ ...rest, name, created_by_name: actor }).select("id").single();
  if (error) fail(error, "Could not copy the line sheet.");
  await writeLines(db, data.id, lines.map((l) => ({ ...l })));
  return { id: data.id };
}

export async function setLineSheetDeleted(db: LsDb, id: unknown, deleted: boolean) {
  const sid = idOrThrow(id, "line sheet");
  const { data, error } = await db.from("line_sheets").update({ deleted_at: deleted ? new Date().toISOString() : null }).eq("id", sid).select("id").maybeSingle();
  if (error) fail(error, "Could not update the line sheet.");
  if (!data) throw new RetailError("Unknown line sheet.", 404);
}

export async function markLineSheetDownloaded(db: LsDb, id: string) {
  await db.from("line_sheets").update({ last_downloaded_at: new Date().toISOString() }).eq("id", id);
}

/** An unsaved line sheet for Preview PDF: validated, with the current letterhead. */
export async function buildPreviewLineSheet(db: LsDb, input: Record<string, unknown>, existingId: unknown): Promise<LineSheetWithLines> {
  const { sheet, lines, company } = await prepare(db, input);
  let saved: LineSheet | null = null;
  if (existingId) saved = await getLineSheet(db, existingId);
  const keep = saved && input.refresh_prices !== true && saved.company_profile_id === sheet.company_profile_id;
  const now = new Date().toISOString();
  return {
    ...sheet,
    id: saved?.id ?? "preview",
    company_snapshot: keep ? saved!.company_snapshot : company,
    prices_saved_at: keep ? saved!.prices_saved_at : now,
    created_by_name: null,
    deleted_at: null,
    last_downloaded_at: null,
    created_at: saved?.created_at ?? now,
    updated_at: now,
    lines,
  };
}

// ---- PDF ----------------------------------------------------------------------------------------
const PHOTO_MAX_PX = 800;

/**
 * A photo as a data URI the PDF can embed. With sharp (when installed) the
 * image is turned upright and scaled to at most 800 px and saved as JPEG,
 * which also handles WebP. Without sharp, PNG and JPEG are used as they
 * are and WebP gets the placeholder. Any failure gives the placeholder.
 */
export async function photoDataUri(bytes: Uint8Array, mime: string): Promise<string | null> {
  try {
    const mod = (await import("sharp")) as unknown as { default: (b: Buffer) => { rotate: () => { resize: (o: object) => { jpeg: (o: object) => { toBuffer: () => Promise<Buffer> } } } } };
    const out = await mod
      .default(Buffer.from(bytes))
      .rotate()
      .resize({ width: PHOTO_MAX_PX, height: PHOTO_MAX_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    if (mime === "image/png" || mime === "image/jpeg") return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    return null;
  }
}

async function loadPhotos(db: LsDb, lines: LineSheetLine[]): Promise<Record<string, string>> {
  const ids = [...new Set(lines.map((l) => l.photo_asset_id).filter((x): x is string => !!x))];
  if (!ids.length) return {};
  const { data } = await db.from("marketing_assets").select("id, file_path, mime_type, source").in("id", ids);
  const out: Record<string, string> = {};
  await Promise.all(
    ((data ?? []) as Array<{ id: string; file_path: string | null; mime_type: string | null; source: string }>).map(async (a) => {
      if (a.source !== "upload" || !a.file_path) return;
      try {
        const { data: blob } = await db.storage.from("marketing-assets").download(a.file_path);
        if (!blob) return;
        const uri = await photoDataUri(new Uint8Array(await blob.arrayBuffer()), a.mime_type ?? "");
        if (uri) out[a.id] = uri;
      } catch {
        // Missing photo: the placeholder prints instead.
      }
    }),
  );
  return out;
}

export async function renderLineSheetPdf(db: LsDb, sheet: LineSheetWithLines, opts: { retailerName?: string | null; loadLogo?: boolean } = {}): Promise<Buffer> {
  let logo: string | null = null;
  if (sheet.company_snapshot.logo_path && opts.loadLogo !== false) {
    try {
      const l = await downloadCompanyLogoBytes(sheet.company_snapshot.logo_path);
      if (l) logo = `data:${l.mimeType};base64,${Buffer.from(l.bytes).toString("base64")}`;
    } catch {
      logo = null;
    }
  }
  const photos = await loadPhotos(db, sheet.lines);
  const doc = createElement(LineSheetPdfDocument, { sheet, logoDataUri: logo, photos, retailerName: opts.retailerName ?? null });
  return renderToBuffer(doc as unknown as Parameters<typeof renderToBuffer>[0]);
}

export async function retailerNameOf(db: LsDb, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await db.from("retailers").select("name").eq("id", id).maybeSingle();
  return data?.name ?? null;
}
