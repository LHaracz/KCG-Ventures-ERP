/**
 * Asset names: the title people type when adding an asset, the "Name
 * pattern" helper for several files at once, and the download file name.
 * Pure functions, shared by the browser and the server.
 */

export const ASSET_NAME_MAX = 200;
export const DOWNLOAD_NAME_MAX = 120;

/** "IMG_4821.JPG" -> "IMG_4821", "a.b.png" -> "a.b". Only the last extension goes; ".env" and "notes" stay as they are. */
export function titleFromFileName(fileName: string): string {
  const name = fileName.trim();
  const m = /^(.+)\.[^.\s]+$/.exec(name);
  return (m ? m[1] : name).trim().slice(0, ASSET_NAME_MAX);
}

/** The error for a name, or null when it is fine (trimmed, 1 to 200 characters). */
export function assetNameError(name: string): string | null {
  const t = name.trim();
  if (!t) return "Enter a name.";
  if (t.length > ASSET_NAME_MAX) return `Keep the name to ${ASSET_NAME_MAX} characters or fewer.`;
  return null;
}

/**
 * Names for `count` rows, in order: "{n}" becomes 1, 2, 3...; without "{n}"
 * a space and the number are added at the end ("Gum flat lay" -> "Gum flat lay 1").
 */
export function applyNamePattern(pattern: string, count: number): string[] {
  const p = pattern.trim();
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push((p.includes("{n}") ? p.split("{n}").join(String(i)) : `${p} ${i}`).trim().slice(0, ASSET_NAME_MAX));
  return out;
}

/** True when another non-archived asset already has this name (ignoring case and outer spaces). */
export function hasDuplicateName(assets: ReadonlyArray<{ id: string; title: string; status: string }>, name: string, exceptId?: string | null): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return assets.some((a) => a.id !== exceptId && a.status !== "archived" && a.title.trim().toLowerCase() === n);
}

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" };

/** The extension from the stored file path, else from the MIME type, else "bin". */
export function assetExtension(filePath: string | null | undefined, mime: string | null | undefined): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(filePath ?? "");
  if (m) return m[1].toLowerCase();
  return MIME_EXT[mime ?? ""] ?? "bin";
}

/** "{title}.{ext}" without characters that are unsafe in file names; the title part is cut at 120 characters. */
export function safeDownloadName(title: string, ext: string): string {
  const base = title
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DOWNLOAD_NAME_MAX)
    .replace(/[. ]+$/, "")
    .trim();
  const e = ext.replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "bin";
  return `${base || "asset"}.${e}`;
}
