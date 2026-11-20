"use client";

/**
 * Preview images made in the browser before an upload:
 *  - HEIC: a JPG (about 0.85 quality, long side at most 2000 px), because only
 *    Safari can show HEIC. The converter (heic-to, LGPL-3.0) loads only when
 *    a HEIC is chosen.
 *  - GIF: the first frame as a JPG poster (long side at most 800 px).
 *  - MP4 and MOV: a frame at 1 second (or the middle of a shorter clip) as a JPG
 *    poster, plus the duration.
 * One conversion runs at a time to limit memory. A failed conversion returns
 * blob: null; the original is still uploaded and shows a placeholder.
 */
import type { FileKind } from "./fileKinds";

export type MediaPreview = {
  extra: "preview" | "poster";
  blob: Blob | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
};

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

async function heicPreview(file: Blob): Promise<MediaPreview> {
  const out: MediaPreview = { extra: "preview", blob: null, width: null, height: null, duration_seconds: null };
  try {
    const { heicTo } = await import("heic-to/next");
    const bitmap = await heicTo({ blob: file, type: "bitmap" });
    out.width = bitmap.width;
    out.height = bitmap.height;
    out.blob = await toJpeg(bitmap, bitmap.width, bitmap.height, 2000, 0.85);
    bitmap.close?.();
  } catch {
    out.blob = null; // unusual or depth-based HEIC: keep the original, no preview
  }
  return out;
}

async function gifPoster(file: Blob): Promise<MediaPreview> {
  const out: MediaPreview = { extra: "poster", blob: null, width: null, height: null, duration_seconds: null };
  try {
    const bitmap = await createImageBitmap(file); // the first frame
    out.width = bitmap.width;
    out.height = bitmap.height;
    out.blob = await toJpeg(bitmap, bitmap.width, bitmap.height, 800, 0.85);
    bitmap.close?.();
  } catch {
    out.blob = null;
  }
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
  const out: MediaPreview = { extra: "poster", blob: null, width: null, height: null, duration_seconds: null };
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
    out.blob = await toJpeg(video, video.videoWidth, video.videoHeight, 800, 0.85);
  } catch {
    out.blob = null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
  return out;
}

/** The preview or poster for a file of this kind, or null for kinds that need none. */
export function makeMediaPreview(file: Blob, kind: FileKind): Promise<MediaPreview | null> {
  if (kind === "heic") return oneAtATime(() => heicPreview(file));
  if (kind === "gif") return oneAtATime(() => gifPoster(file));
  if (kind === "mp4" || kind === "mov") return oneAtATime(() => videoPoster(file));
  return Promise.resolve(null);
}
