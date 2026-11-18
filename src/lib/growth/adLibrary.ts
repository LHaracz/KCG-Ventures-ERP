/**
 * Ad Library pure helpers (tested): display names and auto titles, the text
 * hash behind the "words reviewed" acknowledgement, the Ready gate for a
 * library item, live avoid-list and watch-word matches, asset needs, and
 * the alphabetical re-lettering preview.
 */
import { scanText, type ScanMatch } from "./text";

export type PremadeCategory = "reel" | "picture_post";
export type PremadeStatus = "idea" | "drafting" | "ready" | "paused";
export type PremadeIntent = "organic" | "paid" | "both";
export type PictureFormat = "carousel" | "single_image" | "story" | "unknown";
export type NeedKind = "graphic" | "photo" | "video" | "other";
export type ScriptBeat = { time?: string | null; beat: string };
export type AssetNeed = { key: string; label: string; kind: NeedKind; status: "needed" | "ready"; asset_id?: string | null; note?: string | null };

export const PREMADE_STATUSES: PremadeStatus[] = ["idea", "drafting", "ready", "paused"];
export const PREMADE_INTENTS: PremadeIntent[] = ["organic", "paid", "both"];
export const LIBRARY_PLATFORMS = ["instagram", "tiktok", "facebook", "youtube"] as const;
export type LibraryPlatform = (typeof LIBRARY_PLATFORMS)[number];
export const FLAG_KEYS = ["auto_name", "pillar_assigned", "format_review", "product_renamed", "typo_fixed"] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];
export const FLAG_LABEL: Record<FlagKey, string> = {
  auto_name: "Auto name",
  pillar_assigned: "Pillar assigned by import",
  format_review: "Check format",
  product_renamed: "Product renamed",
  typo_fixed: "Typo fixed",
};

// --- Names -------------------------------------------------------------------------------------
export const displayName = (code: string, title: string) => `${code} - ${title}`;

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu;
const tidy = (s: string) => s.replace(EMOJI, "").replace(/\s+/g, " ").trim();
export const AUTO_TITLE_MAX = 120;

/** "{series} #{n} ({hook})", emoji removed, at most 120 characters (the hook is cut at a word boundary). */
export function buildAutoTitle(seriesName: string, n: number, hook: string | null | undefined): string {
  const base = `${tidy(seriesName)} #${n}`;
  const h = tidy(hook ?? "");
  if (!h) return base.slice(0, AUTO_TITLE_MAX);
  const room = AUTO_TITLE_MAX - base.length - 3; // " (" + ")"
  if (room < 2) return base.slice(0, AUTO_TITLE_MAX);
  if (h.length <= room) return `${base} (${h})`;
  const cut = h.slice(0, room - 1);
  const space = cut.lastIndexOf(" ");
  const word = (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "");
  return `${base} (${word}…)`;
}

// --- Text hash (stable, used for the words-reviewed acknowledgement) ---------------------------------
export type PremadeText = { hook?: string | null; caption?: string | null; script_beats?: readonly ScriptBeat[] | null };

/** A stable hash of hook, caption and script beats (FNV-1a, two 32-bit lanes, hex). */
export function hashPremadeText(p: PremadeText): string {
  const s = JSON.stringify([p.hook ?? "", p.caption ?? "", (p.script_beats ?? []).map((b) => [b.time ?? "", b.beat ?? ""])]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 13;
  }
  return `${h1.toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

// --- Watch words and avoid list ------------------------------------------------------------------------
export type Hits = { risky: ScanMatch[]; avoid: ScanMatch[] };

/** Matches from both lists (case-insensitive, whole word or phrase). A phrase in both lists appears in both. */
export function scanBoth(text: string | null | undefined, riskyPhrases: readonly string[], avoidPhrases: readonly string[]): Hits {
  return { risky: scanText(text, riskyPhrases), avoid: scanText(text, avoidPhrases) };
}

/** The text that is scanned for an item: hook, caption and every script beat. */
export const premadeScanText = (p: PremadeText) => [p.hook ?? "", p.caption ?? "", ...(p.script_beats ?? []).map((b) => b.beat ?? "")].join("\n");

// --- Ready gate ----------------------------------------------------------------------------------------
export type ReadyBlocker = { key: string; message: string };
export type PremadeForGate = PremadeText & {
  category: PremadeCategory;
  cta_text?: string | null;
  asset_needs?: readonly AssetNeed[] | null;
  needs_customer_permission?: boolean | null;
  permission_confirmed_at?: string | null;
  risky_ack_hash?: string | null;
};

export function premadeReadyCheck(args: {
  premade: PremadeForGate;
  selectedClaims: ReadonlyArray<{ claim_text: string; status: string }>;
  hits: Hits;
  currentTextHash: string;
}): ReadyBlocker[] {
  const { premade: p, selectedClaims, hits, currentTextHash } = args;
  const out: ReadyBlocker[] = [];
  const has = (v: string | null | undefined) => !!(v ?? "").trim();
  if (p.category === "reel") {
    if (!has(p.hook)) out.push({ key: "hook", message: "Write the hook." });
    if (!(p.script_beats ?? []).some((b) => has(b.beat))) out.push({ key: "beats", message: "Add at least one script beat." });
    if (!has(p.cta_text)) out.push({ key: "cta", message: "Add the call to action (CTA)." });
  } else if (!has(p.caption)) out.push({ key: "caption", message: "Write the caption." });
  const unapproved = selectedClaims.filter((c) => c.status !== "approved");
  if (unapproved.length) out.push({ key: "claims", message: `These claims aren't approved: ${unapproved.map((c) => `"${c.claim_text}"`).join(", ")}.` });
  const open = (p.asset_needs ?? []).filter((n) => n.status !== "ready");
  if (open.length) out.push({ key: "needs", message: `${open.length} asset${open.length === 1 ? " is" : "s are"} still needed: ${open.map((n) => n.label).join(", ")}.` });
  if (p.needs_customer_permission && !p.permission_confirmed_at) out.push({ key: "permission", message: "Confirm the customer's permission first." });
  if ((hits.risky.length || hits.avoid.length) && p.risky_ack_hash !== currentTextHash) {
    const words = [...hits.avoid.map((h) => h.phrase), ...hits.risky.map((h) => h.phrase)];
    out.push({ key: "words", message: `Review these words and tick "Words reviewed": ${[...new Set(words)].join(", ")}.` });
  }
  return out;
}

