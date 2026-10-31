// Runs the real migration SQL against an in-memory Postgres (PGlite) with
// stub versions of the tables it depends on. Invented data only.
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const sql = (f: string) => readFileSync(path.join(root, "supabase-migrations", f), "utf8");

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
  alter table storage.objects enable row level security;
  create table products (id uuid primary key default gen_random_uuid(), name text not null, is_microgreen boolean default false);
  create table inventory_items (id uuid primary key default gen_random_uuid(), name text not null, unit text);
  create table variant_component_map (id uuid primary key default gen_random_uuid());
`;

let db: PGlite;
const ids = {
  sop: "aaaaaaaa-0000-4000-8000-000000000001",
  sop2: "aaaaaaaa-0000-4000-8000-000000000002",
  product: "bbbbbbbb-0000-4000-8000-000000000001",
  form1: "cccccccc-0000-4000-8000-000000000001",
  form2: "cccccccc-0000-4000-8000-000000000002",
};

async function publish(opts: { sop?: string; trigger?: string | null; source?: string; expectedRevision?: number | null; clearDraft?: boolean } = {}) {
  const r = await db.query<{ id: string | null }>(
    `select sop_publish_version($1, $2::jsonb, $3::jsonb, $4, 'Tester', 'note', '2026-01-01', 'txt', $5, $6::uuid[], $7, $8, null, null, true, null) as id`,
    [
      opts.sop ?? ids.sop,
      JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] }),
      JSON.stringify({ n1: { formulationId: opts.trigger ?? ids.form1 } }),
      opts.source ?? "editor",
      opts.trigger ?? null,
      [ids.product],
      opts.clearDraft ?? true,
      opts.expectedRevision ?? null,
    ],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(sql("formulation.sql"));
  await db.exec(sql("compliance_sops.sql"));
  // Run twice to prove the migration is idempotent.
  await db.exec(sql("sop_editable_documents.sql"));
  await db.exec(sql("sop_editable_documents.sql"));
  await db.exec(`
    insert into products (id, name) values ('${ids.product}', 'Test Product A');
    insert into sops (id, title) values ('${ids.sop}', '[TEST] Doc SOP'), ('${ids.sop2}', 'Real-looking SOP');
    insert into sop_versions (sop_id, version_number, file_path, original_filename, file_size_bytes, is_current)
      values ('${ids.sop2}', 1, 'x/y.pdf', 'y.pdf', 10, true);
  `);
}, 60000);

describe("sop_editable_documents.sql", () => {
  it("keeps existing PDF rows valid with source 'upload' and format 'pdf'", async () => {
    const v = await db.query<{ source: string }>(`select source from sop_versions where sop_id = $1`, [ids.sop2]);
    expect(v.rows[0].source).toBe("upload");
    const s = await db.query<{ format: string }>(`select format from sops where id = $1`, [ids.sop2]);
    expect(s.rows[0].format).toBe("pdf");
  });

  it("publishes version n+1 as current, rewrites refs, clears the draft", async () => {
    await db.query(`update sops set draft_content = '{"type":"doc"}', draft_revision = 4 where id = $1`, [ids.sop]);
    const v1 = await publish({ expectedRevision: 4 });
    const v2 = await publish({ expectedRevision: 5 });
    expect(v1).toBeTruthy();
    const rows = await db.query<{ version_number: number; is_current: boolean }>(
      `select version_number, is_current from sop_versions where sop_id = $1 order by version_number`,
      [ids.sop],
    );
    expect(rows.rows).toEqual([
      { version_number: 1, is_current: false },
      { version_number: 2, is_current: true },
    ]);
    expect(v2).not.toBe(v1);
    const sop = await db.query<{ draft_content: unknown; format: string; draft_revision: number }>(
      `select draft_content, format, draft_revision from sops where id = $1`,
      [ids.sop],
    );
    expect(sop.rows[0]).toEqual({ draft_content: null, format: "document", draft_revision: 6 });
    const refs = await db.query(`select * from sop_formula_refs where sop_id = $1 and active`, [ids.sop]);
    expect(refs.rows).toHaveLength(1);
  });

  it("rejects publishing over a stale draft revision", async () => {
    await expect(publish({ expectedRevision: 1 })).rejects.toThrow(/DRAFT_CONFLICT/);
  });

  it("creates exactly one automatic version per (sop, formulation)", async () => {
    const before = await db.query<{ n: number }>(`select count(*)::int as n from sop_versions where sop_id = $1`, [ids.sop]);
    const a = await publish({ trigger: ids.form2, source: "auto_formula_update", clearDraft: false });
    const b = await publish({ trigger: ids.form2, source: "auto_formula_update", clearDraft: false });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    const after = await db.query<{ n: number }>(`select count(*)::int as n from sop_versions where sop_id = $1`, [ids.sop]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it("does not touch a pending draft on automatic versions", async () => {
    await db.query(`update sops set draft_content = '{"type":"doc","content":[]}' where id = $1`, [ids.sop]);
    await publish({ trigger: "cccccccc-0000-4000-8000-000000000003", source: "auto_formula_update", clearDraft: false });
    const s = await db.query<{ draft_content: unknown }>(`select draft_content from sops where id = $1`, [ids.sop]);
    expect(s.rows[0].draft_content).toEqual({ type: "doc", content: [] });
  });

  it("rejects DELETE on sop_versions", async () => {
    await expect(db.query(`delete from sop_versions where sop_id = $1`, [ids.sop2])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query(`delete from sops where id = $1`, [ids.sop2])).rejects.toThrow(/cannot be deleted/);
  });

  it("rejects any UPDATE other than is_current", async () => {
    for (const set of ["change_note = 'x'", "content = '{}'::jsonb", "formula_snapshot = '{}'::jsonb", "version_number = 99", "effective_date = '2020-01-01'"]) {
      await expect(db.query(`update sop_versions set ${set} where sop_id = $1`, [ids.sop2])).rejects.toThrow(/immutable/);
    }
    await db.query(`update sop_versions set is_current = false where sop_id = $1`, [ids.sop2]);
    await db.query(`update sop_versions set is_current = true where sop_id = $1`, [ids.sop2]);
  });

  it("rolls a migrated SOP back to its PDF version", async () => {
    await publish({ sop: ids.sop2, source: "migration" });
    const pdf = await db.query<{ id: string }>(`select id from sop_versions where sop_id = $1 and file_path is not null`, [ids.sop2]);
    await db.query(`select sop_rollback_to_version($1, $2)`, [ids.sop2, pdf.rows[0].id]);
    const cur = await db.query<{ version_number: number }>(`select version_number from sop_versions where sop_id = $1 and is_current`, [ids.sop2]);
    expect(cur.rows[0].version_number).toBe(1);
    const s = await db.query<{ format: string }>(`select format from sops where id = $1`, [ids.sop2]);
    expect(s.rows[0].format).toBe("pdf");
    const all = await db.query(`select id from sop_versions where sop_id = $1`, [ids.sop2]);
    expect(all.rows).toHaveLength(2); // the migrated version stays as history
  });

  it("test cleanup only removes [TEST] SOPs", async () => {
    const n = await db.query<{ n: number }>(`select sop_test_cleanup($1::uuid[]) as n`, [[ids.sop, ids.sop2]]);
    expect(n.rows[0].n).toBe(1);
    const left = await db.query(`select id from sops`);
    expect(left.rows).toHaveLength(1);
    // outside the cleanup function, deletes are still rejected
    await expect(db.query(`delete from sop_versions`)).rejects.toThrow(/cannot be deleted/);
  });

  it("locks the staging table away from app roles", async () => {
    const r = await db.query<{ rls: boolean }>(`select relrowsecurity as rls from pg_class where relname = 'sop_migration_staging'`);
    expect(r.rows[0].rls).toBe(true);
    const g = await db.query(`select grantee from information_schema.role_table_grants where table_name = 'sop_migration_staging' and grantee in ('anon','authenticated')`);
    expect(g.rows).toHaveLength(0);
  });
});
