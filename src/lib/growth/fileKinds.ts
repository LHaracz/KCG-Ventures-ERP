/**
 * Marketing Hub upload kinds: what a file really is (by its first bytes,
 * then its extension) and how big it may be. Shared by the browser (checks
 * before uploading) and the server (checks again after the upload).
 * The browser's declared type is never trusted: it is often empty for HEIC.
 */

export type FileKind = "image" | "pdf" | "heic" | "gif" | "mp4" | "mov";
export type DetectedFile = { kind: FileKind; mime: string; extension: string };
export type DetectResult = { ok: true; file: DetectedFile } | { ok: false; error: string };

const MB = 1024 * 1024;
/** Upload size limits per kind, in bytes. */
export const SIZE_LIMITS: Record<FileKind, number> = { image: 25 * MB, heic: 25 * MB, pdf: 25 * MB, gif: 50 * MB, mp4: 200 * MB, mov: 200 * MB };
/** The JPG preview (HEIC) or poster (GIF, MP4) stored next to an original. */
export const PREVIEW_MAX_BYTES = 10 * MB;
/** Bytes to read from the start of a file for detectFileKind. */
export const SNIFF_BYTES = 32;

export const sizeLimitFor = (kind: FileKind) => SIZE_LIMITS[kind];

const KIND_LABEL: Record<FileKind, string> = { image: "Image", pdf: "PDF", heic: "HEIC", gif: "GIF", mp4: "MP4", mov: "MOV" };
const mbText = (bytes: number) => `${Math.round(bytes / MB)} MB`;

/** Null when the size is fine, else the message to show. */
export function sizeError(kind: FileKind, size: number): string | null {
  if (!Number.isFinite(size) || size <= 0) return "The file is empty.";
  const max = sizeLimitFor(kind);
  if (size <= max) return null;
  if (kind === "mp4" || kind === "mov") return `${KIND_LABEL[kind]} files can be up to ${mbText(max)}. Paste a link for larger videos.`;
  return `${KIND_LABEL[kind]} files can be up to ${mbText(max)}.`;
}

/** Every MIME type that can be uploaded, with its storage extension. */
export const UPLOAD_MIME: Record<string, { kind: FileKind; extension: string }> = {
  "image/png": { kind: "image", extension: "png" },
  "image/jpeg": { kind: "image", extension: "jpg" },
  "image/webp": { kind: "image", extension: "webp" },
  "application/pdf": { kind: "pdf", extension: "pdf" },
  "image/heic": { kind: "heic", extension: "heic" },
  "image/heif": { kind: "heic", extension: "heif" },
  "image/gif": { kind: "gif", extension: "gif" },
  "video/mp4": { kind: "mp4", extension: "mp4" },
  "video/quicktime": { kind: "mov", extension: "mov" },
};

/** For the file input's accept attribute. */
export const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf,image/heic,image/heif,.heic,.heif,image/gif,video/mp4,.mp4,video/quicktime,.mov";

const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];
const MP4_BRANDS = ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "];

const ascii = (b: Uint8Array, from: number, to: number) => (b.length >= to ? String.fromCharCode(...b.slice(from, to)) : "");

/** Atoms an older QuickTime file may start with (no ftyp box); trusted only with a .mov extension. */
const QT_LEADING_ATOMS = ["moov", "mdat", "wide", "free", "skip", "pnot"];

/** A video in the ISO/QuickTime family whose brand alone doesn't say MP4 or MOV; the extension decides. */
const VIDEO_FAMILY = "video/*";

/** What the bytes say, or null. */
function sniff(b: Uint8Array, ext: string): { mime: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: "image/png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp" };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf" };
  const gif = ascii(b, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return { mime: "image/gif" };
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (HEIC_BRANDS.includes(brand)) return { mime: "image/heic" };
    if (MP4_BRANDS.includes(brand)) return { mime: "video/mp4" };
    if (brand === "qt  ") return { mime: "video/quicktime" };
    // Another brand (phones and cameras use many): only a video extension makes it a video.
    if (brand.length === 4 && (ext === "mov" || ext === "mp4")) return { mime: VIDEO_FAMILY };
  }
  if (ext === "mov" && QT_LEADING_ATOMS.includes(ascii(b, 4, 8))) return { mime: "video/quicktime" };
  return null;
}

/** The extension's MIME type, for the extensions we accept. */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
};
const extensionOf = (name: string) => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
};

/**
 * Decides by magic bytes first, then the extension. A file whose bytes and
 * extension disagree is rejected; so are QuickTime (MOV) and anything else.
 */
export function detectFileKind(input: { name: string; declaredType?: string | null; firstBytes: Uint8Array }): DetectResult {
  const ext = extensionOf(input.name);
  const extMime = EXT_MIME[ext] ?? null;
  const found = sniff(input.firstBytes, ext);
  if (!found) {
    if (extMime) return { ok: false, error: `This file isn't a real ${ext.toUpperCase()} file (its contents don't match the .${ext} extension).` };
    return { ok: false, error: "Only PNG, JPG, WebP, PDF, HEIC, GIF, MP4 and MOV files can be uploaded." };
  }
  let mime = found.mime;
  // A HEIC saved as .heif is stored as image/heif.
  if (mime === "image/heic" && extMime === "image/heif") mime = "image/heif";
  // MP4 and MOV are the same container family, and phones often write one
  // with the other's brand (for example an iPhone .mov with an "mp42" or
  // "isom" brand). For a video, the extension decides between the two.
  const isVideo = mime === "video/mp4" || mime === "video/quicktime" || mime === VIDEO_FAMILY;
  if (isVideo && (extMime === "video/mp4" || extMime === "video/quicktime")) mime = extMime;
  if (mime === VIDEO_FAMILY) return { ok: false, error: "Only PNG, JPG, WebP, PDF, HEIC, GIF, MP4 and MOV files can be uploaded." };
  if (extMime && extMime !== mime) {
    return { ok: false, error: `This file's contents don't match its .${ext} extension. Save it again with the right extension.` };
  }
  const { kind, extension } = UPLOAD_MIME[mime];
  return { ok: true, file: { kind, mime, extension } };
}

/** True for a JPEG (the preview and poster files). */
export const isJpegBytes = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
