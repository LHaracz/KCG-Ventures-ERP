/**
 * Parsers used by the one-time playbook import (and by the editor for
 * durations). Pure and tested with invented text. The rules for autoFixText
 * are passed in as data; none are stored in the code.
 */
import type { AssetNeed } from "./adLibrary";

// --- Durations -------------------------------------------------------------------------------------
const clock = (s: string): number | null => {
  const m = /^(\d{1,2}):([0-5]?\d|60)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** "0:20–0:35" (en dash, em dash or hyphen) -> { min: 20, max: 35 }; "0:15" -> { min: 15, max: 15 }; otherwise null. */
export function parseDuration(text: string | null | undefined): { min: number; max: number } | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const parts = t.split(/\s*[–—-]\s*/);
  if (parts.length === 1) {
    const v = clock(parts[0]);
    return v === null ? null : { min: v, max: v };
  }
  if (parts.length !== 2) return null;
  const a = clock(parts[0]);
  const b = clock(parts[1]);
  if (a === null || b === null || a > b) return null;
  return { min: a, max: b };
}

// --- Visual notes -------------------------------------------------------------------------------------
export const PRODUCT_KEYS = ["gum", "toothpaste", "bundle", "mouth_rinse", "fresh_breath"] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];
export const PRODUCT_KEY_LABEL: Record<ProductKey, string> = {
  gum: "Gum",
  toothpaste: "Toothpaste",
  bundle: "Bundle",
  mouth_rinse: "Mouth rinse",
  fresh_breath: "Fresh breath",
};
const PRODUCT_PATTERNS: Array<[RegExp, ProductKey]> = [
  [/\b(?:MM|MOUTH)\s+RINSE\b/i, "mouth_rinse"],
  [/\bB?UNDLE\b/i, "bundle"],
  [/\bGUM\b/i, "gum"],
  [/\bTP\b|\bTOOTHPASTE\b/i, "toothpaste"],
  [/\bDROPS?\b|\bSPRAY\b/i, "fresh_breath"],
];
const productsIn = (s: string): ProductKey[] => PRODUCT_PATTERNS.filter(([re]) => re.test(s)).map(([, k]) => k);

/**
 * "INFO GRAPHIC - GUM PROD PIC" -> needs graphic:info and photo:gum_product,
 * products [gum]. Text with no GRAPHIC or PIC part comes back as a note with
 * no needs.
 */
export function parseVisualNote(text: string | null | undefined): { needs: AssetNeed[]; products: ProductKey[]; note: string | null } {
  const raw = (text ?? "").trim();
  if (!raw) return { needs: [], products: [], note: null };
  const needs: AssetNeed[] = [];
  const products = new Set<ProductKey>();
  const add = (n: AssetNeed) => {
    if (!needs.some((x) => x.key === n.key)) needs.push(n);
  };
  for (const seg of raw.split(/\s+[-–—]\s+|\s*\/\s*|\s*,\s*/)) {
    const s = seg.trim();
    if (!s) continue;
    const g = /^(.*?)\s*GRAPHIC\b/i.exec(s) ?? (/\bINFOGRAPHIC\b/i.test(s) ? ["", "INFO"] : null);
    if (g) {
      const word = (g[1] || "").replace(/[^A-Za-z0-9 ]/g, "").trim().toLowerCase().replace(/\s+/g, "_") || "general";
      add({ key: `graphic:${word}`, label: `${word.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} graphic`, kind: "graphic", status: "needed", asset_id: null, note: null });
    }
    if (/\b(?:PIC|PICS|PHOTO|PHOTOS|PICTURE)\b/i.test(s)) {
      const ps = productsIn(s);
      ps.forEach((p) => products.add(p));
      if (ps.length === 0) add({ key: "photo:general", label: "Photo", kind: "photo", status: "needed", asset_id: null, note: null });
      for (const p of ps) add({ key: `photo:${p}_product`, label: `${PRODUCT_KEY_LABEL[p]} product photo`, kind: "photo", status: "needed", asset_id: null, note: null });
    }
    productsIn(s).forEach((p) => products.add(p));
  }
  if (needs.length === 0) return { needs: [], products: [], note: raw };
  return { needs, products: [...products], note: null };
}

