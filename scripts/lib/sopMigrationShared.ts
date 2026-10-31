/**
 * Shared helpers for the PDF-to-document SOP conversion scripts.
 * Contains no SOP text, ingredient names or formula amounts.
 * All confidential output goes under .private/ (git-ignored, never deployed).
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
if (!existsSync(path.join(ROOT, "package.json")) || !existsSync(path.join(ROOT, "supabase-migrations"))) {
  console.error("Run this from the repository root.");
  process.exit(2);
}

export const PRIVATE = path.join(ROOT, ".private");
export const DIRS = {
  pdfs: path.join(PRIVATE, "work", "pdfs"),
  pages: path.join(PRIVATE, "work", "pages"),
  text: path.join(PRIVATE, "work", "text"),
  migration: path.join(PRIVATE, "migration"),
  authored: path.join(PRIVATE, "migration", "sops"),
  report: path.join(PRIVATE, "report"),
  backup: path.join(PRIVATE, "backup"),
};
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run with --env-file=.env.local).");
    process.exit(2);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export function slugify(sopNumber: string | null, title: string): string {
  const base = `${sopNumber ?? ""} ${title}`.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-");
  return base.replace(/-+/g, "-").slice(0, 80) || "sop";
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
export function option(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

export async function selectAll<T>(db: ReturnType<typeof adminClient>, table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export type PlanEntry = {
  slug: string;
  sopId: string;
  title: string;
  sopNumber: string | null;
  sourceVersionId: string;
  sourceVersionNumber: number;
  sourceFilename: string | null;
  sourcePath: string;
  isProductSop: boolean | null; // null = needs a decision from the user
  /** Primary product (sops.product_id). Null when the SOP covers several products. */
  productId: string | null;
  productName: string | null;
  /** Every product that gets a formula table, in document order. */
  productIds: string[];
  productNames: string[];
  matchNote: string;
};

export const PLAN_JSON = path.join(DIRS.migration, "plan.json");
export const OVERRIDES_JSON = path.join(DIRS.migration, "overrides.json");

/** Sidecar written next to each authored body: what was replaced, kept, and could not be reproduced. */
export type AuthoredMeta = {
  slug: string;
  replacedTables: {
    nodeId: string;
    description: string;
    /** bomName: the BOM line this PDF row corresponds to, when the PDF used a different name. */
    pdfRows: { name: string; pdfPerUnit: string | null; bomName?: string }[];
  }[];
  insertedTable: { nodeId: string; placement: string } | null;
  manualTables: string[];
  notReproduced: string[];
};

/** Backs up the tables this migration reads or could affect. Never prints contents. */
export async function backupTables(db: ReturnType<typeof adminClient>): Promise<string> {
  const { writeFileSync } = await import("node:fs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DIRS.backup, stamp);
  mkdirSync(dir, { recursive: true });
  const tables: [string, string][] = [
    ["sops", "*"],
    ["sop_versions", "*"],
    ["sop_formula_refs", "*"],
    ["formulation_lines", "*"],
    ["bom_lines", "*"],
  ];
  for (const [t, sel] of tables) {
    const rows = await selectAll<Record<string, unknown>>(db, t, sel);
    writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows, null, 2));
    console.log(`  backup: ${t} (${rows.length} rows)`);
  }
  return dir;
}
