/**
 * Shared server-side helpers for the Purchase Orders "company-assets"
 * Storage bucket — private, PNG/JPEG only, 2 MB cap (mirrors sopStorage.ts's
 * shape exactly, just retargeted at logos). Every call here uses
 * `supabaseAdmin` (the service role key); nothing client-side talks to
 * Storage directly except via `uploadToSignedUrl`, whose token already
 * carries its own authorization.
 *
 * Important asymmetry vs. sopStorage.ts: `removeCompanyAssetObject` below is
 * only ever called to clean up a failed/rejected upload attempt — never to
 * remove a logo that was actually attached to a profile. Replacing a
 * profile's logo must NEVER delete the old file, because older POs'
 * `company_snapshot` can still point at it (see purchase_orders_core.sql's
 * comment on the company-assets bucket).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const COMPANY_ASSETS_BUCKET = "company-assets";
export const MAX_LOGO_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
export const SIGNED_LOGO_URL_TTL_SECONDS = 10 * 60; // 10 minutes

export type AllowedLogoMimeType = "image/png" | "image/jpeg";

const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const ALLOWED_MIME_TYPES: AllowedLogoMimeType[] = ["image/png", "image/jpeg"];

export function isAllowedLogoFilename(filename: string): boolean {
  const lower = filename.toLowerCase().trim();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isAllowedLogoMimeType(mimeType: string | null | undefined): mimeType is AllowedLogoMimeType {
  return ALLOWED_MIME_TYPES.includes((mimeType || "").toLowerCase() as AllowedLogoMimeType);
}

/** Builds a Storage path that never collides, independent of any DB id. */
export function buildCompanyLogoStoragePath(originalFilename: string, profileId?: string): string {
  const safeName =
    originalFilename
      .replace(/[^a-zA-Z0-9.\-_]/g, "_")
      .slice(-120) || "logo";
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${profileId || "pending"}/${randomId}-${safeName}`;
}

export type VerifyLogoUploadResult =
  | { ok: true; sizeBytes: number; mimeType: AllowedLogoMimeType }
  | { ok: false; error: string };

/**
 * Authoritative post-upload validation, run only after the browser has
 * already PUT the file to its signed upload URL. Confirms the object is
 * really there, re-checks its size against the 2 MB cap using Storage's own
 * metadata (never the client's claimed size), and reads just its first few
 * bytes over HTTP Range to confirm the real file type by magic number (PNG
 * "\x89PNG", JPEG 0xFFD8FF) — never downloads the whole file to do this.
 * Removes the object from Storage if it fails any check, so a bad upload
 * doesn't leave an orphaned file behind.
 */
export async function verifyUploadedLogo(path: string): Promise<VerifyLogoUploadResult> {
  if (!supabaseAdmin) {
    return { ok: false, error: "Storage is not configured on the server (missing service role key)." };
  }

  const slashIndex = path.lastIndexOf("/");
  const dir = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;

  const { data: listing, error: listError } = await supabaseAdmin.storage
    .from(COMPANY_ASSETS_BUCKET)
    .list(dir, { search: name, limit: 1 });
  if (listError) return { ok: false, error: listError.message };
  const found = listing?.find((f) => f.name === name);
  if (!found) return { ok: false, error: "Uploaded file was not found in storage." };

  const sizeBytes = Number(found.metadata?.size ?? 0);
  if (!sizeBytes) return { ok: false, error: "Uploaded file is empty." };
  if (sizeBytes > MAX_LOGO_FILE_BYTES) {
    await supabaseAdmin.storage.from(COMPANY_ASSETS_BUCKET).remove([path]);
    return { ok: false, error: "File exceeds the 2 MB limit." };
  }

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(COMPANY_ASSETS_BUCKET)
    .createSignedUrl(path, 60);
  if (signError || !signed?.signedUrl) {
    return { ok: false, error: "Could not verify the uploaded file." };
  }

  try {
    const headerRes = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-3" } });
    const headerBytes = new Uint8Array(await headerRes.arrayBuffer());
    let mimeType: AllowedLogoMimeType | null = null;
    if (
      headerBytes.length >= 4 &&
      headerBytes[0] === 0x89 &&
      headerBytes[1] === 0x50 &&
      headerBytes[2] === 0x4e &&
      headerBytes[3] === 0x47
    ) {
      mimeType = "image/png"; // \x89PNG
    } else if (headerBytes.length >= 3 && headerBytes[0] === 0xff && headerBytes[1] === 0xd8 && headerBytes[2] === 0xff) {
      mimeType = "image/jpeg"; // 0xFFD8FF
    }

    if (!mimeType) {
      await supabaseAdmin.storage.from(COMPANY_ASSETS_BUCKET).remove([path]);
      return { ok: false, error: "This file doesn't look like a valid PNG or JPG." };
    }

    return { ok: true, sizeBytes, mimeType };
  } catch {
    return { ok: false, error: "Could not read the uploaded file to verify it." };
  }
}

/** Removes an object — used only to clean up after a failed/rejected upload attempt, never to remove a logo that was ever actually attached to a profile. */
export async function removeCompanyAssetObject(path: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin.storage.from(COMPANY_ASSETS_BUCKET).remove([path]);
}

/** A short-lived signed URL for viewing a logo (settings page preview, or server-side download when rendering the PDF). */
export async function createSignedLogoViewUrl(path: string): Promise<string> {
  if (!supabaseAdmin) {
    throw new Error("Storage is not configured on the server (missing service role key).");
  }
  const { data, error } = await supabaseAdmin.storage
    .from(COMPANY_ASSETS_BUCKET)
    .createSignedUrl(path, SIGNED_LOGO_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Could not create a signed URL for this logo.");
  }
  return data.signedUrl;
}

/** Downloads a logo's raw bytes server-side (used when embedding it into the PDF — no signed URL round-trip needed there). */
export async function downloadCompanyLogoBytes(path: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.storage.from(COMPANY_ASSETS_BUCKET).download(path);
  if (error || !data) return null;
  const arrayBuffer = await data.arrayBuffer();
  return { bytes: new Uint8Array(arrayBuffer), mimeType: data.type || "image/png" };
}
