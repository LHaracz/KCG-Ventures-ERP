// supabase-migrations/marketing_sales.sql in PGlite: constraints, supplier
// lead times, the claim triggers (approved text edits reset to draft, only
// Admins approve/reject/retire, claim_events append-only), the 60 line
// limit, and row level security per feature (Admin-only line sheets, no
// anon). Invented data only ("Store A", "Product A", example.test).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addEmployee, asAnon, asOwner, asService, asUser, createAccessDb, migration } from "./helpers/accessDb";

let pg: PGlite;
const users: Record<string, { userId: string; accountId: string }> = {};
let productId: string;
let profileId: string;
let fpId: string;
let materialId: string;
let supplierLinkId: string;
let retailerId: string;

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

async function role(name: string, features: string[]) {
  const r = await one<{ id: string }>(`insert into roles (name) values ($1) returning id`, [name]);
  for (const f of features) await pg.query(`insert into role_features (role_id, feature_key) values ($1, $2)`, [r.id, f]);
}

beforeAll(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql"]) {
    try {
      await pg.exec(migration(f));
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`);
    }
  }
  // Safe to run twice.
  await pg.exec(migration("marketing_sales.sql"));
  await pg.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
  // The migration's own grants (no delete for authenticated) win again after the blanket test grant.
  await pg.exec(migration("marketing_sales.sql"));

  await role("Marketer", ["growth.marketing"]);
  await role("Launcher", ["growth.launches"]);
  await role("Prospector", ["growth.prospecting"]);
  users.admin = await addEmployee(pg, { roles: ["Admin"], first: "Ada", last: "Admin" });
  users.marketer = await addEmployee(pg, { roles: ["Marketer"], first: "Mia", last: "Market" });
  users.launcher = await addEmployee(pg, { roles: ["Launcher"] });
  users.prospector = await addEmployee(pg, { roles: ["Prospector"] });
  users.warehouse = await addEmployee(pg, { roles: ["Warehouse Operations"] });
  users.inactive = await addEmployee(pg, { roles: ["Marketer"], status: "deactivated" });

  productId = (await one<{ id: string }>(`insert into products (name, unit, sale_price_per_unit) values ('Product A', 'each', 8) returning id`)).id;
  profileId = (await one<{ id: string }>(`select id from company_profiles where display_name = 'BotanIQals'`)).id;
  fpId = (await one<{ id: string }>(`insert into formulation_products (name) values ('Product A') returning id`)).id;
  materialId = (await one<{ id: string }>(`insert into inventory_items (name, unit, quantity_on_hand) values ('Material A', 'g', 100) returning id`)).id;
  const supplier = await one<{ id: string }>(`insert into suppliers (name) values ('Supplier A') returning id`);
  supplierLinkId = (await one<{ id: string }>(`insert into raw_material_suppliers (raw_material_id, supplier_id) values ($1, $2) returning id`, [materialId, supplier.id])).id;
  retailerId = (await one<{ id: string }>(
    `insert into retailers (name, billing_line1, billing_city, billing_state, billing_zip) values ('Store A', '1 Market Way', 'Shopton', 'PA', '19100') returning id`,
  )).id;
}, 120_000);

describe("supplier lead times", () => {
  it("two nullable columns, 0 to 365 days, note up to 200", async () => {
    await asOwner(pg);
    await pg.query(`update raw_material_suppliers set lead_time_days = 0, lead_time_note = 'Ships same day' where id = $1`, [supplierLinkId]);
    await pg.query(`update raw_material_suppliers set lead_time_days = 365 where id = $1`, [supplierLinkId]);
    await fails(`update raw_material_suppliers set lead_time_days = 366 where id = $1`, [supplierLinkId], /rms_lead_time_days_range/);
    await fails(`update raw_material_suppliers set lead_time_days = -1 where id = $1`, [supplierLinkId]);
    await fails(`update raw_material_suppliers set lead_time_note = repeat('x', 201) where id = $1`, [supplierLinkId], /rms_lead_time_note_len/);
    await pg.query(`update raw_material_suppliers set lead_time_days = null, lead_time_note = null where id = $1`, [supplierLinkId]);
  });
});

describe("constraints", () => {
  it("launches, tasks and ingredients", async () => {
    await asOwner(pg);
    const l = await one<{ id: string }>(`insert into launches (name, target_launch_date, formulation_product_id) values ('Launch A', '2027-03-15', $1) returning id`, [fpId]);
    await fails(`insert into launches (name, target_launch_date, status) values ('X', '2027-03-15', 'done')`, [], /launches_status_ok/);
    await fails(`insert into launches (name, target_launch_date, buffer_days) values ('X', '2027-03-15', 31)`, [], /launches_buffer_ok/);
    await fails(`insert into launches (name, target_launch_date, test_batch_units) values ('X', '2027-03-15', 0)`, [], /launches_units_ok/);
    await fails(`insert into launches (name) values ('X')`, [], /target_launch_date/);
    await fails(`insert into launch_tasks (launch_id, title, phase) values ($1, 'T', 'marketing')`, [l.id], /launch_tasks_phase_ok/);
    await fails(`insert into launch_tasks (launch_id, title, auto_kind) values ($1, 'T', 'other')`, [l.id], /launch_tasks_auto_ok/);
    await pg.query(`insert into launch_ingredients (launch_id, raw_material_id, supplier_link_id) values ($1, $2, $3)`, [l.id, materialId, supplierLinkId]);
    await fails(`insert into launch_ingredients (launch_id, raw_material_id) values ($1, $2)`, [l.id, materialId], /launch_ingredients_unique/);
    await fails(`update launch_ingredients set status = 'ordered' where launch_id = $1`, [l.id], /launch_ingredients_ordered_has_date/);
    await fails(`update launch_ingredients set status = 'arrived', arrived_at = '2026-11-20' where launch_id = $1`, [l.id], /launch_ingredients_arrived_has_date/);
    await fails(`update launch_ingredients set qty_ordered = -1 where launch_id = $1`, [l.id], /launch_ingredients_qty_ok/);
    // Date-only columns are dates.
    const types = await pg.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name in ('launches', 'launch_tasks', 'launch_ingredients', 'leads', 'lead_activities', 'trips', 'claims', 'content_posts')
       and column_name in ('target_launch_date', 'planned_test_batch_date', 'due_date', 'ordered_at', 'expected_arrival', 'arrived_at', 'next_follow_up_date', 'activity_date', 'trip_date', 'review_again_on', 'scheduled_date', 'posted_at')`,
    );
    expect(types.rows.length).toBeGreaterThanOrEqual(12);
    for (const r of types.rows) expect(r.data_type, r.column_name).toBe("date");
  });

  it("leads, activities, trips and the settings row", async () => {
    await asOwner(pg);
    await fails(`insert into leads (name, website_url) values ('Store B', 'javascript:alert(1)')`, [], /leads_website_ok/);
    await fails(`insert into leads (name, category) values ('Store B', 'bar')`, [], /leads_category_ok/);
    await fails(`insert into leads (name, status) values ('Store B', 'maybe')`, [], /leads_status_ok/);
    const lead = await one<{ id: string }>(`insert into leads (name, website_url) values ('Store B', 'https://store-b.example.test') returning id`);
    await fails(`insert into lead_activities (lead_id, activity_date, type) values ($1, '2026-11-17', 'fax')`, [lead.id], /lead_activities_type_ok/);
    const trip = await one<{ id: string }>(`insert into trips (name, trip_date) values ('Trip A', '2026-11-20') returning id`);
    await pg.query(`insert into trip_stops (trip_id, lead_id) values ($1, $2)`, [trip.id, lead.id]);
    await fails(`insert into trip_stops (trip_id, lead_id) values ($1, $2)`, [trip.id, lead.id], /trip_stops_unique/);
    expect(await count(`select count(*) n from prospecting_settings`)).toBe(1);
    await fails(`insert into prospecting_settings (id) values (false)`);
  });

  it("assets, posts, risky words", async () => {
    await asOwner(pg);
    await fails(`insert into marketing_assets (title, source) values ('A', 'upload')`, [], /marketing_assets_source_ok/);
    await fails(`insert into marketing_assets (title, source, file_path, mime_type, size_bytes) values ('A', 'upload', 'x/a.gif', 'image/gif', 10)`, [], /marketing_assets_source_ok/);
    await fails(`insert into marketing_assets (title, source, file_path, mime_type, size_bytes) values ('A', 'upload', 'x/a.png', 'image/png', 26214401)`, [], /marketing_assets_source_ok/);
    await fails(`insert into marketing_assets (title, source, url) values ('A', 'link', 'ftp://files.example.test/a')`, [], /marketing_assets_url_ok/);
    await pg.query(`insert into marketing_assets (title, source, url, asset_type) values ('Reel A', 'link', 'https://drive.example.test/reel-a', 'video')`);
    await fails(`insert into content_posts (title, status) values ('Post A', 'ready')`, [], /content_posts_ready_caption/);
    await fails(`insert into content_posts (title, platform) values ('Post A', 'myspace')`, [], /content_posts_platform_ok/);
    expect(await count(`select count(*) n from risky_words`)).toBe(21);
    await fails(`insert into risky_words (phrase) values ('fda APPROVED ')`, [], /risky_words_phrase_unique/);
  });

  it("line sheets: price basis fields and at most 60 lines", async () => {
    await asOwner(pg);
    await fails(`insert into line_sheets (name, company_profile_id, price_basis) values ('LS', $1, 'retailer')`, [profileId], /line_sheets_basis_fields/);
    await fails(`insert into line_sheets (name, company_profile_id, price_basis, standard_wholesale_percent) values ('LS', $1, 'standard', 0)`, [profileId], /line_sheets_percent_ok/);
    const ls = await one<{ id: string }>(
      `insert into line_sheets (name, company_profile_id, price_basis, retailer_id) values ('LS A', $1, 'retailer', $2) returning id`,
      [profileId, retailerId],
    );
    await pg.query(
      `insert into line_sheet_lines (line_sheet_id, line_number, product_id, name, wholesale_price, msrp)
       select $1, n, $2, 'Product A', 4.5, 8 from generate_series(1, 60) n`,
      [ls.id, productId],
    );
    await fails(`insert into line_sheet_lines (line_sheet_id, line_number, name) values ($1, 61, 'Too many')`, [ls.id], /line_sheet_lines_number_ok|at most 60/);
    await pg.query(`delete from line_sheet_lines where line_sheet_id = $1 and line_number = 60`, [ls.id]);
    await pg.query(`update line_sheet_lines set line_number = 60 where line_sheet_id = $1 and line_number = 59`, [ls.id]);
    await fails(`insert into line_sheet_lines (line_sheet_id, line_number, name, msrp) values ($1, 59, 'P', -1)`, [ls.id], /line_sheet_lines_prices_ok/);
    // A 61st row is refused by the trigger even with a valid number.
    await pg.query(`insert into line_sheet_lines (line_sheet_id, line_number, name) values ($1, 59, 'Back to 60')`, [ls.id]);
    await pg.exec(`alter table line_sheet_lines drop constraint line_sheet_lines_number_ok`);
    await fails(`insert into line_sheet_lines (line_sheet_id, line_number, name) values ($1, 61, 'Too many')`, [ls.id], /at most 60 products/);
    await pg.exec(`alter table line_sheet_lines add constraint line_sheet_lines_number_ok check (line_number between 1 and 60)`);
  });
});

