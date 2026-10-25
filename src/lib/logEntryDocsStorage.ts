/**
 * Shared server-side helpers for the Compliance Logs "log-entry-docs"
 * Storage bucket — generalized from sopStorage.ts for any log entry's
 * file attachments (receiving's COA/SDS/invoice/spec-sheet uploads today;
 * log_entry_files itself is not receiving-specific, so this isn't either).
 * Every call here uses `supabaseAdmin` (the service role key) — the bucket
 * is private and nothing client-side talks to Storage directly except via
 * `uploadToSignedUrl`, whose token already carries its own authorization.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const LOG_ENTRY_DOCS_BUCKET = "log-entry-docs";
export const MAX_LOG_ENTRY_DOC_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const SIGNED_VIEW_URL_TTL_SECONDS = 10 * 60; // 10 minutes

export type AllowedDocMimeType = "application/pdf" | "image/png" | "image/jpeg";

const ALLOWED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"];
const ALLOWED_MIME_TYPES: AllowedDocMimeType[] = ["application/pdf", "image/png", "image/jpeg"];

export function isAllowedDocFilename(filename: string): boolean {
  const lower = filename.toLowerCase().trim();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isAllowedDocMimeType(mimeType: string | null | undefined): mimeType is AllowedDocMimeType {
  return ALLOWED_MIME_TYPES.includes((mimeType || "").toLowerCase() as AllowedDocMimeType);
}

/** Builds a Storage path that never collides, independent of any DB id. */
export function buildLogEntryDocStoragePath(originalFilename: string, logEntryId?: string): string {
  const safeName =
    originalFilename
      .replace(/[^a-zA-Z0-9.\-_]/g, "_")
      .slice(-120) || "file";
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${logEntryId || "pending"}/${randomId}-${safeName}`;
}

export type VerifyUploadResult =
  | { ok: true; sizeBytes: number; mimeType: AllowedDocMimeType }
  | { ok: false; error: string };

/**
 * Authoritative post-upload validation, run only after the browser has
 * already PUT the file to its signed upload URL. Confirms the object is
 * really there, re-checks its size against the 25 MB cap using Storage's
 * own metadata (never the client's claimed size), and reads just its first
 * few bytes over HTTP Range to confirm the real file type by magic number
 * (PDF "%PDF", PNG "\x89PNG", JPEG 0xFFD8FF) — never downloads the whole
 * file to do this. Removes the object from Storage if it fails any check,
 * so a bad upload doesn't leave an orphaned file (or a DB row) behind.
 */
export async function verifyUploadedLogEntryDoc(path: string): Promise<VerifyUploadResult> {
  if (!supabaseAdmin) {
    return { ok: false, error: "Storage is not configured on the server (missing service role key)." };
  }

  const slashIndex = path.lastIndexOf("/");
  const dir = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;

  const { data: listing, error: listError } = await supabaseAdmin.storage
    .from(LOG_ENTRY_DOCS_BUCKET)
    .list(dir, { search: name, limit: 1 });
  if (listError) return { ok: false, error: listError.message };
  const found = listing?.find((f) => f.name === name);
  if (!found) return { ok: false, error: "Uploaded file was not found in storage." };

  const sizeBytes = Number(found.metadata?.size ?? 0);
  if (!sizeBytes) return { ok: false, error: "Uploaded file is empty." };
  if (sizeBytes > MAX_LOG_ENTRY_DOC_FILE_BYTES) {
    await supabaseAdmin.storage.from(LOG_ENTRY_DOCS_BUCKET).remove([path]);
    return { ok: false, error: "File exceeds the 25 MB limit." };
  }

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(LOG_ENTRY_DOCS_BUCKET)
    .createSignedUrl(path, 60);
  if (signError || !signed?.signedUrl) {
    return { ok: false, error: "Could not verify the uploaded file." };
  }

  try {
    const headerRes = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-3" } });
    const headerBytes = new Uint8Array(await headerRes.arrayBuffer());
    let mimeType: AllowedDocMimeType | null = null;
    if (
      headerBytes.length >= 4 &&
      headerBytes[0] === 0x25 &&
      headerBytes[1] === 0x50 &&
      headerBytes[2] === 0x44 &&
      headerBytes[3] === 0x46
    ) {
      mimeType = "application/pdf"; // %PDF
    } else if (
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
      await supabaseAdmin.storage.from(LOG_ENTRY_DOCS_BUCKET).remove([path]);
      return { ok: false, error: "This file doesn't look like a valid PDF, PNG, or JPG." };
    }

    return { ok: true, sizeBytes, mimeType };
  } catch {
    return { ok: false, error: "Could not read the uploaded file to verify it." };
  }
}

/** Removes an object — used to clean up after a failed/rolled-back upload. */
export async function removeLogEntryDocObject(path: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin.storage.from(LOG_ENTRY_DOCS_BUCKET).remove([path]);
}

/**
 * A short-lived signed URL for viewing (inline) or downloading a file.
 * Pass `downloadFilename` to force a Content-Disposition attachment with
 * that filename (used by the Download button); omit it for inline viewing.
 */
export async function createSignedViewUrl(path: string, downloadFilename?: string): Promise<string> {
  if (!supabaseAdmin) {
    throw new Error("Storage is not configured on the server (missing service role key).");
  }
  const { data, error } = await supabaseAdmin.storage
    .from(LOG_ENTRY_DOCS_BUCKET)
    .createSignedUrl(path, SIGNED_VIEW_URL_TTL_SECONDS, downloadFilename ? { download: downloadFilename } : undefined);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Could not create a signed URL for this file.");
  }
  return data.signedUrl;
}
