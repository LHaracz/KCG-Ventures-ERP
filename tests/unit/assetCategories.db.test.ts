// asset_categories.sql and the category add/delete server code against the
// real migrations in PGlite. Invented names only ("Category A", "Photo A").
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import { assetBulk, createAssetCategory, deleteAssetCategory } from "@/lib/growth/libraryService";
import { createLinkAsset, loadMarketing, updateAsset } from "@/lib/growth/marketingService";
import type { Db } from "@/lib/growth/routeHelpers";

let pg: PGlite;
let db: Db;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(re);
};
const link = (title: string, category: string, extra: Record<string, unknown> = {}) =>
  createLinkAsset(db, { title, category, asset_type: "photo", url: "https://files.example.test/a", ...extra }, "Test Person");
const BEFORE = ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql", "ad_library.sql", "marketing_assets_media.sql", "marketing_assets_mov.sql"];

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of BEFORE) await pg.exec(migration(f));
  db = pgliteSupabase(pg) as unknown as Db;
}, 120_000);

describe("migration", () => {
  it("adds the six built-ins once, keeps existing assets, and never brings back a deleted one", async () => {
    await q(`insert into marketing_assets (title, source, url, category) values ('Old A', 'link', 'https://files.example.test/old', 'market'), ('Old B', 'link', 'https://files.example.test/old2', null)`);
    await pg.exec(migration("asset_categories.sql"));
    expect((await q(`select key, label from asset_categories order by sort_order`)).map((r) => r.label)).toEqual(["Product", "Group product", "Ingredient", "Markets", "Retail", "Other"]);
    expect((await q(`select title, category from marketing_assets order by title`))).toEqual([{ title: "Old A", category: "market" }, { title: "Old B", category: null }]);
    await q(`delete from asset_categories where key = 'retail'`);
    await pg.exec(migration("asset_categories.sql"));
    expect((await q(`select key from asset_categories`)).map((r) => r.key)).not.toContain("retail");
  });

  it("an asset's category must exist, and a category in use can't be deleted (archived assets too)", async () => {
    await pg.exec(migration("asset_categories.sql"));
    await rejects(() => q(`insert into marketing_assets (title, source, url, category) values ('X', 'link', 'https://files.example.test/x', 'nope')`), /marketing_assets_category_fk|foreign key/);
    await q(`insert into marketing_assets (title, source, url, category, status) values ('Y', 'link', 'https://files.example.test/y', 'retail', 'archived')`);
    await rejects(() => q(`delete from asset_categories where key = 'retail'`), /marketing_assets_category_fk|foreign key/);
  });
});

describe("adding and deleting categories", () => {
  beforeEach(async () => {
    await pg.exec(migration("asset_categories.sql"));
    await pg.exec(migration("marketing_naming.sql")); // loadMarketing reads the calendar's schedule groups
  });

  it("adds a category before Other, with unique names, and assets can use it with no extra rules", async () => {
    const { category } = await createAssetCategory(db, { label: "  Category   A " }, "Test Person");
    expect(category).toMatchObject({ label: "Category A", is_builtin: false });
    expect(category.key).toMatch(/^c_[0-9a-f]{12}$/);
    await rejects(() => createAssetCategory(db, { label: "category a" }, null), /already exists/);
    await rejects(() => createAssetCategory(db, { label: "" }, null), /Enter a category name/);
    await rejects(() => createAssetCategory(db, { label: "x".repeat(61) }, null), /60 characters/);
    await rejects(() => createAssetCategory(db, { label: "Uncategorized" }, null), /reserved/);
    const { category: b } = await createAssetCategory(db, { label: "Category B" }, null);
    const data = await loadMarketing(db);
    expect(data.assetCategories.map((c) => c.label)).toEqual(["Product", "Group product", "Ingredient", "Markets", "Retail", "Category A", "Category B", "Other"]);
    const a = await link("Photo A", category.key);
    expect(a.category).toBe(category.key);
    expect((await updateAsset(db, a.id, { title: "Photo A", category: b.key, asset_type: "photo", url: "https://files.example.test/a" })).category).toBe(b.key);
    await rejects(() => link("Photo B", "c_000000000000"), /Choose a category|missing or not valid/);
  });

  it("deletes only when no asset uses it, archived ones included", async () => {
    const { category } = await createAssetCategory(db, { label: "Category A" }, null);
    const a = await link("Photo A", category.key);
    await updateAsset(db, a.id, { status: "archived" });
    await rejects(() => deleteAssetCategory(db, category.key), /1 asset uses this category \(1 archived\)/);
    // Move it with the bulk "Set category" action, then delete.
    expect(await assetBulk(db, { ids: [a.id], action: "set_category", category: "market" })).toMatchObject({ updated: 1 });
    expect(await deleteAssetCategory(db, category.key)).toEqual({ deleted: "Category A" });
    expect(await q(`select 1 from asset_categories where key = $1`, [category.key])).toHaveLength(0);
    await rejects(() => deleteAssetCategory(db, category.key), /already deleted/);
  });

  it("built-ins can be deleted when empty; their rules go with them", async () => {
    await link("Photo A", "market");
    await rejects(() => deleteAssetCategory(db, "market"), /1 asset uses this category/);
    expect(await deleteAssetCategory(db, "product")).toEqual({ deleted: "Product" });
    await rejects(() => link("Photo B", "product"), /Choose a category|missing or not valid/);
    await rejects(() => deleteAssetCategory(db, "../etc"), /Unknown category/);
  });
});
