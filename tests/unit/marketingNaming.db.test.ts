// supabase-migrations/marketing_naming.sql and the conversion files in
// supabase/conversions/2026-11-naming/ against the real SQL in PGlite.
// Invented data only ("Topic X", "Caption one", "#sampletag").
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, asAnon, asOwner, asService, asUser, createAccessDb, migration } from "./helpers/accessDb";
import { planConversion, type ConvPost, type ConvSubtopic } from "@/lib/growth/naming";

let pg: PGlite;
const root = path.resolve(__dirname, "../..");
const conversion = (f: string) => readFileSync(path.join(root, "supabase", "conversions", "2026-11-naming", f), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = async <T = any>(sql: string, p: unknown[] = []) => (await pg.query<T>(sql, p)).rows;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const one = async <T = any>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0];
const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(re);
};

const BASE = ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql", "ad_library.sql", "marketing_assets_media.sql", "marketing_assets_mov.sql", "asset_categories.sql"];

async function setup(withNaming = true) {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of BASE) await pg.exec(migration(f));
  if (withNaming) await pg.exec(migration("marketing_naming.sql"));
}
const pillar = async (code: string, name = `Topic ${code}`) => (await one(`insert into content_pillars (code, name) values ($1, $2) returning id`, [code, name])).id as string;
const series = async (pillarId: string, name: string, sort = 0, code: string | null = null) =>
  (await one(`insert into content_series (pillar_id, name, sort_order, code) values ($1, $2, $3, $4) returning id`, [pillarId, name, sort, code])).id as string;