// --- Needs ---------------------------------------------------------------------------------------------
export type NeedItem = { id: string; asset_needs: readonly AssetNeed[] };
export type MergedNeed = { key: string; label: string; kind: NeedKind; count: number; readyCount: number; status: "needed" | "ready" | "mixed"; itemIds: string[] };

/** Groups needs across items by key, with counts and an overall status. */
export function mergeNeeds(items: readonly NeedItem[]): MergedNeed[] {
  const by = new Map<string, MergedNeed>();
  for (const it of items) {
    for (const n of it.asset_needs ?? []) {
      const m = by.get(n.key) ?? { key: n.key, label: n.label, kind: n.kind, count: 0, readyCount: 0, status: "needed" as const, itemIds: [] };
      m.count += 1;
      if (n.status === "ready") m.readyCount += 1;
      if (!m.itemIds.includes(it.id)) m.itemIds.push(it.id);
      by.set(n.key, m);
    }
  }
  return [...by.values()]
    .map((m) => ({ ...m, status: m.readyCount === 0 ? ("needed" as const) : m.readyCount === m.count ? ("ready" as const) : ("mixed" as const) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Sets need `key` to ready with the asset on the listed items only. Returns new item objects (others unchanged). */
export function applyAssetToNeed<T extends NeedItem>(items: readonly T[], key: string, assetId: string, itemIds: readonly string[]): T[] {
  return items.map((it) =>
    itemIds.includes(it.id) && it.asset_needs.some((n) => n.key === key)
      ? { ...it, asset_needs: it.asset_needs.map((n) => (n.key === key ? { ...n, status: "ready" as const, asset_id: assetId } : n)) }
      : it,
  );
}

/** Undoes applyAssetToNeed on the listed items: the need goes back to needed with no asset. */
export function unlinkAssetFromNeed<T extends NeedItem>(items: readonly T[], key: string, itemIds: readonly string[]): T[] {
  return items.map((it) =>
    itemIds.includes(it.id) && it.asset_needs.some((n) => n.key === key)
      ? { ...it, asset_needs: it.asset_needs.map((n) => (n.key === key ? { ...n, status: "needed" as const, asset_id: null } : n)) }
      : it,
  );
}

// --- Re-lettering --------------------------------------------------------------------------------------
export type PillarLite = { id: string; code: string; name: string; archived_at?: string | null };
export type ReletterPlan = {
  changes: Array<{ id: string; name: string; from: string; to: string }>;
  codes: Record<string, string>;
  affectedItems: Array<{ id: string; before: string; after: string }>;
};
const sortKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/** Proposes A, B, C… by pillar name (case and punctuation ignored). Changes nothing. Archived pillars are skipped. */
export function reletterAlphabetically(pillars: readonly PillarLite[], items: ReadonlyArray<{ id: string; pillar_id: string; title: string; archived_at?: string | null }> = []): ReletterPlan {
  const active = pillars.filter((p) => !p.archived_at);
  if (active.length > 26) throw new Error("There are more than 26 pillars; letters only go from A to Z.");
  const sorted = [...active].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)) || a.name.localeCompare(b.name));
  const codes: Record<string, string> = {};
  sorted.forEach((p, i) => (codes[p.id] = String.fromCharCode(65 + i)));
  const changes = sorted.filter((p) => p.code !== codes[p.id]).map((p) => ({ id: p.id, name: p.name, from: p.code, to: codes[p.id] }));
  const byId = new Map(active.map((p) => [p.id, p]));
  const affectedItems = items
    .filter((it) => !it.archived_at && byId.has(it.pillar_id) && byId.get(it.pillar_id)!.code !== codes[it.pillar_id])
    .map((it) => ({ id: it.id, before: displayName(byId.get(it.pillar_id)!.code, it.title), after: displayName(codes[it.pillar_id], it.title) }));
  return { changes, codes, affectedItems };
}

/** The next free letter for a new pillar, or null when A to Z are all used. */
export function nextFreeCode(pillars: readonly PillarLite[]): string | null {
  const used = new Set(pillars.filter((p) => !p.archived_at).map((p) => p.code));
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    if (!used.has(c)) return c;
  }
  return null;
}