/** Product key for a product name ("… Gum" -> gum), used to match asset product tags to an item's products. */
export function productKeyForName(name: string): ProductKey | null {
  const n = name.toLowerCase();
  if (/\bbundle\b|\bkit\b/.test(n)) return "bundle";
  if (/\brinse\b|\bmouthwash\b/.test(n)) return "mouth_rinse";
  if (/\bgum\b/.test(n)) return "gum";
  if (/\btoothpaste\b|\bpaste\b/.test(n)) return "toothpaste";
  if (/\bbreath\b|\bspray\b|\bdrops?\b/.test(n)) return "fresh_breath";
  return null;
}

// --- Closing lines -------------------------------------------------------------------------------------
/** Trims, collapses whitespace and strips a trailing code such as " - AB1-12". Emoji are kept. */
export function normalizeClosingLine(text: string | null | undefined): { text: string; code: string | null } {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const m = /\s+[-–—]\s+([A-Z]{1,4}\d+(?:\s*[-–]\s*[A-Z]{0,4}\d+)*)$/.exec(t);
  if (!m) return { text: t, code: null };
  return { text: t.slice(0, m.index).trim(), code: m[1].replace(/\s+/g, "") };
}

// --- Auto-fix ------------------------------------------------------------------------------------------
export type FixRule = { from: string; to: string; kind: "typo" | "product_rename"; matchCase?: boolean };
export type FixChange = { kind: FixRule["kind"]; before: string; after: string; context: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isUpper = (w: string) => w === w.toUpperCase() && w !== w.toLowerCase();
const isLower = (w: string) => w === w.toLowerCase() && w !== w.toUpperCase();
const isCap = (w: string) => w.length > 0 && isUpper(w[0]) && (w.length === 1 || isLower(w.slice(1)) || w.slice(1) === w.slice(1).toLowerCase());

function caseWord(src: string, dst: string): string {
  const letters = src.replace(/[^\p{L}]/gu, "");
  if (!letters) return dst;
  if (letters.length > 1 && isUpper(letters)) return dst.toUpperCase();
  if (isLower(letters)) return dst.toLowerCase();
  if (isCap(letters)) return dst.charAt(0).toUpperCase() + dst.slice(1).toLowerCase();
  return dst;
}
/** Keeps the case pattern of the matched text (word by word when the word counts agree). */
export function keepCase(matched: string, replacement: string): string {
  const a = matched.split(/(\s+)/);
  const b = replacement.split(/(\s+)/);
  if (a.length === b.length) return b.map((w, i) => (/^\s+$/.test(w) ? w : caseWord(a[i], w))).join("");
  return caseWord(matched, replacement);
}

function sentenceAround(text: string, index: number, length: number): string {
  const stop = (c: string | undefined) => c === "." || c === "!" || c === "?" || c === "\n";
  let s = index;
  while (s > 0 && !stop(text[s - 1])) s--;
  let e = index + length;
  while (e < text.length && !stop(text[e])) e++;
  if (e < text.length && text[e] !== "\n") e++;
  return text.slice(s, e).trim();
}

/**
 * Applies the rules in order. Whole-word matches only; case is kept
 * ("DROPS" -> "SPRAY", "Drops" -> "Spray"). With matchCase, only the exact
 * case of `from` matches. Every change is returned with its sentence.
 */
export function autoFixText(text: string | null | undefined, rules: readonly FixRule[]): { text: string; changes: FixChange[] } {
  let t = text ?? "";
  const changes: FixChange[] = [];
  if (!t) return { text: t, changes };
  for (const r of rules) {
    if (!r.from) continue;
    const body = r.from.split(/\s+/).map(escapeRe).join("\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}_#'’])${body}(?![\\p{L}\\p{N}_'’])`, r.matchCase ? "gu" : "giu");
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    const pending: Array<{ index: number; before: string; after: string }> = [];
    while ((m = re.exec(t))) {
      const after = r.matchCase ? r.to : keepCase(m[0], r.to);
      if (after !== m[0]) pending.push({ index: m.index, before: m[0], after });
      out += t.slice(last, m.index) + after;
      last = m.index + m[0].length;
    }
    if (!pending.length) continue;
    const next = out + t.slice(last);
    let shift = 0;
    for (const p of pending) {
      const at = p.index + shift;
      changes.push({ kind: r.kind, before: p.before, after: p.after, context: sentenceAround(next, at, p.after.length) });
      shift += p.after.length - p.before.length;
    }
    t = next;
  }
  return { text: t, changes };
}
