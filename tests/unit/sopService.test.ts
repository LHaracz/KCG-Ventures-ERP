// End-to-end service tests (publish, frozen snapshots, automatic versions)
// against the real migration SQL in an in-memory Postgres. Invented data only.
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import { publishDraft, reconcileSopFormulaTables, sopsUsingProduct, syncSopFormulaTables, SopError } from "@/lib/sopService";
import { loadProductFormula } from "@/lib/sopFormulaData";
import type { DocNode } from "@/lib/sopDocument";
import { buildFormulaTable, cellDisplay } from "@/lib/formulaTable";

const root = path.resolve(__dirname, "../..");
const sql = (f: string) => readFileSync(path.join(root, "supabase-migrations", f), "utf8");

const ID = {
  sop: "aaaaaaaa-1111-4000-8000-000000000001",
  pA: "bbbbbbbb-1111-4000-8000-00000000000a",
  pB: "bbbbbbbb-1111-4000-8000-00000000000b",
  fpA: "dddddddd-1111-4000-8000-00000000000a",
  fpB: "dddddddd-1111-4000-8000-00000000000b",
  fA1: "cccccccc-1111-4000-8000-0000000000a1",
  fA2: "cccccccc-1111-4000-8000-0000000000a2",
  fB1: "cccccccc-1111-4000-8000-0000000000b1",
  iA: "eeeeeeee-1111-4000-8000-00000000000a",
  iD: "eeeeeeee-1111-4000-8000-00000000000d",
  iF: "eeeeeeee-1111-4000-8000-00000000000f",
  nodeA: "f0000000-1111-4000-8000-00000000000a",
  nodeB: "f0000000-1111-4000-8000-00000000000b",
};

const DOC: DocNode = {
  type: "doc",
  content: [
    { type: "formulaTable", attrs: { nodeId: ID.nodeA, productId: ID.pA, showSource: true } },
    { type: "heading", attrs: { level: 1, textAlign: null, indent: 0 }, content: [{ type: "text", text: "Invented Title" }] },
    { type: "paragraph", attrs: { textAlign: null, indent: 0 }, content: [{ type: "text", text: "Invented description 12 g." }] },
    {
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "Manual" }] }] }] },
        { type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "Typed by hand" }] }] }] },
      ],
    },
    { type: "formulaTable", attrs: { nodeId: ID.nodeB, productId: ID.pB, showSource: false } },
  ],
};

