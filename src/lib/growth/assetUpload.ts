"use client";

/**
 * The one upload helper for Marketing Hub assets (Add assets, several at
 * once, and "Upload and attach"): check the file by its first bytes and size,
 * make its preview or poster, upload the original and the JPG to signed
 * upload URLs (with progress), then let the server check and save it.
 */
import { SUPABASE_URL } from "@/lib/supabaseConfig";
import { GrowthApiError, assetUploadUrlApi, finalizeAssetApi, saveThumbnailApi, signedAssetUrlsApi, thumbnailUploadUrlApi } from "./client";
import { SNIFF_BYTES, detectFileKind, sizeError, type DetectedFile, type FileKind } from "./fileKinds";
import { makeMediaPreview, makeThumbnailQueued } from "./mediaPreview";
import type { Asset } from "./marketingService";

export const TOO_LARGE_FOR_PLAN = "This file is over your storage plan's limit. Ask an admin to check Storage settings, or paste a link.";

async function firstBytes(file: Blob): Promise<Uint8Array> {
  const part = file.slice(0, SNIFF_BYTES);
  if (typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(part);
  });
}

/** Checks a chosen file before anything is uploaded: what it really is, and its size limit. */
export async function checkUploadFile(file: File): Promise<{ ok: true; file: DetectedFile } | { ok: false; error: string }> {
  const r = detectFileKind({ name: file.name, declaredType: file.type, firstBytes: await firstBytes(file) });
  if (!r.ok) return r;
  const tooBig = sizeError(r.file.kind, file.size);
  return tooBig ? { ok: false, error: tooBig } : r;
}

/** The asset type a new upload starts with (the user can change it). */
export const defaultAssetType = (kind: FileKind) => (kind === "mp4" || kind === "mov" ? "video" : kind === "pdf" ? "document" : "photo");

/** PUT to a signed upload URL with progress. Replaceable in tests. */
export const uploadTransport = {
  put(url: string, body: Blob, contentType: string, onProgress?: (fraction: number) => void, upsert = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("content-type", contentType);
      xhr.setRequestHeader("x-upsert", upsert ? "true" : "false");
      xhr.setRequestHeader("cache-control", "max-age=3600");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        const text = xhr.responseText || "";
        if (xhr.status === 413 || /maximum allowed size|too large|payload too large/i.test(text)) return reject(new GrowthApiError(TOO_LARGE_FOR_PLAN, 413, null));
        reject(new GrowthApiError("The upload failed. Try again.", xhr.status || 500, null));
      };
      xhr.onerror = () => reject(new GrowthApiError("The upload failed (network). Try again.", 0, null));
      xhr.send(body);
    });
  },
};

const signedUploadUrl = (u: { path: string; token: string; signedUrl?: string | null }) =>
  u.signedUrl ?? `${SUPABASE_URL}/storage/v1/object/upload/sign/marketing-assets/${u.path}?token=${encodeURIComponent(u.token)}`;

export type UploadStage = "converting" | "uploading" | "saving";
export type UploadOptions = { onStage?: (s: UploadStage) => void; onProgress?: (fraction: number) => void };

/**
 * Uploads one file as an asset with the given fields (title, category, tags…).
 * Photos also get a small thumbnail for the grid. previewFailed is true when
 * a HEIC, GIF, MP4 or MOV was saved without its preview.
 */
export async function uploadAsset(file: File, meta: Record<string, unknown>, opts: UploadOptions = {}): Promise<{ asset: Asset; previewFailed: boolean }> {
  const checked = await checkUploadFile(file);
  if (!checked.ok) throw new GrowthApiError(checked.error, 400, null);
  const { kind, mime } = checked.file;
  opts.onStage?.("converting");
  const media = await makeMediaPreview(file, kind);
  const blobs: Array<{ kind: "preview" | "poster"; blob: Blob }> = [];
  if (media?.preview) blobs.push({ kind: "preview", blob: media.preview });
  if (media?.poster) blobs.push({ kind: "poster", blob: media.poster });
  const urls = await assetUploadUrlApi({ mime_type: mime, size_bytes: file.size, extras: blobs.map((b) => ({ kind: b.kind, size_bytes: b.blob.size })) });
  opts.onStage?.("uploading");
  await uploadTransport.put(signedUploadUrl(urls), file, mime, opts.onProgress);
  for (const b of blobs) {
    const u = urls.extras.find((x) => x.kind === b.kind);
    if (u) await uploadTransport.put(signedUploadUrl(u), b.blob, "image/jpeg");
  }
  opts.onStage?.("saving");
  const res = await finalizeAssetApi({
    ...meta,
    path: urls.path,
    mime_type: mime,
    preview_path: urls.extras.find((x) => x.kind === "preview")?.path ?? null,
    poster_path: urls.extras.find((x) => x.kind === "poster")?.path ?? null,
    width: media?.width ?? null,
    height: media?.height ?? null,
    duration_seconds: media?.duration_seconds ?? null,
  });
  return { asset: res.asset, previewFailed: !!media?.failed };
}

/**
 * "Make thumbnails": for each photo uploaded before thumbnails existed, the
 * browser downloads the photo (or a HEIC's JPG preview) once, makes a small
 * JPG and saves it. One at a time; a failure skips that photo and goes on.
 */
export async function makeMissingThumbnails(
  assets: ReadonlyArray<{ id: string; title: string; mime_type: string | null }>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ made: number; failed: string[] }> {
  const failed: string[] = [];
  let made = 0;
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    try {
      const isHeic = a.mime_type === "image/heic" || a.mime_type === "image/heif";
      const { urls } = await signedAssetUrlsApi([a.id], false, isHeic ? "preview" : "original");
      if (!urls[a.id]) throw new Error("not found");
      const res = await fetch(urls[a.id]);
      if (!res.ok) throw new Error("download");
      const thumb = await makeThumbnailQueued(await res.blob());
      if (!thumb.blob) throw new Error("decode");
      const up = await thumbnailUploadUrlApi(a.id);
      await uploadTransport.put(signedUploadUrl(up), thumb.blob, "image/jpeg", undefined, true);
      await saveThumbnailApi(a.id);
      made++;
    } catch {
      failed.push(a.title);
    }
    onProgress?.(i + 1, assets.length);
  }
  return { made, failed };
}
