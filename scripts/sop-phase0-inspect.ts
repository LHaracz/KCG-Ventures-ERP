/**
 * Phase 0B read-only inspection for the editable-SOP build.
 *
 * Run:  npx tsx --env-file=.env.local scripts/sop-phase0-inspect.ts
 *
 * Reads only. Never writes to the database or storage.
 * Console output: product names, counts and SOP names only.
 * Details (ingredient names, quantities, units, file names) go to
 * .private/report/ which is git-ignored and never deployed.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (use --env-file=.env.local).");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const reportDir = path.join(process.cwd(), ".private", "report");
mkdirSync(reportDir, { recursive: true });

async function all<T>(table: string, select: string, apply?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let q = db.from(table).select(select).range(from, from + pageSize - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

type Product = { id: string; name: string; unit: string | null; is_microgreen: boolean | null; deleted_at: string | null };
type FP = { id: string; name: string; product_id: string | null; status: string; deleted_at: string | null };
type F = { id: string; formulation_product_id: string; version_number: number; status: string; finalized_at: string | null };
type FL = { formulation_id: string; line_type: string; raw_material_id: string; qty_per_unit: string | number; sort_order: number };
type Bom = { id: string; product: string; line_type: string; inventory_item: string | null; qty_per_unit: string | number; unit_label: string | null };
type Item = { id: string; name: string; unit: string | null };
type Sop = { id: string; title: string; sop_number: string | null; archived_at: string | null };
type SopV = { id: string; sop_id: string; version_number: number; original_filename: string | null; is_current: boolean; effective_date: string | null };

function norm(v: string | number): string {
  // Compare numerics as canonical decimal strings, not floats.
  const s = String(v).trim();
  if (!/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return s;
  if (/e/i.test(s)) return String(Number(s));
  let [i, f = ""] = s.split(".");
  i = i.replace(/^(-?)0+(?=\d)/, "$1");
  f = f.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

async function main() {
  const products = (await all<Product>("products", "id, name, unit, is_microgreen, deleted_at")).filter(
    (p) => p.is_microgreen !== true && !p.deleted_at,
  );
  const fps = (await all<FP>("formulation_products", "id, name, product_id, status, deleted_at")).filter((f) => !f.deleted_at);
  const forms = await all<F>("formulations", "id, formulation_product_id, version_number, status, finalized_at");
  const lines = await all<FL>("formulation_lines", "formulation_id, line_type, raw_material_id, qty_per_unit, sort_order");
  const bom = await all<Bom>("bom_lines", "id, product, line_type, inventory_item, qty_per_unit, unit_label");
  const items = await all<Item>("inventory_items", "id, name, unit");
  const itemById = new Map(items.map((i) => [i.id, i]));

  const bomReport: string[] = [];
  const unitReport: string[] = [];
  let missingFinal = 0;
  console.log(`\nActive BotanIQals products: ${products.length}`);
  console.log("product | final formulation | latest final version | BOM differences");
  for (const p of products) {
    const fp = fps.find((f) => f.product_id === p.id);
    const finals = fp
      ? forms.filter((f) => f.formulation_product_id === fp.id && f.status === "final").sort((a, b) => b.version_number - a.version_number)
      : [];
    const latest = finals[0];
    if (!latest) {
      missingFinal++;
      console.log(`${p.name} | NO | - | -`);
      bomReport.push(`## ${p.name}\nNo final formulation.\n`);
      continue;
    }
    const fl = lines.filter((l) => l.formulation_id === latest.id).sort((a, b) => a.sort_order - b.sort_order);
    const pb = bom.filter((b) => b.product === p.id && b.inventory_item);
    const k = (t: string, id: string) => `${t}:${id}`;
    const flMap = new Map(fl.map((l) => [k(l.line_type, l.raw_material_id), l]));
    const bMap = new Map(pb.map((b) => [k(b.line_type, b.inventory_item!), b]));
    const diffs: string[] = [];
    for (const [key, l] of flMap) {
      const b = bMap.get(key);
      const name = itemById.get(l.raw_material_id)?.name ?? l.raw_material_id;
      if (!b) diffs.push(`only in formula: ${name} (${norm(l.qty_per_unit)})`);
      else if (norm(b.qty_per_unit) !== norm(l.qty_per_unit))
        diffs.push(`qty differs: ${name} formula=${norm(l.qty_per_unit)} bom=${norm(b.qty_per_unit)}`);
    }
    for (const [key, b] of bMap) {
      if (!flMap.has(key)) diffs.push(`only in BOM: ${itemById.get(b.inventory_item!)?.name ?? b.inventory_item} (${norm(b.qty_per_unit)})`);
    }
    console.log(`${p.name} | yes | v${latest.version_number} | ${diffs.length}`);
    bomReport.push(`## ${p.name} (formula v${latest.version_number}, product unit: ${p.unit ?? "?"})\n${diffs.length ? diffs.map((d) => `- ${d}`).join("\n") : "No differences."}\n`);
    unitReport.push(`## ${p.name} (product unit: ${p.unit ?? "?"})`);
    for (const l of fl) {
      const it = itemById.get(l.raw_material_id);
      const b = bMap.get(k(l.line_type, l.raw_material_id));
      unitReport.push(`- ${it?.name ?? l.raw_material_id} [${l.line_type}] inventory unit=${it?.unit ?? "?"} bom unit_label=${b?.unit_label ?? "-"} qty_per_unit=${norm(l.qty_per_unit)}`);
    }
    unitReport.push("");
  }
  writeFileSync(path.join(reportDir, "bom-differences.txt"), bomReport.join("\n"));
  writeFileSync(path.join(reportDir, "units.txt"), unitReport.join("\n"));

  const unitCounts = new Map<string, number>();
  for (const it of items) unitCounts.set(String(it.unit ?? "(none)"), (unitCounts.get(String(it.unit ?? "(none)")) ?? 0) + 1);
  console.log(`\nInventory item units in use: ${[...unitCounts].map(([u, n]) => `${u}=${n}`).join(", ")}`);
  console.log(`Products missing a final formulation: ${missingFinal}`);

  const sops = await all<Sop>("sops", "id, title, sop_number, archived_at");
  const versions = await all<SopV>("sop_versions", "id, sop_id, version_number, original_filename, is_current, effective_date");
  const inv: string[] = [];
  console.log(`\nSOPs: ${sops.length} (${sops.filter((s) => s.archived_at).length} archived), versions: ${versions.length}`);
  for (const s of sops) {
    const vs = versions.filter((v) => v.sop_id === s.id).sort((a, b) => a.version_number - b.version_number);
    const match = products.filter((p) => s.title.toLowerCase().includes(p.name.toLowerCase()));
    console.log(`- ${s.sop_number ?? "(no number)"} ${s.title} | ${vs.length} version(s)${s.archived_at ? " | archived" : ""} | product match: ${match.map((m) => m.name).join(", ") || "none"}`);
    inv.push(`## ${s.sop_number ?? "(no number)"} ${s.title}  [id ${s.id}]${s.archived_at ? " ARCHIVED" : ""}`);
    inv.push(`product name match: ${match.map((m) => `${m.name} [${m.id}]`).join(", ") || "none"}`);
    for (const v of vs) inv.push(`- v${v.version_number}${v.is_current ? " (current)" : ""} ${v.original_filename ?? "(no file)"} effective ${v.effective_date ?? "-"}`);
    inv.push("");
  }
  writeFileSync(path.join(reportDir, "sop-inventory.txt"), inv.join("\n"));

  // Is the service role usable for storage?
  const { error: storageError } = await db.storage.from("sops").list("", { limit: 1 });
  console.log(`\nService role can list the "sops" bucket: ${storageError ? `NO (${storageError.message})` : "yes"}`);
  console.log(`\nDetails written to .private/report/ (bom-differences.txt, units.txt, sop-inventory.txt).`);
}

main().catch((e) => {
  console.error(`Inspection failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