let pg: PGlite;
let client: ReturnType<typeof pgliteSupabase>;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
    create table products (id uuid primary key default gen_random_uuid(), name text not null, is_microgreen boolean default false);
    create table inventory_items (id uuid primary key default gen_random_uuid(), name text not null, unit text, cost_per_unit numeric);
    create table variant_component_map (id uuid primary key default gen_random_uuid());
    create table bom_lines (id uuid primary key default gen_random_uuid(), product uuid, line_type text, inventory_item uuid, qty_per_unit numeric, unit_label text);
  `);
  await pg.exec(sql("formulation.sql"));
  await pg.exec(sql("compliance_sops.sql"));
  await pg.exec(sql("sop_editable_documents.sql"));
  await pg.exec(`
    insert into products (id, name) values ('${ID.pA}', 'Test Product A'), ('${ID.pB}', 'Test Product B');
    insert into inventory_items (id, name, unit) values ('${ID.iA}', 'Ingredient A', 'g'), ('${ID.iD}', 'Ingredient D', 'kg'), ('${ID.iF}', 'Ingredient F', 'each');
    insert into formulation_products (id, name, product_id, status) values ('${ID.fpA}', 'Test Product A', '${ID.pA}', 'active'), ('${ID.fpB}', 'Test Product B', '${ID.pB}', 'active');
    insert into formulations (id, formulation_product_id, version_number, status, finalized_at) values
      ('${ID.fA1}', '${ID.fpA}', 1, 'final', '2026-03-01T15:00:00Z'),
      ('${ID.fB1}', '${ID.fpB}', 1, 'final', '2026-03-01T15:00:00Z');
    insert into formulation_lines (formulation_id, raw_material_id, qty_per_unit, sort_order) values
      ('${ID.fA1}', '${ID.iA}', 12.5, 0), ('${ID.fA1}', '${ID.iD}', 0.002, 1), ('${ID.fA1}', '${ID.iF}', 2, 2),
      ('${ID.fB1}', '${ID.iA}', 0.04, 0);
    insert into bom_lines (product, line_type, inventory_item, qty_per_unit) values
      ('${ID.pA}', 'inventory_item', '${ID.iA}', 12.5), ('${ID.pA}', 'inventory_item', '${ID.iD}', 0.002), ('${ID.pA}', 'inventory_item', '${ID.iF}', 2);
    insert into sops (id, title, format, draft_content, draft_revision) values ('${ID.sop}', '[TEST] Service SOP', 'document', $json$${JSON.stringify(DOC)}$json$::jsonb, 1);
  `);
  client = pgliteSupabase(pg);
}, 60000);

async function versions() {
  const r = await pg.query<{ version_number: number; is_current: boolean; content: DocNode; formula_snapshot: any; source: string; change_note: string; published_by_name: string; effective_date: string; trigger_formulation_id: string | null }>(
    `select version_number, is_current, content, formula_snapshot, source, change_note, published_by_name, effective_date::text, trigger_formulation_id from sop_versions where sop_id = $1 order by version_number`,
    [ID.sop],
  );
  return r.rows;
}

describe("live formula data", () => {
  it("reads exact decimal strings and detects BOM agreement", async () => {
    const f = await loadProductFormula(client, ID.pA);
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.versionNumber).toBe(1);
    expect(f.rows).toEqual([
      { name: "Ingredient A", unit: "g", qtyPerUnit: "12.5" },
      { name: "Ingredient D", unit: "kg", qtyPerUnit: "0.002" },
      { name: "Ingredient F", unit: "each", qtyPerUnit: "2" },
    ]);
    expect(f.bomDiffers).toBe(false);
    const b = await loadProductFormula(client, ID.pB);
    expect(b.status === "ok" && b.bomDiffers).toBe(true); // product B has no BOM lines
  });
});

describe("publish", () => {
  it("rejects a stale draft revision", async () => {
    await expect(
      publishDraft(client, { sopId: ID.sop, userId: null, changeNote: "x", effectiveDate: "2026-03-02", publishedByName: "Tester", expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(SopError);
  });

  it("creates an immutable version with a frozen snapshot", async () => {
    await publishDraft(client, { sopId: ID.sop, userId: null, changeNote: "First", effectiveDate: "2026-03-02", publishedByName: "Tester", expectedRevision: 1 });
    const [v1] = await versions();
    expect(v1.version_number).toBe(1);
    expect(v1.is_current).toBe(true);
    expect(v1.source).toBe("editor");
    expect(v1.content).toEqual(DOC);
    expect(v1.formula_snapshot[ID.nodeA].formulationId).toBe(ID.fA1);
    expect(v1.formula_snapshot[ID.nodeA].rows[0]).toEqual({ name: "Ingredient A", unit: "g", qtyPerUnit: "12.5" });
    expect(v1.formula_snapshot[ID.nodeB].formulationId).toBe(ID.fB1);
    await expect(pg.query(`update sop_versions set formula_snapshot = '{}' where sop_id = $1`, [ID.sop])).rejects.toThrow(/immutable/);
    const sop = await pg.query<{ draft_content: unknown }>(`select draft_content from sops where id = $1`, [ID.sop]);
    expect(sop.rows[0].draft_content).toBeNull();
    const using = await sopsUsingProduct(client, ID.pA);
    expect(using.map((u) => u.upToDate)).toEqual([true]);
  });
});

describe("automatic versions when a formula changes", () => {
  it("creates exactly one version, copies content exactly, keeps old numbers, leaves drafts alone", async () => {
    // A pending draft must not be touched.
    const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Unpublished edit" }] }] };
    await pg.query(`update sops set draft_content = $1::jsonb, draft_revision = draft_revision + 1 where id = $2`, [JSON.stringify(draft), ID.sop]);

    // Finish Iteration: product A formula v2 (A changes 12.5 -> 13, F removed).
    await pg.exec(`
      insert into formulations (id, formulation_product_id, version_number, status, finalized_at, change_summary)
        values ('${ID.fA2}', '${ID.fpA}', 2, 'final', '2026-04-01T03:30:00Z', 'Raised A.');
      insert into formulation_lines (formulation_id, raw_material_id, qty_per_unit, sort_order) values
        ('${ID.fA2}', '${ID.iA}', 13, 0), ('${ID.fA2}', '${ID.iD}', 0.002, 1);
    `);
    const using = await sopsUsingProduct(client, ID.pA);
    expect(using.map((u) => u.upToDate)).toEqual([false]);

    const r1 = await syncSopFormulaTables(client, ID.pA, ID.fA2);
    expect(r1.filter((r) => r.outcome === "created")).toHaveLength(1);
    const r2 = await syncSopFormulaTables(client, ID.pA, ID.fA2);
    expect(r2.filter((r) => r.outcome === "created")).toHaveLength(0);
    const r3 = await reconcileSopFormulaTables(client);
    expect(r3.filter((r) => r.outcome === "created")).toHaveLength(0);

    const [v1, v2] = await versions();
    expect(v2.version_number).toBe(2);
    expect(v2.is_current).toBe(true);
    expect(v1.is_current).toBe(false);
    expect(v2.source).toBe("auto_formula_update");
    expect(v2.trigger_formulation_id).toBe(ID.fA2);
    expect(v2.content).toEqual(v1.content); // body never changes
    expect(v2.published_by_name).toBe("System"); // finalized_by was null
    expect(v2.effective_date).toBe("2026-03-31"); // finalized 2026-04-01 03:30 UTC = Mar 31 in New York
    expect(v2.change_note).toBe("Formula table updated automatically: Test Product A formula v1 to v2. Raised A.");

    // Only product A's node was re-captured; product B's node kept its stored rows.
    expect(v2.formula_snapshot[ID.nodeA].formulationId).toBe(ID.fA2);
    expect(v2.formula_snapshot[ID.nodeB]).toEqual(v1.formula_snapshot[ID.nodeB]);

    // Old version still shows the old numbers; new version the new ones.
    const t1 = buildFormulaTable(v1.formula_snapshot[ID.nodeA].rows);
    const t2 = buildFormulaTable(v2.formula_snapshot[ID.nodeA].rows);
    expect(cellDisplay(t1, "Ingredient A", 20)).toBe("250");
    expect(cellDisplay(t2, "Ingredient A", 20)).toBe("260");
    expect(cellDisplay(t1, "Ingredient F", 1)).toBe("2 each");
    expect(cellDisplay(t2, "Ingredient F", 1)).toBeUndefined();

    const sop = await pg.query<{ draft_content: unknown }>(`select draft_content from sops where id = $1`, [ID.sop]);
    expect(sop.rows[0].draft_content).toEqual(draft);
    expect((await sopsUsingProduct(client, ID.pA)).map((u) => u.upToDate)).toEqual([true]);
  });

  it("ignores a formulation that is not the product's latest final one", async () => {
    const r = await syncSopFormulaTables(client, ID.pA, ID.fA1);
    expect(r).toEqual([]);
    expect(await versions()).toHaveLength(2);
  });

  it("renaming a raw material does not create a version", async () => {
    await pg.query(`update inventory_items set name = 'Ingredient A renamed' where id = $1`, [ID.iA]);
    const r = await reconcileSopFormulaTables(client);
    expect(r.filter((x) => x.outcome === "created")).toHaveLength(0);
    expect(await versions()).toHaveLength(2);
  });
});
