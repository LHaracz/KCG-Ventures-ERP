// Ad Library server code against the real migrations in PGlite: pillars
// (letters, archive blocked while in use, move, re-letter), library items
// (names, the Ready gate and each blocker, the words-reviewed hash, back to
// Drafting, flags, duplicate, pause), bulk actions, closing lines, needs
// (attach with "also apply", unlink, custom needs), categorized assets and
// tags, Add to calendar and Update from library, posting windows, rhythm and
// the avoid list. Invented data only ("Pillar A", "Product A").
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  assetBulk,
  createPillar,
  createPremade,
  loadLibraryData,
  needsAction,
  needsGroupAction,
  premadeAction,
  premadeBulk,
  rawMaterialNames,
  reletterPillars,
  saveAvoidPhrase,
  saveClosingLine,
  saveIngredientTag,
  saveRhythm,
  scheduleFromLibrary,
  syncFromLibrary,
  tagsFromRawMaterials,
  updatePillar,
  updatePremade,
  updateWindow,
} from "@/lib/growth/libraryService";
import { createClaim, createLinkAsset, reviewClaim, updateAsset } from "@/lib/growth/marketingService";
import { hashPremadeText } from "@/lib/growth/adLibrary";
import type { Db } from "@/lib/growth/routeHelpers";

let pg: PGlite;
let db: Db;
let prodA: string;
let prodB: string;
let pilA: string;
let pilB: string;
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await pg.query<T>(sql, p)).rows;

/** PostgREST sends JSON for jsonb columns; the PGlite stand-in needs arrays there turned into JSON text. */
const JSONB = new Set(["script_beats", "asset_needs", "ranges", "detail"]);
function withJsonb(base: Db): Db {
  const fix = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, JSONB.has(k) && Array.isArray(v) ? JSON.stringify(v) : v]));
  return {
    ...base,
    rpc: base.rpc.bind(base),
    from(table: string) {
      const qb = base.from(table);
      for (const m of ["insert", "update", "upsert"] as const) {
        const orig = qb[m].bind(qb);
        qb[m] = (payload: Record<string, unknown> | Array<Record<string, unknown>>, ...rest: unknown[]) => orig(Array.isArray(payload) ? payload.map(fix) : fix(payload), ...rest);
      }
      return qb;
    },
  };
}

const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected an error").toBeTruthy();
  expect((err as Error).message).toMatch(re);
  return err as Error & { status?: number; fields?: Record<string, string> };
};
const item = async (id: string) => (await loadLibraryData(db)).premades.find((p) => p.id === id)!;
const reel = (over: Record<string, unknown> = {}) => ({
  category: "reel",
  title: "Reel A",
  pillar_id: pilA,
  hook: "A hook line",
  script_beats: [{ time: "0:00", beat: "Open on the product" }],
  cta_text: "Shop now",
  platforms: ["instagram", "tiktok"],
  ...over,
});

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql", "ad_library.sql", "marketing_assets_media.sql", "marketing_assets_mov.sql"]) await pg.exec(migration(f));
  db = withJsonb(pgliteSupabase(pg) as unknown as Db);
  prodA = (await q<{ id: string }>(`insert into formulation_products (name) values ('Product A Gum') returning id`))[0].id;
  prodB = (await q<{ id: string }>(`insert into formulation_products (name) values ('Product B Toothpaste') returning id`))[0].id;
  pilA = (await createPillar(db, { code: "B", name: "Pillar Beta" })).id;
  pilB = (await createPillar(db, { code: "A", name: "Pillar Alpha", recurring: true })).id;
}, 120_000);

describe("pillars", () => {
  it("unique letters and names; archive blocked while in use; move items; re-letter", async () => {
    await rejects(() => createPillar(db, { code: "B", name: "Another" }), /already uses that letter/);
    await rejects(() => createPillar(db, { code: "C", name: "pillar beta" }), /already has that name/);
    await rejects(() => createPillar(db, { code: "CC", name: "Bad" }), /missing or not valid/);
    const { id } = await createPremade(db, reel(), "Test Person");
    await rejects(() => updatePillar(db, pilA, { archive: true }), /1 library item uses this pillar/);
    expect(await updatePillar(db, pilA, { move_items_to: pilB })).toEqual({ moved: 1 });
    expect((await item(id)).display_name).toBe("A - Reel A");
    await updatePillar(db, pilA, { archive: true });
    // "Pillar Alpha" sorts first but already has A; with B archived nothing changes.
    expect((await reletterPillars(db, false)).changes).toEqual([]);
    await createPillar(db, { code: "D", name: "Pillar Charlie" });
    await updatePillar(db, pilB, { code: "Z", name: "Pillar Alpha" });
    const plan = await reletterPillars(db, false);
    expect(plan.changes.map((c) => `${c.from}>${c.to}`).sort()).toEqual(["D>B", "Z>A"]);
    expect(plan.affectedItems).toEqual([{ id, before: "Z - Reel A", after: "A - Reel A" }]);
    expect((await q(`select code from content_pillars where archived_at is null order by code`)).map((r) => r.code)).toEqual(["D", "Z"]); // preview changes nothing
    await reletterPillars(db, true);
    expect((await q(`select code, name from content_pillars where archived_at is null order by code`)).map((r) => `${r.code} ${r.name}`)).toEqual(["A Pillar Alpha", "B Pillar Charlie"]);
  });
});

