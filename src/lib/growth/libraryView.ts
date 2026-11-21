/**
 * Ad Library values computed in the browser from the loaded Marketing Hub
 * data (pure, tested): a post's hashtags and final caption (the same rule
 * the server uses), the Ready gate for warnings, the rows the table filters,
 * and what a calendar entry shows (live library values until it is Posted,
 * the frozen values after).
 */
import { hashPremadeText, premadeGateText, premadeReadyCheck, premadeScanText, scanBoth, type Hits, type ReadyBlocker } from "./adLibrary";
import type { LibPost } from "./libraryFilter";
import { composeFinalCaption, postHashtags } from "./naming";

/** The parts of the loaded data these helpers read. */
export type ViewData = {
  pillars: ReadonlyArray<{ id: string; code: string; name: string; archived_at: string | null }>;
  series: ReadonlyArray<{ id: string; pillar_id: string; code: string | null; name: string; default_hashtags: string | null; archived_at: string | null }>;
  products: ReadonlyArray<{ id: string; name: string }>;
  profiles: ReadonlyArray<{ formulation_product_id: string; hashtags: string | null }>;
  riskyWords: ReadonlyArray<{ phrase: string; archived_at: string | null }>;
  avoidPhrases: ReadonlyArray<{ phrase: string; archived_at: string | null }>;
  duplicateNames?: ReadonlyArray<{ name: string; post_ids: readonly string[] }>;
};
export type ViewPost = {
  id: string;
  category: "reel" | "picture_post";
  pillar_id: string;
  series_id: string | null;
  product_ids: readonly string[];
  hashtags: string | null;
  hook: string | null;
  caption: string | null;
  script_beats: ReadonlyArray<{ time?: string | null; beat: string }>;
  cta_text?: string | null;
  asset_needs: ReadonlyArray<{ key: string; label: string; kind: "graphic" | "photo" | "video" | "other"; status: "needed" | "ready"; asset_id?: string | null }>;
  needs_customer_permission: boolean;
  permission_confirmed_at: string | null;
  risky_ack_hash: string | null;
};

/** Each checked product's hashtags, in product-name order (as the server merges them). */
export function productHashtags(data: ViewData, productIds: readonly string[]): Array<string | null> {
  const tags = new Map(data.profiles.map((p) => [p.formulation_product_id, p.hashtags]));
  return data.products
    .filter((p) => productIds.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => tags.get(p.id) ?? null);
}

/** The hashtags posting adds: subtopic, then products, then the legacy extras. */
export function tagsForPost(data: ViewData, p: { series_id: string | null; product_ids: readonly string[]; hashtags: string | null }): string[] {
  const sub = p.series_id ? data.series.find((s) => s.id === p.series_id) : null;
  return postHashtags(sub?.default_hashtags ?? null, productHashtags(data, p.product_ids), p.hashtags);
}

/** The caption as it will be posted (body, two blank lines, hashtags). */
export const finalCaptionOf = (data: ViewData, p: { caption: string | null; series_id: string | null; product_ids: readonly string[]; hashtags: string | null }) =>
  composeFinalCaption(p.caption, tagsForPost(data, p));

const active = (list: ReadonlyArray<{ phrase: string; archived_at: string | null }>) => list.filter((w) => !w.archived_at).map((w) => w.phrase);

/** Watch-word and avoid-list matches in any text. */
export const hitsIn = (data: ViewData, text: string): Hits => scanBoth(text, active(data.riskyWords), active(data.avoidPhrases));

/** The gate's hits, hash and blockers, on the final caption (like the server). */
export function gateView(data: ViewData, p: ViewPost): { hits: Hits; hash: string; blockers: ReadyBlocker[]; finalCaption: string } {
  const finalCaption = finalCaptionOf(data, p);
  const text = premadeGateText({ hook: p.hook, caption: p.caption, script_beats: [...p.script_beats] }, finalCaption);
  const hits = hitsIn(data, premadeScanText(text));
  const hash = hashPremadeText(text);
  const blockers = premadeReadyCheck({
    premade: { ...p, script_beats: [...p.script_beats], asset_needs: [...p.asset_needs] },
    hits,
    currentTextHash: hash,
  });
  return { hits, hash, blockers, finalCaption };
}

/** A row the Ad Library filters and shows. */
export type LibRow<T> = LibPost & { post: T; tags: string[]; hits: Hits; pillarName: string };

/** Library posts prepared for libraryFilter (topic and subtopic codes, attention counts, duplicates). */
export function toLibRows<
  T extends ViewPost & {
    status: string;
    intent: string;
    archived_at: string | null;
    created_at: string;
    name: string;
    post_number: number | null;
    title: string | null;
    name_history: ReadonlyArray<{ name: string }>;
    flags: ReadonlyArray<{ flag_key: string; dismissed_at: string | null }>;
    next_scheduled: string | null;
    last_posted: string | null;
  },
>(data: ViewData, posts: readonly T[]): Array<LibRow<T>> {
  const pillar = new Map(data.pillars.map((p) => [p.id, p]));
  const sub = new Map(data.series.map((s) => [s.id, s]));
  const dupes = new Set((data.duplicateNames ?? []).flatMap((d) => d.post_ids));
  return posts.map((p) => {
    const g = gateView(data, p);
    const s = p.series_id ? sub.get(p.series_id) : undefined;
    return {
      id: p.id,
      category: p.category,
      status: p.status,
      intent: p.intent,
      pillar_id: p.pillar_id,
      series_id: p.series_id,
      archived_at: p.archived_at,
      created_at: p.created_at,
      name: p.name,
      pillarCode: pillar.get(p.pillar_id)?.code ?? "?",
      pillarName: pillar.get(p.pillar_id)?.name ?? "",
      subtopicCode: s?.code ?? null,
      subtopicName: s?.name ?? null,
      post_number: p.post_number,
      title: p.title,
      name_history: p.name_history,
      caption: p.caption,
      product_ids: p.product_ids,
      openNeeds: p.asset_needs.filter((n) => n.status !== "ready").length,
      needsPermission: p.needs_customer_permission && !p.permission_confirmed_at,
      avoidHits: g.hits.avoid.length,
      watchHits: g.hits.risky.length,
      openFlagKeys: p.flags.filter((f) => !f.dismissed_at).map((f) => f.flag_key),
      duplicate: dupes.has(p.id),
      scheduled: !!(p.next_scheduled || p.last_posted),
      post: p,
      tags: tagsForPost(data, p),
      hits: g.hits,
    };
  });
}

// --- Calendar entries -----------------------------------------------------------------------------------
export type EntryLike = { title: string; caption: string | null; hashtags: string | null; status: string; premade_post_id: string | null };
export type EntryPremade = { id: string; name: string; caption: string | null; series_id: string | null; product_ids: readonly string[]; hashtags: string | null };

/**
 * What a calendar entry shows. Library entries that aren't Posted read the
 * library post live (its current name and final caption; the stored title is
 * only a fallback). Posted entries, and entries without a library post, show
 * what is stored.
 */
export function entryView(data: ViewData, entry: EntryLike, premades: ReadonlyArray<EntryPremade>): { name: string; caption: string; live: boolean } {
  const p = entry.premade_post_id ? premades.find((x) => x.id === entry.premade_post_id) : undefined;
  if (p && entry.status !== "posted") return { name: p.name, caption: finalCaptionOf(data, p), live: true };
  const stored = [entry.caption ?? "", entry.hashtags ?? ""].filter((x) => x.trim()).join("\n\n");
  return { name: entry.title, caption: stored, live: false };
}
