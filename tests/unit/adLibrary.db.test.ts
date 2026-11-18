// supabase-migrations/ad_library.sql in PGlite: constraints and uniqueness
// (pillar letters, titles per pillar, one window per day and platform), the
// asset link tables, the insert-only backfill, re-lettering in one
// transaction, the display-name view, and row level security
// (growth.marketing only, Admin-only avoid list writes, no anon, no delete).
// Existing content_posts and marketing_assets rows are unaffected.
// Invented data only.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, asAnon, asOwner, asService, asUser, createAccessDb, migration } from "./helpers/accessDb";

let pg: PGlite;
const users: Record<string, { userId: string; accountId: string }> = {};
let fpA: string;
let fpB: string;
let legacyAsset: string;
let plainAsset: string;
let postId: string;
let before: { assets: unknown[]; posts: unknown[] };

async function fails(sql: string, params: unknown[] = [], re?: RegExp) {
  let err: Error | null = null;
  try {
    await pg.query(sql, params);
  } catch (e) {
    err = e as Error;
  }
  expect(err, `expected failure: ${sql}`).not.toBeNull();
  if (re) expect(err!.message).toMatch(re);
}
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n);
const pillar = async (code: string, name: string) => (await one<{ id: string }>(`insert into content_pillars (code, name) values ($1, $2) returning id`, [code, name])).id;

beforeAll(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql"]) await pg.exec(migration(f));

  // Existing Marketing Hub rows from before this migration.
  fpA = (await one<{ id: string }>(`insert into formulation_products (name) values ('Product A Gum') returning id`)).id;
  fpB = (await one<{ id: string }>(`insert into formulation_products (name) values ('Product B Toothpaste') returning id`)).id;
  legacyAsset = (await one<{ id: string }>(`insert into marketing_assets (title, source, url, formulation_product_id) values ('Asset A', 'link', 'https://media.example.test/a', $1) returning id`, [fpA])).id;
  plainAsset = (await one<{ id: string }>(`insert into marketing_assets (title, source, url) values ('Asset B', 'link', 'https://media.example.test/b') returning id`)).id;
  postId = (await one<{ id: string }>(`insert into content_posts (title, caption) values ('Post A', 'Caption A') returning id`)).id;
  before = {
    assets: (await pg.query(`select id, title, formulation_product_id, status, updated_at from marketing_assets order by id`)).rows,
    posts: (await pg.query(`select id, title, caption, status, updated_at from content_posts order by id`)).rows,
  };

  try {
    await pg.exec(migration("ad_library.sql"));
  } catch (e) {
    throw new Error(`ad_library.sql: ${(e as Error).message}`);
  }
  await pg.exec(migration("ad_library.sql")); // safe to run twice
  await pg.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
  await pg.exec(migration("ad_library.sql")); // its own grants win again (no delete)
  await pg.exec(migration("marketing_sales.sql"));

  const r = await one<{ id: string }>(`insert into roles (name) values ('Marketer') returning id`);
  await pg.query(`insert into role_features (role_id, feature_key) values ($1, 'growth.marketing')`, [r.id]);
  users.admin = await addEmployee(pg, { roles: ["Admin"], first: "Ada", last: "Admin" });
  users.marketer = await addEmployee(pg, { roles: ["Marketer"], first: "Mia", last: "Market" });
  users.warehouse = await addEmployee(pg, { roles: ["Warehouse Operations"] });
  users.inactive = await addEmployee(pg, { roles: ["Marketer"], status: "deactivated" });
}, 120_000);