describe("library items", () => {
  it("display names, unique titles per pillar, and Ready is never set on create", async () => {
    const { id } = await createPremade(db, reel({ status: "ready" }), "Test Person");
    const r = await item(id);
    expect(r).toMatchObject({ display_name: "B - Reel A", status: "drafting", created_by_name: "Test Person", platforms: ["instagram", "tiktok"] });
    expect(r.script_beats).toEqual([{ time: "0:00", beat: "Open on the product" }]);
    await rejects(() => createPremade(db, reel({ title: "reel a" }), null), /already exists in this pillar/);
    const other = await createPremade(db, reel({ pillar_id: pilB }), null); // same title, other pillar
    expect((await item(other.id)).display_name).toBe("A - Reel A");
    await rejects(() => createPremade(db, { ...reel(), category: "story" }, null), /Reel or Picture post/);
    const pic = await createPremade(db, { category: "picture_post", title: "Pic A", pillar_id: pilA, caption: "Hello", duration_text: "0:20-0:35" }, null);
    expect((await item(pic.id)).picture_format).toBe("unknown");
  });

  it("the Ready gate: each blocker, the words-reviewed hash, and back to Drafting on edit", async () => {
    const draft = await createClaim(db, { claim_text: "Claim draft" }, null);
    const { id } = await createPremade(db, reel({ hook: "", cta_text: "", script_beats: [], claim_ids: [draft.id], needs_customer_permission: true, asset_needs: [{ key: "photo:a", label: "Photo A", kind: "photo" }] }), null);
    const e = await rejects(() => updatePremade(db, id, reel({ status: "ready", claim_ids: [draft.id], needs_customer_permission: true, hook: "", cta_text: "", script_beats: [] }), null), /Not ready yet/);
    for (const m of [/Write the hook/, /at least one script beat/, /call to action/, /aren't approved: "Claim draft"/, /still needed: Photo A/, /customer's permission/]) expect(e.message).toMatch(m);
    // Fix everything but the words.
    await reviewClaim(db, draft.id, { action: "approve" }, "Admin A");
    const asset = await createLinkAsset(db, { title: "Video A", url: "https://video.example.test/a", category: "product", product_ids: [prodA] }, null);
    await needsAction(db, id, { op: "attach", key: "photo:a", asset_id: asset.id });
    await premadeAction(db, id, { action: "confirm_permission" }, "Test Person");
    const body = reel({ hook: "This will cure it", claim_ids: [draft.id], needs_customer_permission: true });
    await rejects(() => updatePremade(db, id, { ...body, status: "ready" }, null), /Review these words/);
    await updatePremade(db, id, { ...body, status: "drafting" }, null);
    const saved = await item(id);
    await rejects(() => premadeAction(db, id, { action: "ack_words", hash: "stale" }, "Test Person"), /text changed/);
    await premadeAction(db, id, { action: "ack_words", hash: hashPremadeText(saved) }, "Test Person");
    await updatePremade(db, id, { ...body, status: "ready" }, null);
    expect((await item(id)).status).toBe("ready");
    // Editing the text invalidates the acknowledgement: back to Drafting, with the reason.
    const r = await updatePremade(db, id, { ...body, hook: "This will cure it fast", status: "ready" }, null);
    expect(r.notice).toMatch(/Moved back to Drafting: .*Review these words/);
    expect((await item(id)).status).toBe("drafting");
  });

  it("flags: editing the title dismisses Auto name; dismiss records the name; duplicate, pause and archive", async () => {
    const { id } = await createPremade(db, reel(), null);
    await q(`insert into premade_post_flags (premade_post_id, flag_key, detail) values ($1, 'auto_name', '{}'), ($1, 'typo_fixed', '{"changes":[]}')`, [id]);
    await updatePremade(db, id, reel({ title: "Reel A renamed" }), "Test Person");
    await premadeAction(db, id, { action: "dismiss_flag", flag_key: "typo_fixed" }, "Test Person");
    const flags = (await item(id)).flags;
    expect(flags.map((f) => [f.flag_key, f.dismissed_by_name])).toEqual(expect.arrayContaining([["auto_name", "Test Person"], ["typo_fixed", "Test Person"]]));
    await rejects(() => premadeAction(db, id, { action: "dismiss_flag", flag_key: "typo_fixed" }, null), /not open/);
    await premadeAction(db, id, { action: "confirm_permission" }, "Test Person");
    const copy = await premadeAction(db, id, { action: "duplicate" }, "Test Person");
    const c = await item(copy.id);
    expect(c).toMatchObject({ title: "Reel A renamed (copy)", status: "drafting", permission_confirmed_at: null, risky_ack_hash: null });
    expect(c.flags).toEqual([]);
    await premadeAction(db, id, { action: "pause" }, null);
    expect((await item(id)).status).toBe("paused");
    await premadeAction(db, id, { action: "reactivate" }, null);
    expect((await item(id)).status).toBe("drafting");
    await premadeAction(db, id, { action: "archive" }, null);
    expect((await item(id)).archived_at).not.toBeNull();
  });

  it("bulk: set pillar checks collisions; dismissing a flag needs a note", async () => {
    const a = await createPremade(db, reel(), null);
    const b = await createPremade(db, reel({ pillar_id: pilB }), null);
    await rejects(() => premadeBulk(db, { ids: [a.id], action: "set_pillar", pillar_id: pilB }, null), /already exist in that pillar: "Reel A"/);
    await q(`insert into premade_post_flags (premade_post_id, flag_key) values ($1, 'pillar_assigned'), ($2, 'pillar_assigned')`, [a.id, b.id]);
    await rejects(() => premadeBulk(db, { ids: [a.id, b.id], action: "dismiss_flag", flag_key: "pillar_assigned" }, null), /short note/);
    await premadeBulk(db, { ids: [a.id, b.id], action: "dismiss_flag", flag_key: "pillar_assigned", note: "Checked the pillars" }, "Test Person");
    expect((await q(`select count(*)::int as n from premade_post_flags where dismissed_at is not null`))[0].n).toBe(2);
    await premadeBulk(db, { ids: [a.id, b.id], action: "pause" }, null);
    expect((await loadLibraryData(db)).premades.every((p) => p.status === "paused")).toBe(true);
  });

  it("closing lines are unique ignoring case and spacing", async () => {
    await saveClosingLine(db, null, { text: "See you  soon ✨", used_with_note: "X1" });
    await rejects(() => saveClosingLine(db, null, { text: "see you soon ✨" }), /already on the list/);
    const line = (await loadLibraryData(db)).closingLines[0];
    expect(line.text).toBe("See you soon ✨");
    await saveClosingLine(db, line.id, { archive: true });
    await saveClosingLine(db, null, { text: "See you soon ✨" }); // archived lines don't block
  });
});

