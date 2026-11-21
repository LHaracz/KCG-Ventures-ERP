// Ad Library server code against the real migrations in PGlite: topics
// (letters, archive blocked while in use, re-letter renames calendar
// entries that aren't Posted), library posts (short names like AA-1, a new
// subtopic from the form, the Ready gate on the final caption, the
// words-reviewed hash, back to Drafting, flags, duplicate, pause), Set topic,
// Edit caption with conflicts and history, final captions with subtopic and
// product hashtags, closing lines, needs, categorized assets and tags,
// scheduling (groups, no caption until posted, Edit schedule, Mark posted
// freezes, Remove), posting windows, rhythm and the avoid list.
// Invented data only ("Topic Beta", "Product A", "#tagone").
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  assetBulk,
  captionHistory,
  createPillar,
  createPremade,
  editSchedule,
  finalCaptionFor,
  gateFor,
  getPremade,
  loadLibraryData,
  markPosted,
  needsAction,
  needsGroupAction,
  premadeAction,
  premadeBulk,
  rawMaterialNames,
  reletterPillars,
  removeFromCalendar,
  saveAvoidPhrase,
  saveClosingLine,
  saveIngredientTag,
  saveRhythm,
  saveSeries,
  scheduleFromLibrary,
  tagsFromRawMaterials,
  updateCaption,
  updatePillar,
  updatePremade,
  updateWindow,
} from "@/lib/growth/libraryService";
import { createLinkAsset, listAssetPage, updateAsset } from "@/lib/growth/marketingService";
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
  pillar_id: pilA,
  hook: "A hook line",
  script_beats: [{ time: "0:00", beat: "Open on the product" }],
  cta_text: "Shop now",
  ...over,
});
const pic = (over: Record<string, unknown> = {}) => ({ category: "picture_post", pillar_id: pilA, caption: "Body text", ...over });
const entries = (premadeId: string) =>
  q<{ title: string; platform: string; status: string; caption: string | null; schedule_group_id: string | null; archived_at: string | null }>(
    `select title, platform, status, caption, schedule_group_id, archived_at from content_posts where premade_post_id = $1 order by platform`,
    [premadeId],
  );

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql", "ad_library.sql", "marketing_assets_media.sql", "marketing_assets_mov.sql", "asset_categories.sql", "marketing_naming.sql"]) await pg.exec(migration(f));
  db = withJsonb(pgliteSupabase(pg) as unknown as Db);
  prodA = (await q<{ id: string }>(`insert into formulation_products (name) values ('Product A Gum') returning id`))[0].id;
  prodB = (await q<{ id: string }>(`insert into formulation_products (name) values ('Product B Toothpaste') returning id`))[0].id;
  pilA = (await createPillar(db, { code: "B", name: "Topic Beta" })).id;
  pilB = (await createPillar(db, { code: "A", name: "Topic Alpha", recurring: true })).id;
}, 120_000);

describe("topics", () => {
  it("unique letters and names; archive blocked while in use; re-letter renames entries that aren't Posted", async () => {
    await rejects(() => createPillar(db, { code: "B", name: "Another" }), /already uses that letter/);
    await rejects(() => createPillar(db, { code: "C", name: "topic beta" }), /already has that name/);
    const { id, name } = await createPremade(db, reel({ pillar_id: pilB }), "Test Person");
    expect(name).toBe("A-1");
    await rejects(() => updatePillar(db, pilB, { archive: true }), /still has 1 post/);
    const s = await scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["instagram", "tiktok"], schedule_anyway: true });
    await markPosted(db, s.ids[0], {}); // the Instagram entry is Posted and keeps "A-1"
    await updatePillar(db, pilB, { code: "Z", name: "Topic Alpha", recurring: true });
    expect((await item(id)).name).toBe("Z-1");
    expect((await entries(id)).map((e) => `${e.platform}:${e.title}`)).toEqual(["instagram:A-1", "tiktok:Z-1"]);
    const plan = await reletterPillars(db, false);
    expect(plan.changes.map((c) => `${c.from}>${c.to}`).sort()).toEqual(["Z>A"]);
    expect(plan.affectedItems).toEqual([{ id, before: "Z-1", after: "A-1" }]);
    expect((await item(id)).name).toBe("Z-1"); // preview changes nothing
    await reletterPillars(db, true);
    expect((await item(id)).name).toBe("A-1");
    expect((await entries(id)).map((e) => `${e.platform}:${e.title}`)).toEqual(["instagram:A-1", "tiktok:A-1"]);
    // The Posted entry never changed: its frozen caption is still there.
    expect((await entries(id))[0].status).toBe("posted");
  });
});

