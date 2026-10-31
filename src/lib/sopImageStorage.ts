/**
 * Images inside SOP documents live in the private "sop-images" bucket.
 * Documents store only the bucket path; signed URLs are created at render
 * time, are short-lived, and are never written into the content.
 */
export const SOP_IMAGES_BUCKET = "sop-images";
export const MAX_SOP_IMAGE_BYTES = 10 * 1024 * 1024;
export const SOP_IMAGE_URL_TTL_SECONDS = 10 * 60;
export const SOP_IMAGE_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isAllowedImageMime(mime: string | null | undefined): boolean {
  return !!mime && mime.toLowerCase() in SOP_IMAGE_MIME;
}

/** Magic-byte check: PNG, JPEG or WebP. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

export function buildSopImagePath(sopId: string, mime: string): string {
  const ext = SOP_IMAGE_MIME[mime.toLowerCase()] ?? "bin";
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${sopId}/${id}.${ext}`;
}