describe("needs", () => {
  it("attach with 'also apply', unlink, custom needs", async () => {
    const need = { key: "cover:series_a", label: "Series A cover", kind: "graphic" };
    const a = await createPremade(db, reel({ asset_needs: [need] }), null);
    const b = await createPremade(db, reel({ title: "Reel B", asset_needs: [need] }), null);
    const c = await createPremade(db, reel({ title: "Reel C", asset_needs: [need] }), null);
    const asset = await createLinkAsset(db, { title: "Cover A", url: "https://files.example.test/cover", category: "other", context_label: "Series cover" }, null);
    await needsAction(db, a.id, { op: "attach", key: need.key, asset_id: asset.id, also_ids: [b.id] });
    const data = await loadLibraryData(db);
    const status = (id: string) => data.premades.find((p) => p.id === id)!.asset_needs[0];
    expect(status(a.id)).toMatchObject({ status: "ready", asset_id: asset.id });
    expect(status(b.id)).toMatchObject({ status: "ready", asset_id: asset.id });
    expect(status(c.id)).toMatchObject({ status: "needed" });
    expect(data.premades.find((p) => p.id === a.id)!.asset_ids).toEqual([asset.id]);
    await needsAction(db, a.id, { op: "unlink", key: need.key });
    expect((await item(a.id)).asset_needs[0]).toMatchObject({ status: "needed", asset_id: null });
    expect((await item(a.id)).asset_ids).toEqual([]);
    expect((await item(b.id)).asset_needs[0].status).toBe("ready");
    await needsAction(db, c.id, { op: "add", label: "Extra photo", kind: "photo" });
    expect((await item(c.id)).asset_needs.map((n) => n.key)).toEqual([need.key, "custom:extra_photo"]);
    await needsAction(db, c.id, { op: "remove", key: "custom:extra_photo" });
    const r = await needsGroupAction(db, { op: "attach", key: need.key, asset_id: asset.id, item_ids: [a.id, c.id] });
    expect(r.changed).toBe(2);
  });
});