describe("library posts", () => {
  it("names per topic and subtopic, a new subtopic from the form, and Ready is never set on create", async () => {
    const a = await createPremade(db, reel({ status: "ready" }), "Test Person");
    expect(a.name).toBe("B-1");
    expect(await item(a.id)).toMatchObject({ name: "B-1", status: "drafting", created_by_name: "Test Person", title: null });
    const b = await createPremade(db, reel({ new_subtopic_name: "Subtopic One" }), null);
    expect(b.name).toBe("BA-1");
    const sub = (await loadLibraryData(db)).series.find((x) => x.name === "Subtopic One")!;
    expect(sub.code).toBe("A");
    expect((await createPremade(db, reel({ series_id: sub.id }), null)).name).toBe("BA-2");
    expect((await createPremade(db, reel(), null)).name).toBe("B-2");
    await rejects(() => createPremade(db, { ...reel(), category: "story" }, null), /Reel or Picture post/);
    const p = await createPremade(db, pic({ duration_text: "0:20-0:35" }), null);
    expect((await item(p.id)).picture_format).toBe("unknown");
    expect((await saveSeries(db, null, { pillar_id: pilA, name: "Subtopic Two" })).code).toBe("B");
  });

  it("assets, needs and products chosen before the first save are saved with the post", async () => {
    const asset = await createLinkAsset(db, { title: "Clip A", url: "https://video.example.test/a", category: "product", product_ids: [prodA] }, null);
    const { id } = await createPremade(db, reel({ asset_ids: [asset.id], product_ids: [prodA, prodB], asset_needs: [{ key: "photo:a", label: "Photo A", kind: "photo" }] }), null);
    const r = await item(id);
    expect(r.asset_ids).toEqual([asset.id]);
    expect(r.product_ids.sort()).toEqual([prodA, prodB].sort());
    expect(r.asset_needs[0]).toMatchObject({ key: "photo:a", status: "needed" });
  });

  it("final caption: body, two blank lines, subtopic tags then product tags (no repeats)", async () => {
    const sub = await saveSeries(db, null, { pillar_id: pilA, name: "Subtopic One" });
    await saveSeries(db, sub.id, { name: "Subtopic One", default_hashtags: "#tagone, tagtwo" });
    await q(`insert into marketing_product_profiles (formulation_product_id, hashtags) values ($1, '#tagthree #TagOne'), ($2, '#tagfour')`, [prodA, prodB]);
    const { id } = await createPremade(db, pic({ series_id: sub.id, caption: "Body text  ", product_ids: [prodB, prodA] }), null);
    expect(await finalCaptionFor(db, await getPremade(db, id))).toBe("Body text\n\n\n#tagone #tagtwo #tagthree #tagfour");
  });

  it("the Ready gate: each blocker, words checked in the final caption, the reviewed hash, and back to Drafting", async () => {
    const { id } = await createPremade(db, reel({ hook: "", cta_text: "", script_beats: [], needs_customer_permission: true, asset_needs: [{ key: "photo:a", label: "Photo A", kind: "photo" }] }), null);
    const e = await rejects(() => updatePremade(db, id, reel({ status: "ready", needs_customer_permission: true, hook: "", cta_text: "", script_beats: [] }), null), /Not ready yet/);
    for (const m of [/Write the hook/, /at least one script beat/, /call to action/, /still needed: Photo A/, /customer's permission/]) expect(e.message).toMatch(m);
    const asset = await createLinkAsset(db, { title: "Video A", url: "https://video.example.test/a", category: "product", product_ids: [prodA] }, null);
    await needsAction(db, id, { op: "attach", key: "photo:a", asset_id: asset.id });
    await premadeAction(db, id, { action: "confirm_permission" }, "Test Person");
    const body = reel({ hook: "This will cure it", needs_customer_permission: true });
    await rejects(() => updatePremade(db, id, { ...body, status: "ready" }, null), /Review these words/);
    await updatePremade(db, id, { ...body, status: "drafting" }, null);
    const { hash } = await gateFor(db, await getPremade(db, id));
    await rejects(() => premadeAction(db, id, { action: "ack_words", hash: "stale" }, "Test Person"), /text changed/);
    await premadeAction(db, id, { action: "ack_words", hash }, "Test Person");
    await updatePremade(db, id, { ...body, status: "ready" }, null);
    expect((await item(id)).status).toBe("ready");
    const r = await updatePremade(db, id, { ...body, hook: "This will cure it fast", status: "ready" }, null);
    expect(r.notice).toMatch(/Moved back to Drafting: .*Review these words/);
    expect((await item(id)).status).toBe("drafting");
  });

  it("flags, duplicate (next number of the same group), pause and archive", async () => {
    const { id } = await createPremade(db, reel(), null);
    await q(`insert into premade_post_flags (premade_post_id, flag_key, detail) values ($1, 'typo_fixed', '{"changes":[]}')`, [id]);
    await premadeAction(db, id, { action: "dismiss_flag", flag_key: "typo_fixed" }, "Test Person");
    expect((await item(id)).flags.map((f) => [f.flag_key, f.dismissed_by_name])).toEqual([["typo_fixed", "Test Person"]]);
    await rejects(() => premadeAction(db, id, { action: "dismiss_flag", flag_key: "typo_fixed" }, null), /not open/);
    await premadeAction(db, id, { action: "confirm_permission" }, "Test Person");
    const copy = await premadeAction(db, id, { action: "duplicate" }, "Test Person");
    expect(copy.name).toBe("B-2");
    expect(await item(copy.id)).toMatchObject({ status: "drafting", permission_confirmed_at: null, risky_ack_hash: null, flags: [] });
    await premadeAction(db, id, { action: "pause" }, null);
    expect((await item(id)).status).toBe("paused");
    await premadeAction(db, id, { action: "reactivate" }, null);
    expect((await item(id)).status).toBe("drafting");
    await premadeAction(db, id, { action: "archive" }, null);
    expect((await item(id)).archived_at).not.toBeNull();
  });

  it("Set topic renumbers and renames entries that aren't Posted; dismissing a flag in bulk needs a note", async () => {
    const a = await createPremade(db, pic(), null);
    const b = await createPremade(db, pic(), null);
    const s = await scheduleFromLibrary(db, a.id, { date: "2026-12-01", platforms: ["facebook", "instagram"], schedule_anyway: true });
    await markPosted(db, s.ids[0], {});
    const r = await premadeBulk(db, { ids: [b.id, a.id], action: "set_topic", pillar_id: pilB, new_subtopic_name: "Subtopic One" }, "Test Person");
    expect(r.moved!.map((m) => `${m.old_name}>${m.new_name}`)).toEqual(["B-1>AA-1", "B-2>AA-2"]);
    expect((await entries(a.id)).map((e) => `${e.platform}:${e.title}`)).toEqual(["facebook:B-1", "instagram:AA-1"]);
    expect((await item(a.id)).name_history[0]).toMatchObject({ name: "B-1" });
    await q(`insert into premade_post_flags (premade_post_id, flag_key) values ($1, 'pillar_assigned'), ($2, 'pillar_assigned')`, [a.id, b.id]);
    await rejects(() => premadeBulk(db, { ids: [a.id, b.id], action: "dismiss_flag", flag_key: "pillar_assigned" }, null), /short note/);
    await premadeBulk(db, { ids: [a.id, b.id], action: "dismiss_flag", flag_key: "pillar_assigned", note: "Checked the topics" }, "Test Person");
    expect((await q(`select count(*)::int as n from premade_post_flags where dismissed_at is not null`))[0].n).toBe(2);
    await premadeBulk(db, { ids: [a.id, b.id], action: "set_products", product_ids: [prodA] }, null);
    expect((await item(b.id)).product_ids).toEqual([prodA]);
  });

  it("Edit caption: saves only the caption, conflicts on a stale version, keeps history, and a Ready post can go back to Drafting", async () => {
    const { id } = await createPremade(db, pic({ caption: "First body" }), null);
    await updatePremade(db, id, pic({ caption: "First body", status: "ready" }), null);
    const cur = await getPremade(db, id);
    const ok = await updateCaption(db, id, { caption: "Second body", expected_updated_at: cur.updated_at }, "Editor A");
    expect(ok).toMatchObject({ ok: true });
    const stale = await updateCaption(db, id, { caption: "Third body", expected_updated_at: cur.updated_at }, "Editor B");
    expect(stale).toMatchObject({ conflict: true, current_caption: "Second body" });
    expect((await captionHistory(db, id)).map((v) => [v.caption, v.changed_by_name, v.source])).toEqual([["First body", "Editor A", "table_edit"]]);
    const now = await getPremade(db, id);
    const cleared = await updateCaption(db, id, { caption: "", expected_updated_at: now.updated_at }, "Editor A");
    expect(cleared).toMatchObject({ ok: true });
    expect((cleared as { notice: string | null }).notice).toMatch(/Moved back to Drafting: Write the caption/);
    await rejects(() => updateCaption(db, id, { caption: "x".repeat(100001), expected_updated_at: now.updated_at }, null), /under 100000/);
  });

  it("closing lines are unique ignoring case and spacing", async () => {
    await saveClosingLine(db, null, { text: "See you  soon ✨", used_with_note: "X1" });
    await rejects(() => saveClosingLine(db, null, { text: "see you soon ✨" }), /already on the list/);
    const line = (await loadLibraryData(db)).closingLines[0];
    expect(line.text).toBe("See you soon ✨");
    await saveClosingLine(db, line.id, { archive: true });
    await saveClosingLine(db, null, { text: "See you soon ✨" });
  });
});

describe("needs", () => {
  it("attach with 'also apply', unlink, custom needs", async () => {
    const need = { key: "cover:sub_a", label: "Subtopic A cover", kind: "graphic" };
    const a = await createPremade(db, reel({ asset_needs: [need] }), null);
    const b = await createPremade(db, reel({ asset_needs: [need] }), null);
    const c = await createPremade(db, reel({ asset_needs: [need] }), null);
    const asset = await createLinkAsset(db, { title: "Cover A", url: "https://files.example.test/cover", category: "other", context_label: "Cover" }, null);
    await needsAction(db, a.id, { op: "attach", key: need.key, asset_id: asset.id, also_ids: [b.id] });
    const data = await loadLibraryData(db);
    const status = (id: string) => data.premades.find((p) => p.id === id)!.asset_needs[0];
    expect(status(a.id)).toMatchObject({ status: "ready", asset_id: asset.id });
    expect(status(b.id)).toMatchObject({ status: "ready", asset_id: asset.id });
    expect(status(c.id)).toMatchObject({ status: "needed" });
    await needsAction(db, a.id, { op: "unlink", key: need.key });
    expect((await item(a.id)).asset_needs[0]).toMatchObject({ status: "needed", asset_id: null });
    expect((await item(a.id)).asset_ids).toEqual([]);
    await needsAction(db, c.id, { op: "add", label: "Extra photo", kind: "photo" });
    expect((await item(c.id)).asset_needs.map((n) => n.key)).toEqual([need.key, "custom:extra_photo"]);
    await needsAction(db, c.id, { op: "remove", key: "custom:extra_photo" });
    expect((await needsGroupAction(db, { op: "attach", key: need.key, asset_id: asset.id, item_ids: [a.id, c.id] })).changed).toBe(2);
  });
});

describe("categorized assets", () => {
  it("the card picker pages 20 at a time, newest first, with filters", async () => {
    for (let i = 0; i < 23; i++) await createLinkAsset(db, { title: `Asset ${String(i).padStart(2, "0")}`, url: `https://files.example.test/${i}`, category: i < 3 ? "product" : "other", context_label: "Ctx", product_ids: i < 3 ? [prodA] : undefined }, null);
    const p1 = await listAssetPage(db, { page: 1 });
    expect([p1.total, p1.pages, p1.rows.length]).toEqual([23, 2, 20]);
    expect((await listAssetPage(db, { page: 2 })).rows).toHaveLength(3);
    expect((await listAssetPage(db, { page: 1, product: prodA })).total).toBe(3);
    expect((await listAssetPage(db, { page: 1, q: "asset 1" })).total).toBe(10);
  });


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
  it("schedule: one entry per platform in one group, no caption copied, not-Ready needs Schedule anyway, paused refused", async () => {
    const { id } = await createPremade(db, pic({ caption: "Body A" }), null);
    await rejects(() => scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["instagram"] }), /Schedule anyway/);
    await rejects(() => scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: [] , schedule_anyway: true }), /at least one platform/);
    const r = await scheduleFromLibrary(db, id, { date: "2026-12-01", time: "09:30", platforms: ["instagram", "facebook"], schedule_anyway: true });
    expect(r.ids).toHaveLength(2);
    const rows = await entries(id);
    expect(rows.map((e) => [e.platform, e.title, e.status, e.caption])).toEqual([["facebook", "B-1", "scheduled", null], ["instagram", "B-1", "scheduled", null]]);
    expect(new Set(rows.map((e) => e.schedule_group_id))).toEqual(new Set([r.group_id]));
    await premadeAction(db, id, { action: "pause" }, null);
    await rejects(() => scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["instagram"], schedule_anyway: true }), /Paused/);
  });

  it("a scheduled library entry may have an empty caption; one without a library post still needs a caption", async () => {
    const { id } = await createPremade(db, reel({ caption: null }), null);
    await scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["tiktok"], schedule_anyway: true });
    expect((await entries(id))[0]).toMatchObject({ status: "scheduled", caption: null });
    let err: unknown = null;
    try {
      await q(`insert into content_posts (title, business, platform, post_type, status, caption) values ('Plain entry', 'botaniqals', 'instagram', 'reel', 'scheduled', '')`);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/content_posts_ready_caption/);
  });

  it("Edit schedule changes the group: add and remove platforms, move the date, Posted rows are locked", async () => {
    const { id } = await createPremade(db, pic(), null);
    const r = await scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["instagram", "facebook"], schedule_anyway: true });
    const fb = (await q<{ id: string }>(`select id from content_posts where premade_post_id = $1 and platform = 'facebook'`, [id]))[0].id;
    await markPosted(db, fb, { posted_url: "https://social.example.test/p/1" });
    await rejects(() => markPosted(db, fb, {}), /already marked posted/);
    const res = await editSchedule(db, r.ids[0], { date: "2026-12-03", time: "10:00", platforms: ["instagram", "tiktok"] });
    expect(res).toEqual({ added: 1, archived: 0, updated: 1 });
    const live = (await entries(id)).filter((e) => !e.archived_at);
    expect(live.map((e) => `${e.platform}:${e.status}`)).toEqual(["facebook:posted", "instagram:scheduled", "tiktok:scheduled"]);
    expect((await q(`select scheduled_date::text as d from content_posts where premade_post_id = $1 and platform = 'facebook'`, [id]))[0].d).toBe("2026-12-01");
    await editSchedule(db, r.ids[0], { date: "2026-12-03", platforms: ["facebook", "tiktok"] });
    expect((await entries(id)).filter((e) => !e.archived_at).map((e) => e.platform)).toEqual(["facebook", "tiktok"]);
    expect((await removeFromCalendar(db, r.ids[0])).removed).toBe(1);
    expect((await entries(id)).filter((e) => !e.archived_at).map((e) => e.platform)).toEqual(["facebook"]);
  });

  it("Mark posted freezes the final caption and the name; later library edits don't change it", async () => {
    const sub = await saveSeries(db, null, { pillar_id: pilA, name: "Subtopic One" });
    await saveSeries(db, sub.id, { name: "Subtopic One", default_hashtags: "#tagone" });
    const { id } = await createPremade(db, pic({ series_id: sub.id, caption: "Body A" }), null);
    const r = await scheduleFromLibrary(db, id, { date: "2026-12-01", platforms: ["instagram", "facebook"], schedule_anyway: true });
    await markPosted(db, r.ids[0], {});
    await updatePremade(db, id, pic({ series_id: sub.id, caption: "Body B" }), null);
    await premadeBulk(db, { ids: [id], action: "set_topic", pillar_id: pilB }, null);
    const rows = await q<{ id: string; title: string; caption: string | null; status: string }>(`select id, title, caption, status from content_posts where premade_post_id = $1`, [id]);
    const posted = rows.find((x) => x.id === r.ids[0])!;
    const other = rows.find((x) => x.id !== r.ids[0])!;
    expect(posted).toMatchObject({ status: "posted", title: "BA-1", caption: "Body A\n\n\n#tagone" });
    expect(other).toMatchObject({ status: "scheduled", title: "A-1", caption: null });
    // An empty final caption (a reel with only a hook) can still be marked posted.
    const rl = await createPremade(db, reel({ caption: null }), null);
    const e = await scheduleFromLibrary(db, rl.id, { date: "2026-12-02", platforms: ["tiktok"], schedule_anyway: true });
    await markPosted(db, e.ids[0], {});
    expect((await entries(rl.id))[0]).toMatchObject({ status: "posted", caption: null, title: "B-1" });
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