describe("existing rows and the backfill", () => {
  it("existing assets and posts are unchanged; legacy product tags are copied into the link table", async () => {
    await asOwner(pg);
    expect((await pg.query(`select id, title, formulation_product_id, status, updated_at from marketing_assets order by id`)).rows).toEqual(before.assets);
    expect((await pg.query(`select id, title, caption, status, updated_at from content_posts order by id`)).rows).toEqual(before.posts);
    const a = await one<{ category: string | null; is_full_lineup: boolean | null; context_label: string | null; shot_date: string | null }>(
      `select category, is_full_lineup, context_label, shot_date from marketing_assets where id = $1`, [legacyAsset]);
    expect(a.category).toBeNull();
    expect(await count(`select count(*) as n from asset_product_links`)).toBe(1);
    expect(await one(`select asset_id, formulation_product_id from asset_product_links`)).toEqual({ asset_id: legacyAsset, formulation_product_id: fpA });
    const p = await one<{ premade_post_id: string | null; premade_synced_at: string | null }>(`select premade_post_id, premade_synced_at from content_posts where id = $1`, [postId]);
    expect(p).toEqual({ premade_post_id: null, premade_synced_at: null });
    expect((await pg.query(`select name from asset_ingredient_tags order by name`)).rows.map((x) => (x as { name: string }).name)).toEqual(["Birch xylitol", "Nano-hydroxyapatite"]);
  });
});