describe("categorized assets", () => {
  it("validation per category, tags in the link tables, bulk set category, uncategorized legacy assets", async () => {
    const link = { title: "Photo A", url: "https://files.example.test/a" };
    await rejects(() => createLinkAsset(db, link, null), /missing or not valid/); // category required for new assets
    await rejects(() => createLinkAsset(db, { ...link, category: "product", product_ids: [prodA, prodB] }, null), /missing or not valid/);
    await rejects(() => createLinkAsset(db, { ...link, category: "group_product", product_ids: [prodA] }, null), /missing or not valid/);
    await rejects(() => createLinkAsset(db, { ...link, category: "other" }, null), /missing or not valid/);
    const tag = await saveIngredientTag(db, null, { name: "Ingredient A" }, "Test Person");
    await rejects(() => createLinkAsset(db, { ...link, category: "ingredient" }, null), /missing or not valid/);
    const ing = await createLinkAsset(db, { ...link, category: "ingredient", ingredient_ids: [tag.id], product_ids: [prodA] }, null);
    const lineup = await createLinkAsset(db, { ...link, title: "Lineup", category: "group_product", is_full_lineup: true }, null);
    const market = await createLinkAsset(db, { ...link, title: "Market", category: "market", shot_date: "2026-06-01" }, null);
    expect(ing.formulation_product_id).toBeNull(); // legacy column no longer written
    const data = await loadLibraryData(db);
    expect(data.assetProductLinks.filter((l) => l.asset_id === ing.id).map((l) => l.formulation_product_id)).toEqual([prodA]);
    expect(data.assetIngredientLinks.filter((l) => l.asset_id === ing.id).map((l) => l.ingredient_tag_id)).toEqual([tag.id]);
    // A legacy asset (no category) can be edited without choosing one.
    const legacy = (await q<{ id: string }>(`insert into marketing_assets (title, source, url, asset_type) values ('Legacy', 'link', 'https://files.example.test/l', 'photo') returning id`))[0].id;
    await updateAsset(db, legacy, { title: "Legacy renamed", url: "https://files.example.test/l" });
    const bulk = await assetBulk(db, { ids: [lineup.id, market.id, legacy], action: "set_category", category: "product", product_ids: [prodB] });
    expect(bulk).toMatchObject({ updated: 3, failed: [] });
    const bad = await assetBulk(db, { ids: [market.id], action: "set_category", category: "other" });
    expect(bad.updated).toBe(0);
    expect(bad.failed[0]).toMatchObject({ id: market.id, title: "Market" });
    await assetBulk(db, { ids: [market.id], action: "archive" });
    expect((await q(`select status from marketing_assets where id = $1`, [market.id]))[0].status).toBe("archived");
  });

  it("ingredient tags: unique names, rename, archive; raw material names only for the Admin helper", async () => {
    const t = await saveIngredientTag(db, null, { name: "Ingredient B" }, null);
    await rejects(() => saveIngredientTag(db, null, { name: "ingredient b" }, null), /already exists/);
    await saveIngredientTag(db, t.id, { name: "Ingredient B2" }, null);
    await saveIngredientTag(db, t.id, { archive: true }, null);
    await q(`insert into inventory_items (name) values ('Material A'), ('Material B')`);
    const names = await rawMaterialNames(db);
    expect(names).toEqual(expect.arrayContaining(["Material A", "Material B"]));
    expect((await tagsFromRawMaterials(db, { names: ["Material A", "Not a material"] }, "Admin A")).added).toBe(1);
    expect((await loadLibraryData(db)).ingredientTags.some((x) => x.name === "Material A")).toBe(true);
  });
});

