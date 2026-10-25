/**
 * Shared server-side helpers for the SOP Library's Storage integration.
 * Every call here uses `supabaseAdmin` (the service role key) — the
 * `sops` bucket is private and nothing client-side ever talks to Storage
 * directly except via `uploadToSignedUrl`, whose token already carries
 * its own authorization.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const SOPS_BUCKET = "sops";
export const MAX_SOP_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const SIGNED_VIEW_URL_TTL_SECONDS = 10 * 60; // 10 minutes

export function isPdfFilename(filename: string): boolean {
  return filename.toLowerCase().trim().endsWith(".pdf");
}

export function isPdfMimeType(mimeType: string | null | undefined): boolean {
  return (mimeType || "").toLowerCase() === "application/pdf";
}

/** Builds a Storage path that never collides, independent of any DB id. */
export function buildSopStoragePath(originalFilename: string, sopId?: string): string {
  const safeName =
    originalFilename
      .replace(/[^a-zA-Z0-9.\-_]/g, "_")
      .slice(-120) || "file.pdf";
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${sopId || "pending"}/${randomId}-${safeName}`;
}

export type VerifyUploadResult =
  | { ok: true; sizeBytes: number }
  | { ok: false; error: string };

/**
 * Authoritative post-upload validation, run only after the browser has
 * already PUT the file to its signed upload URL. Confirms the object is
 * really there, re-checks its size against the 25 MB cap using Storage's
 * own metadata (never the client's claimed size), and reads just its
 * first few bytes over HTTP Range to confirm the "%PDF" magic number —
 * never downloads the whole file to do this. Removes the object from
 * Storage if it fails either check, so a bad upload doesn't leave an
 * orphaned file (or a DB row) behind.
 */
export async function verifyUploadedPdf(path: string): Promise<VerifyUploadResult> {
  if (!supabaseAdmin) {
    return { ok: false, error: "Storage is not configured on the server (missing service role key)." };
  }

  const slashIndex = path.lastIndexOf("/");
  const dir = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;

  const { data: listing, error: listError } = await supabaseAdmin.storage
    .from(SOPS_BUCKET)
    .list(dir, { search: name, limit: 1 });
  if (listError) return { ok: false, error: listError.message };
  const found = listing?.find((f) => f.name === name);
  if (!found) return { ok: false, error: "Uploaded file was not found in storage." };

  const sizeBytes = Number(found.metadata?.size ?? 0);
  if (!sizeBytes) return { ok: false, error: "Uploaded file is empty." };
  if (sizeBytes > MAX_SOP_FILE_BYTES) {
    await supabaseAdmin.storage.from(SOPS_BUCKET).remove([path]);
    return { ok: false, error: "File exceeds the 25 MB limit." };
  }

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(SOPS_BUCKET)
    .createSignedUrl(path, 60);
  if (signError || !signed?.signedUrl) {
    return { ok: false, error: "Could not verify the uploaded file." };
  }

  try {
    const headerRes = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-3" } });
    const headerBytes = new Uint8Array(await headerRes.arrayBuffer());
    const header = new TextDecoder().decode(headerBytes);
    if (header !== "%PDF") {
      await supabaseAdmin.storage.from(SOPS_BUCKET).remove([path]);
      return { ok: false, error: "This file doesn't look like a valid PDF." };
    }
  } catch {
    return { ok: false, error: "Could not read the uploaded file to verify it." };
  }

  return { ok: true, sizeBytes };
}

/** Removes an object — used to clean up after a failed/rolled-back upload. */
export async function removeSopObject(path: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin.storage.from(SOPS_BUCKET).remove([path]);
}

/**
 * A short-lived signed URL for viewing (inline) or downloading a version's
 * file. Pass `downloadFilename` to force a Content-Disposition attachment
 * with that filename (used by the Download button); omit it for inline
 * viewing in the PDF viewer.
 */
export async function createSignedViewUrl(path: string, downloadFilename?: string): Promise<string> {
  if (!supabaseAdmin) {
    throw new Error("Storage is not configured on the server (missing service role key).");
  }
  const { data, error } = await supabaseAdmin.storage
    .from(SOPS_BUCKET)
    .createSignedUrl(path, SIGNED_VIEW_URL_TTL_SECONDS, downloadFilename ? { download: downloadFilename } : undefined);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Could not create a signed URL for this file.");
  }
  return data.signedUrl;
}