describe("constraints and uniqueness", () => {
  it("pillar letters A to Z, unique among non-archived; names unique", async () => {
    await asOwner(pg);
    const a = await pillar("A", "Alpha");
    await fails(`insert into content_pillars (code, name) values ('A', 'Other')`, [], /content_pillars_code_unique/);
    await fails(`insert into content_pillars (code, name) values ('a', 'Lower')`, [], /content_pillars_code_ok/);
    await fails(`insert into content_pillars (code, name) values ('AB', 'Two')`, [], /content_pillars_code_ok/);
    await fails(`insert into content_pillars (code, name) values ('B', ' alpha ')`, [], /content_pillars_name_unique/);
    await pg.query(`update content_pillars set archived_at = now() where id = $1`, [a]);
    const a2 = await pillar("A", "Alpha");
    expect(a2).not.toBe(a);
  });

  it("re-lettering swaps letters in one transaction", async () => {
    await asOwner(pg);
    const x = await pillar("X", "Pillar X");
    const y = await pillar("Y", "Pillar Y");
    await fails(`update content_pillars set code = 'Y' where id = $1`, [x], /content_pillars_code_unique/);
    await pg.query(`select reletter_pillars($1::jsonb)`, [JSON.stringify({ [x]: "Y", [y]: "X" })]);
    expect((await one<{ code: string }>(`select code from content_pillars where id = $1`, [x])).code).toBe("Y");
    expect((await one<{ code: string }>(`select code from content_pillars where id = $1`, [y])).code).toBe("X");
    await fails(`select reletter_pillars($1::jsonb)`, [JSON.stringify({ [x]: "X" })], /content_pillars_code_unique/);
  });

  it("library items: unique title per pillar, categories, platforms, beats and needs, display name view", async () => {
    await asOwner(pg);
    const p = await pillar("C", "Charlie");
    const q = await pillar("D", "Delta");
    const id = (await one<{ id: string }>(`insert into premade_posts (title, category, pillar_id, platforms) values ('Item one', 'reel', $1, '{instagram,tiktok}') returning id`, [p])).id;
    await fails(`insert into premade_posts (title, category, pillar_id) values (' item ONE ', 'picture_post', $1)`, [p], /premade_posts_title_unique/);
    await pg.query(`insert into premade_posts (title, category, pillar_id) values ('Item one', 'picture_post', $1)`, [q]);
    await fails(`insert into premade_posts (title, category, pillar_id) values ('X', 'video', $1)`, [p], /premade_posts_category_ok/);
    await fails(`insert into premade_posts (title, category, pillar_id, platforms) values ('X', 'reel', $1, '{myspace}')`, [p], /premade_posts_platforms_ok/);
    await fails(`insert into premade_posts (title, category, pillar_id, status) values ('X', 'reel', $1, 'done')`, [p], /premade_posts_status_ok/);
    await fails(`insert into premade_posts (title, category, pillar_id, picture_format) values ('X', 'picture_post', $1, 'gif')`, [p], /premade_posts_picture_format_ok/);
    await fails(`insert into premade_posts (title, category, pillar_id, duration_min_seconds, duration_max_seconds) values ('X', 'reel', $1, 40, 20)`, [p], /premade_posts_duration_ok/);
    await fails(`insert into premade_posts (title, category, pillar_id, script_beats) values ('X', 'reel', $1, $2::jsonb)`, [p, JSON.stringify([{ time: "0:00" }])], /premade_posts_beats_ok/);
    await fails(`insert into premade_posts (title, category, pillar_id, script_beats) values ('X', 'reel', $1, $2::jsonb)`, [p, JSON.stringify(Array.from({ length: 21 }, () => ({ beat: "b" })))], /premade_posts_beats_ok/);
    await fails(`insert into premade_posts (title, category, pillar_id, asset_needs) values ('X', 'reel', $1, $2::jsonb)`, [p, JSON.stringify([{ key: "k", label: "L", kind: "sound", status: "needed" }])], /premade_posts_needs_ok/);
    await pg.query(`update premade_posts set script_beats = $2::jsonb, asset_needs = $3::jsonb where id = $1`, [
      id, JSON.stringify([{ time: "0:00", beat: "Open" }]), JSON.stringify([{ key: "photo:gum_product", label: "Gum photo", kind: "photo", status: "needed", asset_id: null, note: null }]),
    ]);
    expect((await one<{ display_name: string }>(`select display_name from premade_posts_named where id = $1`, [id])).display_name).toBe("C - Item one");
    // Renaming the letter changes the display name (nothing is stored).
    await pg.query(`update content_pillars set code = 'E' where id = $1`, [p]);
    expect((await one<{ display_name: string }>(`select display_name from premade_posts_named where id = $1`, [id])).display_name).toBe("E - Item one");
    await pg.query(`insert into premade_post_flags (premade_post_id, flag_key) values ($1, 'auto_name')`, [id]);
    await fails(`insert into premade_post_flags (premade_post_id, flag_key) values ($1, 'auto_name')`, [id], /premade_post_flags_unique/);
    await fails(`insert into premade_post_flags (premade_post_id, flag_key) values ($1, 'other')`, [id], /premade_post_flags_key_ok/);
    // A pillar in use can't be removed (archived pillars stay referenced).
    await fails(`delete from content_pillars where id = $1`, [p], /foreign key/);
  });

  it("one window per day and platform; ranges, rhythm and reference notes", async () => {
    await asOwner(pg);
    await pg.query(`insert into posting_time_windows (day_of_week, platform, window_text, ranges, quality) values (2, 'tiktok', '2 to 6pm', $1::jsonb, 'peak')`, [JSON.stringify([{ start: "14:00", end: "18:00" }])]);
    await fails(`insert into posting_time_windows (day_of_week, platform) values (2, 'tiktok')`, [], /posting_time_windows_unique/);
    await fails(`insert into posting_time_windows (day_of_week, platform) values (7, 'tiktok')`, [], /posting_time_windows_day_ok/);
    await fails(`insert into posting_time_windows (day_of_week, platform) values (1, 'youtube')`, [], /posting_time_windows_platform_ok/);
    await fails(`insert into posting_time_windows (day_of_week, platform, ranges) values (1, 'tiktok', $1::jsonb)`, [JSON.stringify([{ start: "25:00", end: "26:00" }])], /posting_time_windows_ranges_ok/);
    await fails(`insert into posting_rhythm (days, label) values ('{7}', 'Bad day')`, [], /posting_rhythm_days_ok/);
    await pg.query(`insert into posting_rhythm (days, label) values ('{4,5}', 'Two days')`);
    await fails(`insert into reference_notes (key, body) values ('other', 'x')`, [], /reference_notes_key_ok/);
  });

  it("asset columns and link tables", async () => {
    await asOwner(pg);
    await fails(`update marketing_assets set category = 'stuff' where id = $1`, [plainAsset], /marketing_assets_category_ok/);
    await pg.query(`update marketing_assets set category = 'group_product', is_full_lineup = true, shot_date = '2026-06-01' where id = $1`, [plainAsset]);
    await pg.query(`insert into asset_product_links (asset_id, formulation_product_id) values ($1, $2), ($1, $3)`, [plainAsset, fpA, fpB]);
    await fails(`insert into asset_product_links (asset_id, formulation_product_id) values ($1, $2)`, [plainAsset, fpA], /duplicate key/);
    const tag = await one<{ id: string }>(`select id from asset_ingredient_tags where name = 'Birch xylitol'`);
    await pg.query(`insert into asset_ingredient_links (asset_id, ingredient_tag_id) values ($1, $2)`, [plainAsset, tag.id]);
    await fails(`insert into asset_ingredient_tags (name) values ('birch XYLITOL')`, [], /asset_ingredient_tags_name_unique/);
    await fails(`insert into closing_lines (text) values ('A line'), (' a LINE ')`, [], /closing_lines_text_unique/);
    await fails(`insert into avoid_phrases (phrase) values ('fixes all'), ('Fixes All')`, [], /avoid_phrases_phrase_unique/);
    const types = await pg.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'marketing_assets' and column_name = 'shot_date'`);
    expect(types.rows[0].data_type).toBe("date");
  });
});

describe("row level security", () => {
  it("growth.marketing users read and write; others and anon get nothing; nobody deletes", async () => {
    await asUser(pg, users.marketer.userId);
    await pg.query(`insert into content_pillars (code, name) values ('M', 'Marketer pillar')`);
    expect(await count(`select count(*) as n from content_pillars`)).toBeGreaterThan(0);
    expect(await count(`select count(*) as n from avoid_phrases`)).toBeGreaterThanOrEqual(0);
    await fails(`delete from content_pillars where code = 'M'`, [], /permission denied/);
    await fails(`insert into avoid_phrases (phrase) values ('marketer phrase')`, [], /row-level security/);

    for (const u of [users.warehouse, users.inactive]) {
      await asUser(pg, u.userId);
      expect(await count(`select count(*) as n from content_pillars`)).toBe(0);
      expect(await count(`select count(*) as n from premade_posts`)).toBe(0);
      expect(await count(`select count(*) as n from premade_posts_named`)).toBe(0);
      await fails(`insert into content_pillars (code, name) values ('W', 'Nope')`, [], /row-level security/);
    }
    await asAnon(pg);
    await fails(`select count(*) from content_pillars`, [], /permission denied/);
    await fails(`select count(*) from avoid_phrases`, [], /permission denied/);
  });

  it("Admins add and change the avoid list; the marketer cannot change it", async () => {
    await asUser(pg, users.admin.userId);
    await pg.query(`insert into avoid_phrases (phrase, source) values ('admin phrase', 'manual')`);
    await pg.query(`update avoid_phrases set note = 'n' where phrase = 'admin phrase'`);
    await fails(`delete from avoid_phrases where phrase = 'admin phrase'`, [], /permission denied/);
    await asUser(pg, users.marketer.userId);
    expect(await count(`select count(*) as n from avoid_phrases where phrase = 'admin phrase'`)).toBe(1);
    await pg.query(`update avoid_phrases set note = 'changed' where phrase = 'admin phrase'`); // filtered by RLS: changes nothing
    await asService(pg);
    expect((await one<{ note: string }>(`select note from avoid_phrases where phrase = 'admin phrase'`)).note).toBe("n");
    await asUser(pg, users.marketer.userId);
    await fails(`select reletter_pillars('{}'::jsonb)`, [], /permission denied/);
    await asOwner(pg);
  });
});