describe("calendar", () => {
  it("Add to calendar: paused refused, one entry per platform with claims and assets, duplicate warning, status mapping", async () => {
    const claim = await createClaim(db, { claim_text: "Claim B", submit: true }, null);
    await reviewClaim(db, claim.id, { action: "approve" }, "Admin A");
    const asset = await createLinkAsset(db, { title: "Clip", url: "https://video.example.test/c", category: "product", product_ids: [prodA] }, null);
    const { id } = await createPremade(db, reel({ claim_ids: [claim.id], asset_ids: [asset.id], caption: "Caption A", asset_needs: [{ key: "photo:b", label: "Photo B", kind: "photo" }] }), null);
    await premadeAction(db, id, { action: "pause" }, null);
    await rejects(() => scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["instagram"] }), /paused/);
    await premadeAction(db, id, { action: "reactivate" }, null);
    const r = await scheduleFromLibrary(db, id, { date: "2026-12-01", time: "09:30", platforms: ["instagram", "tiktok"] });
    expect(r.ids).toHaveLength(2);
    expect(r.open_needs).toBe(1);
    const posts = await q(`select title, platform, status, post_type, premade_post_id from content_posts order by platform`);
    expect(posts).toEqual([
      { title: "B - Reel A", platform: "instagram", status: "scripting", post_type: "reel", premade_post_id: id },
      { title: "B - Reel A", platform: "tiktok", status: "scripting", post_type: "reel", premade_post_id: id },
    ]);
    expect((await q(`select count(*)::int as n from content_post_claims`))[0].n).toBe(2);
    expect((await q(`select count(*)::int as n from content_post_assets`))[0].n).toBe(2);
    const dup = await rejects(() => scheduleFromLibrary(db, id, { date: "2026-12-08", platforms: ["facebook"] }), /Already on the calendar for 2026-12-01/);
    expect(dup.status).toBe(409);
    expect((await scheduleFromLibrary(db, id, { date: "2026-12-08", platforms: ["facebook"], confirm_duplicate: true })).ids).toHaveLength(1);
    // Recurring items never warn.
    const rec = await createPremade(db, reel({ title: "Recurring", is_recurring: true, intent: "paid" }), null);
    await scheduleFromLibrary(db, rec.id, { date: "2026-12-01", platforms: ["instagram"] });
    await scheduleFromLibrary(db, rec.id, { date: "2026-12-02", platforms: ["instagram"] });
    expect((await q(`select post_type from content_posts where premade_post_id = $1`, [rec.id])).map((x) => x.post_type)).toEqual(["ad", "ad"]);
  });

  it("Update from library copies the new caption; Posted entries can't be updated", async () => {
    const { id } = await createPremade(db, { category: "picture_post", title: "Pic A", pillar_id: pilA, caption: "Old caption", hashtags: "#a" }, null);
    const r = await scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["instagram"] });
    await updatePremade(db, id, { category: "picture_post", title: "Pic A", pillar_id: pilA, caption: "New caption", hashtags: "#b" }, null);
    await syncFromLibrary(db, r.ids[0]);
    expect((await q(`select caption, hashtags from content_posts where id = $1`, [r.ids[0]]))[0]).toEqual({ caption: "New caption", hashtags: "#b" });
    await q(`update content_posts set status = 'posted' where id = $1`, [r.ids[0]]);
    await rejects(() => syncFromLibrary(db, r.ids[0]), /Posted entries can't be updated/);
  });
});

describe("best times, rhythm and the avoid list", () => {
  it("editing a window makes it own data; rhythm validation; avoid phrases unique", async () => {
    const w = (await q<{ id: string }>(`insert into posting_time_windows (day_of_week, platform, window_text, ranges, quality) values (2, 'tiktok', 'Window A', '[]', 'good') returning id`))[0].id;
    await rejects(() => updateWindow(db, w, { window_text: "x", quality: "peak", ranges: [{ start: "18:00", end: "14:00" }] }, null), /missing or not valid/);
    await updateWindow(db, w, { window_text: "2 to 6pm", quality: "peak", ranges: [{ start: "14:00", end: "18:00" }] }, "Test Person");
    expect((await loadLibraryData(db)).windows[0]).toMatchObject({ source: "own_data", updated_by_name: "Test Person", quality: "peak", ranges: [{ start: "14:00", end: "18:00" }] });
    await rejects(() => saveRhythm(db, null, { days: [], label: "Row A" }), /missing or not valid/);
    await saveRhythm(db, null, { days: [1, 3], label: "Row A", pillar_ids: [pilA] });
    const row = (await loadLibraryData(db)).rhythm[0];
    expect(row).toMatchObject({ days: [1, 3], label: "Row A", pillar_ids: [pilA], active: true });
    await saveRhythm(db, row.id, { archive: true });
    await saveAvoidPhrase(db, null, { phrase: "Phrase  A", note: "Note" });
    await rejects(() => saveAvoidPhrase(db, null, { phrase: "phrase a" }), /already on the list/);
    expect((await loadLibraryData(db)).avoidPhrases[0]).toMatchObject({ phrase: "Phrase A", source: "manual" });
  });
});