describe("claims", () => {
  const events = async (id: string) =>
    (await pg.query<{ event: string; actor_name: string | null; note: string | null; claim_text_snapshot: string }>(
      `select event, actor_name, note, claim_text_snapshot from claim_events where claim_id = $1 order by created_at, event`,
      [id],
    )).rows;

  it("every change is logged; editing an approved claim resets it to draft", async () => {
    await asService(pg);
    const c = await one<{ id: string }>(`insert into claims (claim_text, created_by_name) values ('Claim A', 'Mia Market') returning id`);
    await pg.query(`update claims set status = 'in_review', updated_by_name = 'Mia Market' where id = $1`, [c.id]);
    await pg.query(`update claims set status = 'approved', reviewed_by_name = 'Ada Admin', reviewed_at = now(), review_note = 'OK', updated_by_name = 'Ada Admin' where id = $1`, [c.id]);
    await pg.query(`update claims set claim_text = 'Claim A, reworded', updated_by_name = 'Mia Market' where id = $1`, [c.id]);
    const after = await one<{ status: string; reviewed_by_name: string | null; reviewed_at: string | null; review_note: string | null }>(
      `select status, reviewed_by_name, reviewed_at, review_note from claims where id = $1`,
      [c.id],
    );
    expect(after).toEqual({ status: "draft", reviewed_by_name: null, reviewed_at: null, review_note: null });
    await pg.query(`update claims set evidence_note = 'Source A', updated_by_name = 'Mia Market' where id = $1`, [c.id]);
    await pg.query(`update claims set evidence_note = 'Source A' where id = $1`, [c.id]); // no real change: no event
    const ev = await events(c.id);
    expect(ev.map((e) => e.event)).toEqual(["created", "submitted", "approved", "reset_to_draft", "edited"]);
    expect(ev[2]).toMatchObject({ actor_name: "Ada Admin", note: "OK", claim_text_snapshot: "Claim A" });
    expect(ev[3]).toMatchObject({ actor_name: "Mia Market", claim_text_snapshot: "Claim A, reworded" });
    await fails(`update claims set status = 'rejected' where id = $1`, [c.id], /claims_reject_needs_note/);
  });

  it("only Admins approve, reject or retire from the browser; history is append-only", async () => {
    await asUser(pg, users.marketer.userId);
    const c = await one<{ id: string }>(`insert into claims (claim_text, created_by_name) values ('Claim B', 'Mia Market') returning id`);
    await pg.query(`update claims set status = 'in_review' where id = $1`, [c.id]);
    await fails(`update claims set status = 'approved' where id = $1`, [c.id], /Only an Admin/);
    await fails(`update claims set status = 'retired' where id = $1`, [c.id], /Only an Admin/);
    await fails(`insert into claims (claim_text, status) values ('Claim C', 'approved')`, [], /Only an Admin/);
    expect((await pg.query(`select * from claim_events where claim_id = $1`, [c.id])).rows.length).toBe(2);
    await fails(`insert into claim_events (claim_id, event) values ($1, 'approved')`, [c.id]);

    await asUser(pg, users.admin.userId);
    await pg.query(`update claims set status = 'rejected', review_note = 'Needs a source' where id = $1`, [c.id]);
    await pg.query(`update claims set status = 'draft' where id = $1`, [c.id]);
    await pg.query(`update claims set status = 'retired', review_note = 'Old' where id = $1`, [c.id]);

    await asOwner(pg);
    await fails(`update claim_events set note = 'x' where claim_id = $1`, [c.id], /can't be changed/);
    await fails(`delete from claim_events where claim_id = $1`, [c.id], /can't be changed/);
    expect((await events(c.id)).map((e) => e.event)).toEqual(["created", "submitted", "rejected", "reset_to_draft", "retired"]);
  });
});

describe("row level security", () => {
  const tables = {
    "growth.launches": ["launches", "launch_tasks", "launch_ingredients", "launch_events"],
    "growth.prospecting": ["leads", "lead_activities", "trips", "trip_stops", "prospecting_settings"],
    "growth.marketing": ["marketing_assets", "marketing_product_profiles", "claims", "claim_events", "content_posts", "content_post_assets", "content_post_claims", "caption_templates"],
    admin: ["line_sheets", "line_sheet_lines"],
  } as const;
  const who: Record<string, keyof typeof users> = { "growth.launches": "launcher", "growth.prospecting": "prospector", "growth.marketing": "marketer" };

  it("each table is readable only with its feature (Admins always); Admin-only tables for Admins only", async () => {
    await asOwner(pg);
    await pg.query(`insert into leads (name) values ('Store C')`);
    await pg.query(`insert into caption_templates (name, body) values ('Template A', 'Hi {product_name}')`);
    await pg.query(`insert into launch_events (launch_id, event) select id, 'created' from launches limit 1`);
    await pg.query(`insert into launch_tasks (launch_id, title) select id, 'Task A' from launches limit 1`);
    await pg.query(`insert into lead_activities (lead_id, activity_date, type) select id, '2026-11-17', 'visit' from leads limit 1`);
    await pg.query(`insert into marketing_product_profiles (formulation_product_id, tagline) values ($1, 'Tagline A')`, [fpId]);
    const post = await one<{ id: string }>(`insert into content_posts (title) values ('Post A') returning id`);
    await pg.query(`insert into content_post_assets (post_id, asset_id) select $1, id from marketing_assets limit 1`, [post.id]);
    await pg.query(`insert into content_post_claims (post_id, claim_id) select $1, id from claims limit 1`, [post.id]);
    const rows = async (t: string) => (await pg.query(`select 1 from ${t}`)).rows.length;
    for (const [feature, list] of Object.entries(tables)) {
      for (const t of list) {
        await asOwner(pg);
        const total = await rows(t);
        expect(total, `${t} has rows`).toBeGreaterThan(0);
        await asUser(pg, users.admin.userId);
        expect(await rows(t), `admin ${t}`).toBe(total);
        for (const [f, u] of Object.entries(who)) {
          await asUser(pg, users[u].userId);
          expect(await rows(t), `${u} ${t}`).toBe(f === feature ? total : 0);
        }
        await asUser(pg, users.warehouse.userId);
        expect(await rows(t), `warehouse ${t}`).toBe(0);
        await asUser(pg, users.inactive.userId);
        expect(await rows(t), `inactive ${t}`).toBe(0);
        await asAnon(pg);
        await fails(`select 1 from ${t}`, [], /permission denied/);
      }
    }
  });

  it("writes need the feature; nobody deletes from the browser; risky words are Admin-only to change", async () => {
    await asUser(pg, users.marketer.userId);
    await fails(`insert into launches (name, target_launch_date) values ('X', '2027-01-01')`, [], /row-level security/);
    await fails(`insert into leads (name) values ('Store X')`, [], /row-level security/);
    await pg.query(`insert into caption_templates (name, body) values ('Template B', 'Body')`);
    await fails(`delete from caption_templates`, [], /permission denied/);
    expect((await pg.query(`select 1 from risky_words`)).rows.length).toBe(21);
    await fails(`insert into risky_words (phrase) values ('miracle')`, [], /row-level security/);
    expect((await pg.query(`update risky_words set note = 'x' returning 1`)).rows.length).toBe(0);

    await asUser(pg, users.launcher.userId);
    await pg.query(`insert into launches (name, target_launch_date) values ('Launch B', '2027-01-01')`);
    expect((await pg.query(`select 1 from risky_words`)).rows.length).toBe(0);
    await fails(`insert into launch_events (launch_id, event) select id, 'created' from launches limit 1`, [], /permission denied/);

    await asUser(pg, users.prospector.userId);
    await pg.query(`insert into leads (name) values ('Store D')`);
    await fails(`insert into line_sheets (name, company_profile_id, price_basis, standard_wholesale_percent) values ('LS', $1, 'standard', 50)`, [profileId], /row-level security/);

    await asUser(pg, users.admin.userId);
    await pg.query(`insert into risky_words (phrase, note) values ('miracle', 'Starter list addition')`);
    await pg.query(`insert into line_sheets (name, company_profile_id, price_basis, standard_wholesale_percent) values ('LS B', $1, 'standard', 50)`, [profileId]);
    await fails(`delete from line_sheets`, [], /permission denied/);
  });

  it("the private bucket exists with no browser policies", async () => {
    await asOwner(pg);
    const b = await one<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'marketing-assets'`);
    expect(b).toEqual({ public: false, file_size_limit: 26214400, allowed_mime_types: ["image/png", "image/jpeg", "image/webp", "application/pdf"] });
    const policies = await pg.query(`select policyname from pg_policies where schemaname = 'storage' and qual::text ilike '%marketing-assets%'`);
    expect(policies.rows).toEqual([]);
  });
});