let n = 0;
const legacyPost = async (pillarId: string, seriesId: string | null, extra: Record<string, unknown> = {}) => {
  n += 1;
  const row = { title: `Imported ${n}`, category: "picture_post", pillar_id: pillarId, series_id: seriesId, caption: `Caption ${n}`, sort_order: n, ...extra };
  const cols = Object.keys(row);
  return (await one(`insert into premade_posts (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).id as string;
};
const create = async (payload: Record<string, unknown>) => (await one(`select create_premade_post($1::jsonb) as r`, [JSON.stringify(payload)])).r;
const nameOf = async (id: string) => (await one(`select premade_current_name($1) as n`, [id])).n as string;

describe("marketing_naming.sql", () => {
  beforeEach(async () => {
    n = 0;
    await setup();
  }, 120_000);

  it("runs twice and changes no existing row", async () => {
    await setup(false);
    const p = await pillar("A");
    const id = await legacyPost(p, null);
    const before = await one(`select title, caption, updated_at from premade_posts where id = $1`, [id]);
    await pg.exec(migration("marketing_naming.sql"));
    await pg.exec(migration("marketing_naming.sql"));
    const after = await one(`select title, caption, updated_at, post_number, name_history from premade_posts where id = $1`, [id]);
    expect(after).toMatchObject({ ...before, post_number: null, name_history: [] });
  });

  it("subtopics: the next unused letter per topic, archived letters kept, names unique per topic, at most 26", async () => {
    const a = await pillar("A");
    const b = await pillar("B");
    const s1 = await one(`select create_subtopic($1, 'Subtopic one') as r`, [a]);
    const s2 = await one(`select create_subtopic($1, 'Subtopic two') as r`, [a]);
    expect([s1.r.code, s2.r.code]).toEqual(["A", "B"]);
    await q(`update content_series set archived_at = now() where id = $1`, [s1.r.id]);
    expect((await one(`select create_subtopic($1, 'Subtopic three') as r`, [a])).r.code).toBe("C");
    // The same name can be used in another topic, and again once archived.
    expect((await one(`select create_subtopic($1, 'Subtopic two') as r`, [b])).r.code).toBe("A");
    await rejects(() => q(`select create_subtopic($1, 'subtopic TWO')`, [a]), /content_series_pillar_name_unique|duplicate key/);
    expect((await one(`select create_subtopic($1, 'Subtopic one') as r`, [a])).r.code).toBe("D");
    for (let i = 0; i < 22; i++) await q(`select create_subtopic($1, $2)`, [a, `More ${i}`]);
    await rejects(() => q(`select create_subtopic($1, 'One too many')`, [a]), /26 subtopics/);
    await rejects(() => q(`insert into content_series (pillar_id, name, code) values ($1, 'Clash', 'A')`, [a]), /content_series_pillar_code_unique|duplicate key/);
  });

  it("create_premade_post numbers per group, creates a new subtopic in the same transaction, and links assets and products", async () => {
    const a = await pillar("A");
    const sub = (await one(`select create_subtopic($1, 'Subtopic one') as r`, [a])).r.id as string;
    const prod = (await one(`insert into formulation_products (name) values ('Product X') returning id`)).id;
    const asset = (await one(`insert into marketing_assets (title, source, url, category) values ('Asset X', 'link', 'https://files.example.test/x', 'market') returning id`)).id;
    const r1 = await create({ pillar_id: a, series_id: sub, actor_name: "Test Person", post: { category: "picture_post", caption: "Caption one" }, asset_ids: [asset], product_ids: [prod] });
    const r2 = await create({ pillar_id: a, series_id: sub, post: { category: "reel", hook: "Hook one" } });
    const r3 = await create({ pillar_id: a, series_id: null, post: { category: "picture_post" } });
    const r4 = await create({ pillar_id: a, new_subtopic_name: "Subtopic two", post: { category: "picture_post", script_beats: [{ beat: "Beat" }] } });
    expect([r1.name, r2.name, r3.name, r4.name]).toEqual(["AA-1", "AA-2", "A-1", "AB-1"]);
    expect(await q(`select asset_id from premade_post_assets where premade_post_id = $1`, [r1.id])).toEqual([{ asset_id: asset }]);
    expect(await q(`select formulation_product_id from premade_post_products where premade_post_id = $1`, [r1.id])).toEqual([{ formulation_product_id: prod }]);
    expect(await one(`select created_by_name, title, status from premade_posts where id = $1`, [r1.id])).toEqual({ created_by_name: "Test Person", title: null, status: "drafting" });
    // A failure rolls everything back, including a new subtopic and the counter.
    await rejects(() => create({ pillar_id: a, new_subtopic_name: "Subtopic three", post: { category: "nonsense" } }), /premade_posts_category_ok|check constraint/);
    expect(await q(`select 1 from content_series where name = 'Subtopic three'`)).toHaveLength(0);
    expect((await create({ pillar_id: a, series_id: sub, post: { category: "reel" } })).name).toBe("AA-3");
    // A subtopic of another topic is refused.
    const b = await pillar("B");
    await rejects(() => create({ pillar_id: b, series_id: sub, post: { category: "reel" } }), /subtopic of this topic/);
  });

  it("two creates at the same time get different numbers (the topic row is locked)", async () => {
    const a = await pillar("A");
    const [x, y] = await Promise.all([create({ pillar_id: a, post: { category: "reel" } }), create({ pillar_id: a, post: { category: "reel" } })]);
    expect([x.name, y.name].sort()).toEqual(["A-1", "A-2"]);
  });

  it("numbers are unique per group including archived posts, and never reused", async () => {
    const a = await pillar("A");
    const r1 = await create({ pillar_id: a, post: { category: "reel" } });
    await q(`update premade_posts set archived_at = now() where id = $1`, [r1.id]);
    expect((await create({ pillar_id: a, post: { category: "reel" } })).name).toBe("A-2");
    await rejects(() => q(`update premade_posts set post_number = 2 where id = $1`, [r1.id]), /premade_posts_group_number_unique|duplicate key/);
  });

  it("move_premade_posts renumbers in name order, keeps history, and updates titles of entries that aren't Posted", async () => {
    const a = await pillar("A");
    const sub = (await one(`select create_subtopic($1, 'Subtopic one') as r`, [a])).r.id as string;
    const p1 = await create({ pillar_id: a, post: { category: "picture_post" } }); // A-1
    const p2 = await create({ pillar_id: a, post: { category: "picture_post" } }); // A-2
    const scheduled = (await one(`insert into content_posts (title, platform, status, scheduled_date, premade_post_id) values ('A-2', 'instagram', 'scheduled', '2026-12-01', $1) returning id`, [p2.id])).id;
    const posted = (await one(`insert into content_posts (title, platform, status, scheduled_date, premade_post_id, caption) values ('A-2', 'facebook', 'posted', '2026-11-01', $1, 'Frozen') returning id`, [p2.id])).id;
    const out = (await one(`select move_premade_posts($1::uuid[], $2, $3, null, 'Test Person') as r`, [[p2.id, p1.id], a, sub])).r;
    expect(out.map((o: { old_name: string; new_name: string }) => `${o.old_name}>${o.new_name}`)).toEqual(["A-1>AA-1", "A-2>AA-2"]);
    expect((await one(`select name_history from premade_posts where id = $1`, [p2.id])).name_history).toEqual([{ name: "A-2", changed_at: expect.any(String) }]);
    expect((await one(`select title from content_posts where id = $1`, [scheduled])).title).toBe("AA-2");
    expect((await one(`select title from content_posts where id = $1`, [posted])).title).toBe("A-2");
    // Moving to a new subtopic creates it; moving back gives a new number (numbers are never reused).
    const back = (await one(`select move_premade_posts($1::uuid[], $2, null, null) as r`, [[p1.id], a])).r;
    expect(back[0]).toMatchObject({ old_name: "AA-1", new_name: "A-3" });
    const fresh = (await one(`select move_premade_posts($1::uuid[], $2, null, 'Subtopic two') as r`, [[p1.id], a])).r;
    expect(fresh[0]).toMatchObject({ old_name: "A-3", new_name: "AB-1" });
    const b = await pillar("B");
    await rejects(() => q(`select move_premade_posts($1::uuid[], $2, $3, null)`, [[p1.id], b, sub]), /subtopic of this topic/);
  });

  it("update_premade_caption: only the caption changes, stale versions conflict, oversize is refused, and history keeps the old caption", async () => {
    const a = await pillar("A");
    const p = await create({ pillar_id: a, post: { category: "picture_post", caption: "Caption one", hook: "Hook" } });
    const cur = await one(`select updated_at::text as u from premade_posts where id = $1`, [p.id]);
    const ok = (await one(`select update_premade_caption($1, $2::timestamptz, 'Caption two', 'Test Person', 'table_edit') as r`, [p.id, cur.u])).r;
    expect(ok.ok).toBe(true);
    expect(await one(`select caption, hook from premade_posts where id = $1`, [p.id])).toEqual({ caption: "Caption two", hook: "Hook" });
    const hist = await q(`select caption, changed_by_name, source from premade_post_caption_history where premade_post_id = $1`, [p.id]);
    expect(hist).toEqual([{ caption: "Caption one", changed_by_name: "Test Person", source: "table_edit" }]);
    const stale = (await one(`select update_premade_caption($1, $2::timestamptz, 'Caption three', 'Other Person', 'table_edit') as r`, [p.id, cur.u])).r;
    expect(stale).toMatchObject({ conflict: true, current_caption: "Caption two" });
    expect((await one(`select caption from premade_posts where id = $1`, [p.id])).caption).toBe("Caption two");
    await rejects(() => q(`select update_premade_caption($1, now(), $2, 'X', 'form')`, [p.id, "x".repeat(100001)]), /100000/);
    // A plain update (no actor set) records "Unknown"; an empty old caption is not saved.
    await q(`update premade_posts set caption = 'Caption four' where id = $1`, [p.id]);
    const empty = await create({ pillar_id: a, post: { category: "picture_post" } });
    await q(`update premade_posts set caption = 'First words' where id = $1`, [empty.id]);
    expect(await q(`select changed_by_name, source from premade_post_caption_history where premade_post_id = $1 order by changed_at, caption`, [p.id])).toContainEqual({ changed_by_name: "Unknown", source: "other" });
    expect(await q(`select 1 from premade_post_caption_history where premade_post_id = $1`, [empty.id])).toHaveLength(0);
  });

  it("caption history is append-only and both new tables follow the hub's row level security", async () => {
    const a = await pillar("A");
    const p = await create({ pillar_id: a, post: { category: "picture_post", caption: "Caption one" } });
    await q(`update premade_posts set caption = 'Caption two' where id = $1`, [p.id]);
    await asOwner(pg);
    const marketer = (await addEmployee(pg, { roles: [], email: "marketer@example.test" })).userId;
    const role = (await one(`insert into roles (name) values ('Marketing Test') returning id`)).id;
    await q(`insert into role_features (role_id, feature_key) values ($1, 'growth.marketing')`, [role]);
    await q(`insert into employee_roles (employee_id, role_id) select id, $1 from employee_accounts where user_id = $2`, [role, marketer]);
    const outsider = (await addEmployee(pg, { roles: [], email: "outsider@example.test" })).userId;
    await asUser(pg, marketer);
    expect(await q(`select caption from premade_post_caption_history`)).toHaveLength(1);
    await rejects(() => q(`update premade_post_caption_history set caption = 'Changed'`), /permission denied/);
    await rejects(() => q(`delete from premade_post_caption_history`), /permission denied/);
    await rejects(() => q(`delete from premade_post_products`), /permission denied/);
    await asUser(pg, outsider);
    expect(await q(`select caption from premade_post_caption_history`)).toHaveLength(0);
    await asAnon(pg);
    await rejects(() => q(`select 1 from premade_post_caption_history`), /permission denied/);
    await asOwner(pg);
  });

  it("the functions refuse anyone without the Marketing feature", async () => {
    const a = await pillar("A");
    await asOwner(pg);
    const outsider = (await addEmployee(pg, { roles: [], email: "outsider2@example.test" })).userId;
    await asUser(pg, outsider);
    await rejects(() => q(`select create_subtopic($1, 'Sub')`, [a]), /permission denied|access/);
    await asService(pg);
    expect((await one(`select create_subtopic($1, 'Sub') as r`, [a])).r.code).toBe("A");
    await asOwner(pg);
  });

  it("find_duplicate_post_names lists names shared by non-archived posts", async () => {
    const a = await pillar("A");
    const p1 = await create({ pillar_id: a, post: { category: "reel" } });
    expect((await one(`select find_duplicate_post_names() as r`)).r).toEqual([]);
    // An archived topic keeps its letter; a new active topic may reuse it.
    await q(`update content_pillars set archived_at = now() where id = $1`, [a]);
    const a2 = await pillar("A", "Topic A two");
    const p2 = await create({ pillar_id: a2, post: { category: "reel" } });
    expect((await one(`select find_duplicate_post_names() as r`)).r).toEqual([{ name: "A-1", post_ids: [p1.id, p2.id].sort() }]);
    await q(`update premade_posts set archived_at = now() where id = $1`, [p1.id]);
    expect((await one(`select find_duplicate_post_names() as r`)).r).toEqual([]);
  });

  it("calendar entries from the library may be scheduled with no caption; others still need one", async () => {
    const a = await pillar("A");
    const p = await create({ pillar_id: a, post: { category: "reel" } });
    await q(`insert into content_posts (title, platform, status, scheduled_date, premade_post_id, schedule_group_id) values ('A-1', 'instagram', 'scheduled', '2026-12-01', $1, gen_random_uuid())`, [p.id]);
    await rejects(() => q(`insert into content_posts (title, platform, status, scheduled_date) values ('Old entry', 'instagram', 'scheduled', '2026-12-01')`), /content_posts_ready_caption/);
    await q(`insert into content_posts (title, platform, status, scheduled_date, caption) values ('Old entry', 'instagram', 'scheduled', '2026-12-01', 'Has a caption')`);
  });

  it("sync_calendar_titles renames entries that aren't Posted after a topic letter changes", async () => {
    const a = await pillar("A");
    const p = await create({ pillar_id: a, post: { category: "reel" } });
    const open = (await one(`insert into content_posts (title, platform, status, scheduled_date, premade_post_id) values ('A-1', 'instagram', 'scheduled', '2026-12-01', $1) returning id`, [p.id])).id;
    const done = (await one(`insert into content_posts (title, platform, status, scheduled_date, premade_post_id, caption) values ('A-1', 'facebook', 'posted', '2026-11-01', $1, 'Frozen') returning id`, [p.id])).id;
    await q(`update content_pillars set code = 'C' where id = $1`, [a]);
    expect((await one(`select sync_calendar_titles(null) as r`)).r).toBe(1);
    expect((await one(`select title from content_posts where id = $1`, [open])).title).toBe("C-1");
    expect((await one(`select title from content_posts where id = $1`, [done])).title).toBe("A-1");
  });
});

describe("conversion SQL", () => {
  beforeEach(async () => {
    n = 0;
    await setup();
  }, 120_000);

  it("assigns letters and numbers like planConversion, sets counters, dismisses auto-name flags, and runs only once", async () => {
    const a = await pillar("A");
    const b = await pillar("B");
    const sB = await series(a, "Second", 2);
    const sA = await series(a, "First", 1);
    const sOther = await series(b, "Other", 0);
    const posts = [
      await legacyPost(a, sA, { series_position: 2, title: "Pos two" }),
      await legacyPost(a, sA, { series_position: 1, title: "Pos one" }),
      await legacyPost(a, sA, { series_position: null, title: "No pos", archived_at: new Date().toISOString() }),
      await legacyPost(a, sB, { title: "In second" }),
      await legacyPost(a, null, { title: "Loose one" }),
      await legacyPost(b, sOther, { category: "reel", title: "Reel in B" }),
      await legacyPost(b, null, { title: "Loose B" }),
    ];
    await q(`insert into premade_post_flags (premade_post_id, flag_key) values ($1, 'auto_name')`, [posts[0]]);
    const before = await q(`select id, caption, hook, hashtags, title from premade_posts order by id`);

    // Plan in TypeScript from the same rows.
    const pillars = await q<{ id: string; code: string }>(`select id, code from content_pillars`);
    const subs = await q<ConvSubtopic>(`select id, pillar_id, code, sort_order, created_at::text from content_series`);
    const convPosts = await q<ConvPost>(`select id, pillar_id, series_id, series_position, sort_order, created_at::text, post_number, title, archived_at from premade_posts`);
    const plan = planConversion(pillars, subs, convPosts);

    const preview = await q<{ section: string; proposed_name: string; current_name: string }>(conversion("01-preview.sql"));
    expect(preview.filter((r) => r.section.startsWith("PROBLEM"))).toEqual([]);
    expect(preview.filter((r) => r.section === "Post").map((r) => `${r.current_name}>${r.proposed_name}`).sort()).toEqual(plan.posts.map((p) => `${p.oldName}>${p.newName}`).sort());

    await pg.exec(conversion("02-apply.sql"));
    const names = Object.fromEntries((await q<{ title: string; n: string }>(`select title, premade_current_name(id) as n from premade_posts`)).map((r) => [r.title, r.n]));
    expect(names).toEqual({ "Pos one": "AA-1", "Pos two": "AA-2", "No pos": "AA-3", "In second": "AB-1", "Loose one": "A-1", "Reel in B": "BA-1", "Loose B": "B-1" });
    for (const p of plan.posts) expect(await nameOf(p.id)).toBe(p.newName);
    expect(await one(`select last_post_number from content_series where id = $1`, [sA])).toEqual({ last_post_number: 3 });
    expect(await one(`select last_unsorted_post_number from content_pillars where id = $1`, [a])).toEqual({ last_unsorted_post_number: 1 });
    expect((await one(`select name_history from premade_posts where id = $1`, [posts[0]])).name_history[0].name).toBe("A - Pos two");
    expect(await one(`select dismissed_by_name from premade_post_flags where premade_post_id = $1`, [posts[0]])).toEqual({ dismissed_by_name: "System conversion" });
    // No content changed.
    expect(await q(`select id, caption, hook, hashtags, title from premade_posts order by id`)).toEqual(before);
    // Running it again changes nothing; new posts continue the numbering.
    const snapshot = await q(`select id, post_number, name_history from premade_posts order by id`);
    await pg.exec(conversion("02-apply.sql"));
    expect(await q(`select id, post_number, name_history from premade_posts order by id`)).toEqual(snapshot);
    expect((await create({ pillar_id: a, series_id: sA, post: { category: "picture_post" } })).name).toBe("AA-4");
  });

  it("the preview reports a post whose subtopic is in another topic, and apply refuses to run", async () => {
    const a = await pillar("A");
    const b = await pillar("B");
    const sb = await series(b, "B sub");
    await legacyPost(a, sb, { title: "Wrong topic" });
    const preview = await q<{ section: string }>(conversion("01-preview.sql"));
    expect(preview.filter((r) => r.section === "PROBLEM: subtopic belongs to another topic")).toHaveLength(1);
    await rejects(() => pg.exec(conversion("02-apply.sql")), /subtopic that belongs to another topic/);
    await pg.exec("rollback"); // the SQL editor ends the failed transaction the same way
    expect(await q(`select 1 from premade_posts where post_number is not null`)).toHaveLength(0);
  });

  it("the backup copies the tables once per day", async () => {
    await pillar("A");
    await pg.exec(conversion("00-backup.sql"));
    const day = (await one(`select to_char(now() at time zone 'America/New_York', 'YYYYMMDD') as d`)).d;
    expect((await one(`select count(*)::int as c from ${`backup_${day}_content_pillars`}`)).c).toBe(1);
    await rejects(() => pg.exec(conversion("00-backup.sql")), /already exists/);
  });
});
