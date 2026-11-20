"use client";

/**
 * Small images made in the browser before an upload (and by "Make
 * thumbnails" for older photos):
 *  - Photos (PNG, JPG, WebP): a thumbnail JPG (long side at most 400 px), so
 *    the Assets grid never loads full-size originals.
 *  - HEIC: a JPG preview (about 0.85 quality, long side at most 2000 px)
 *    because only Safari can show HEIC, plus a 400 px thumbnail. The
 *    converter (heic-to, LGPL-3.0) loads only when a HEIC is chosen.
 *  - GIF: the first frame as a JPG poster (long side at most 800 px).
 *  - MP4 and MOV: a frame at 1 second (or the middle of a shorter clip) as a
 *    JPG poster, plus the duration.
 * The thumbnail or still frame is stored as the asset's poster
 * ("{path}.poster.jpg"); the HEIC JPG as its preview ("{path}.preview.jpg").
 * One conversion runs at a time to limit memory. A failed conversion leaves
 * the blobs null; the original is still uploaded.
 */
import type { FileKind } from "./fileKinds";

export type MediaPreview = {
  /** HEIC only: the full JPG preview. */
  preview: Blob | null;
  /** The small grid image: a photo thumbnail, or a GIF or video still frame. */
  poster: Blob | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  /** True when a HEIC, GIF or video got no preview to show (the grid shows a placeholder). */
  failed: boolean;
};

export const THUMB_MAX_SIDE = 400;

let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function toJpeg(source: CanvasImageSource, w: number, h: number, maxSide: number, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", quality));
}

const empty = (): MediaPreview => ({ preview: null, poster: null, width: null, height: null, duration_seconds: null, failed: false });

/** A 400 px JPG thumbnail of any image the browser can decode, or null. */
export async function makeThumbnail(file: Blob): Promise<{ blob: Blob | null; width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(file);
    const blob = await toJpeg(bitmap, bitmap.width, bitmap.height, THUMB_MAX_SIDE, 0.8);
    const out = { blob, width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return out;
  } catch {
    return { blob: null, width: null, height: null };
  }
}

async function photoThumb(file: Blob): Promise<MediaPreview> {
  const t = await makeThumbnail(file);
  return { ...empty(), poster: t.blob, width: t.width, height: t.height };
}

async function heicPreview(file: Blob): Promise<MediaPreview> {
  const out = empty();
  try {
    const { heicTo } = await import("heic-to/next");
    const bitmap = await heicTo({ blob: file, type: "bitmap" });
    out.width = bitmap.width;
    out.height = bitmap.height;
    out.preview = await toJpeg(bitmap, bitmap.width, bitmap.height, 2000, 0.85);
    out.poster = await toJpeg(bitmap, bitmap.width, bitmap.height, THUMB_MAX_SIDE, 0.8);
    bitmap.close?.();
  } catch {
    out.preview = null; // unusual or depth-based HEIC: keep the original, no preview
    out.poster = null;
  }
  out.failed = !out.preview;
  if (!out.preview) out.poster = null;
  return out;
}

async function gifPoster(file: Blob): Promise<MediaPreview> {
  const out = empty();
  try {
    const bitmap = await createImageBitmap(file); // the first frame
    out.width = bitmap.width;
    out.height = bitmap.height;
    out.poster = await toJpeg(bitmap, bitmap.width, bitmap.height, 800, 0.85);
    bitmap.close?.();
  } catch {
    out.poster = null;
  }
  out.failed = !out.poster;
  return out;
}

function waitFor(el: HTMLVideoElement, event: string, ms = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => done(new Error("timeout")), ms);
    const ok = () => done();
    const bad = () => done(new Error("decode"));
    function done(err?: Error) {
      clearTimeout(t);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", bad);
      if (err) reject(err);
      else resolve();
    }
    el.addEventListener(event, ok);
    el.addEventListener("error", bad);
  });
}

async function videoPoster(file: Blob): Promise<MediaPreview> {
  const out = empty();
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  try {
    video.src = url;
    await waitFor(video, "loadedmetadata");
    if (Number.isFinite(video.duration)) out.duration_seconds = Math.round(video.duration * 100) / 100;
    out.width = video.videoWidth || null;
    out.height = video.videoHeight || null;
    const at = video.duration >= 2 ? 1 : (video.duration || 0) / 2;
    video.currentTime = at;
    await waitFor(video, "seeked");
    if (!video.videoWidth || !video.videoHeight) throw new Error("no frame"); // e.g. HEVC the browser can't decode
    out.poster = await toJpeg(video, video.videoWidth, video.videoHeight, 800, 0.85);
  } catch {
    out.poster = null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
  out.failed = !out.poster;
  return out;
}

/** The preview and poster for a file of this kind, or null for kinds that need none (PDF). */
export function makeMediaPreview(file: Blob, kind: FileKind): Promise<MediaPreview | null> {
  if (kind === "image") return oneAtATime(() => photoThumb(file));
  if (kind === "heic") return oneAtATime(() => heicPreview(file));
  if (kind === "gif") return oneAtATime(() => gifPoster(file));
  if (kind === "mp4" || kind === "mov") return oneAtATime(() => videoPoster(file));
  return Promise.resolve(null);
}

/** For "Make thumbnails": one at a time, like uploads. */
export const makeThumbnailQueued = (file: Blob) => oneAtATime(() => makeThumbnail(file));
