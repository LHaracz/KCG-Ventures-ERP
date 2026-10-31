/**
 * Phase 4, Step A: plan the PDF -> editable document conversion, and
 * download each SOP's current PDF into .private/work/pdfs/.
 *
 *   npx tsx --env-file=.env.local scripts/sop-migration-plan.ts
 *
 * Read-only against the database. Writes:
 *   .private/migration/sop-conversion-plan.md   (human-readable plan)
 *   .private/migration/plan.json               (machine-readable plan)
 *   .private/work/pdfs/{slug}.pdf              (current PDF of each SOP)
 *
 * Product match rule (high confidence only): exactly one active BotanIQals
 * product name appears in the SOP title. Anything else is listed for the
 * user to decide in .private/migration/overrides.json:
 *   { "<slug>": { "products": ["Product name", ...] } }  -> product SOP (one formula table per product)
 *   { "<slug>": { "products": [] } }                     -> not a product SOP
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIRS, OVERRIDES_JSON, PLAN_JSON, adminClient, selectAll, slugify, type PlanEntry } from "./lib/sopMigrationShared";
import { loadLatestFinalFormulations } from "../src/lib/sopFormulaData";

type Sop = { id: string; title: string; sop_number: string | null; archived_at: string | null; format: string | null };
type Version = { id: string; sop_id: string; version_number: number; file_path: string | null; original_filename: string | null; is_current: boolean };
type Product = { id: string; name: string; is_microgreen: boolean | null; deleted_at: string | null };

async function main() {
  const db = adminClient();
  const sops = (await selectAll<Sop>(db, "sops", "id, title, sop_number, archived_at, format")).filter((s) => (s.format ?? "pdf") === "pdf");
  const versions = await selectAll<Version>(db, "sop_versions", "id, sop_id, version_number, file_path, original_filename, is_current");
  const products = (await selectAll<Product>(db, "products", "id, name, is_microgreen, deleted_at")).filter((p) => p.is_microgreen !== true && !p.deleted_at);
  const overrides: Record<string, { products: string[] }> = existsSync(OVERRIDES_JSON) ? JSON.parse(readFileSync(OVERRIDES_JSON, "utf8")) : {};

  const entries: PlanEntry[] = [];
  const usedSlugs = new Set<string>();
  for (const s of sops.sort((a, b) => a.title.localeCompare(b.title))) {
    const current = versions.find((v) => v.sop_id === s.id && v.is_current);
    if (!current?.file_path) {
      console.log(`- SKIP ${s.title}: no current PDF version`);
      continue;
    }
    let slug = slugify(s.sop_number, s.title);
    while (usedSlugs.has(slug)) slug = `${slug}-x`;
    usedSlugs.add(slug);

    const title = s.title.toLowerCase();
    const matches = products.filter((p) => p.name.trim() && title.includes(p.name.trim().toLowerCase()));
    // Prefer the most specific name when one product name contains another (e.g. "X" and "X Mint").
    const specific = matches.filter((m) => !matches.some((o) => o !== m && o.name.toLowerCase().includes(m.name.toLowerCase())));
    let isProductSop: boolean | null = null;
    let chosen: Product[] = [];
    let matchNote: string;
    if (slug in overrides) {
      for (const name of overrides[slug].products ?? []) {
        const found = products.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (!found) {
          console.error(`Override for ${slug} names an unknown or inactive product: ${name}`);
          process.exit(1);
        }
        chosen.push(found);
      }
      isProductSop = chosen.length > 0;
      matchNote = chosen.length ? "set by user (overrides.json)" : "not a product SOP (overrides.json)";
    } else if (specific.length === 1) {
      chosen = [specific[0]];
      isProductSop = true;
      matchNote = "product name appears in the SOP title";
    } else if (specific.length > 1) {
      matchNote = `ambiguous: ${specific.length} product names appear in the title`;
    } else {
      matchNote = "no product name in the title";
    }

    entries.push({
      slug,
      sopId: s.id,
      title: s.title,
      sopNumber: s.sop_number,
      sourceVersionId: current.id,
      sourceVersionNumber: current.version_number,
      sourceFilename: current.original_filename,
      sourcePath: current.file_path,
      isProductSop,
      productId: chosen.length === 1 ? chosen[0].id : null,
      productName: chosen.length === 1 ? chosen[0].name : null,
      productIds: chosen.map((c) => c.id),
      productNames: chosen.map((c) => c.name),
      matchNote,
    });
  }

  // Every matched product must have a final formulation.
  const productIds = Array.from(new Set(entries.flatMap((e) => e.productIds)));
  const finals = await loadLatestFinalFormulations(db, productIds);
  const missing = entries.flatMap((e) => e.productIds.map((id, i) => ({ e, id, name: e.productNames[i] }))).filter((x) => !finals.has(x.id));

  const md: string[] = [
    "# SOP conversion plan",
    "",
    `Generated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} (America/New_York).`,
    "",
    "Every SOP below is converted. Product SOPs get a formula table; the rest keep their body only.",
    "",
    "| SOP | Current PDF | Product SOP? | Product | Match |",
    "| --- | --- | --- | --- | --- |",
    ...entries.map(
      (e) =>
        `| ${e.sopNumber ? `${e.sopNumber} ` : ""}${e.title} (\`${e.slug}\`) | v${e.sourceVersionNumber} ${e.sourceFilename ?? ""} | ${
          e.isProductSop === null ? "**NEEDS DECISION**" : e.isProductSop ? "yes" : "no"
        } | ${e.productIds.map((id, i) => `${e.productNames[i]}${finals.has(id) ? ` (formula v${finals.get(id)!.versionNumber})` : ""}`).join(", ") || "—"} | ${e.matchNote} |`,
    ),
    "",
  ];
  const undecided = entries.filter((e) => e.isProductSop === null);
  if (undecided.length) {
    md.push("## Needs your decision", "", "For each SOP below, say which product it belongs to, or that it is not a product SOP:", "");
    for (const e of undecided) md.push(`- \`${e.slug}\`: ${e.title}`);
    md.push("", "Active BotanIQals products:", "", ...products.map((p) => `- ${p.name} (\`${p.id}\`)`), "");
  }
  if (missing.length) {
    md.push("## BLOCKED: matched products without a final formulation", "", ...missing.map((m) => `- ${m.name} (SOP \`${m.e.slug}\`)`), "");
  }
  writeFileSync(path.join(DIRS.migration, "sop-conversion-plan.md"), md.join("\n"));
  writeFileSync(PLAN_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2));

  // Download current PDFs (service role) into .private/work/pdfs/.
  let downloaded = 0;
  for (const e of entries) {
    const { data, error } = await db.storage.from("sops").download(e.sourcePath);
    if (error || !data) {
      console.log(`- could not download PDF for ${e.title}: ${error?.message ?? "unknown error"}`);
      continue;
    }
    writeFileSync(path.join(DIRS.pdfs, `${e.slug}.pdf`), Buffer.from(await data.arrayBuffer()));
    downloaded++;
  }

  console.log(`\nSOPs to convert: ${entries.length}`);
  console.log(`  product SOPs: ${entries.filter((e) => e.isProductSop).length}`);
  console.log(`  non-product SOPs: ${entries.filter((e) => e.isProductSop === false).length}`);
  console.log(`  needing your decision: ${undecided.length}${undecided.length ? ` (${undecided.map((e) => e.title).join("; ")})` : ""}`);
  console.log(`PDFs downloaded to .private/work/pdfs/: ${downloaded}`);
  console.log(`Plan: .private/migration/sop-conversion-plan.md`);
  if (missing.length) {
    console.error(`\nSTOP: ${missing.length} matched product(s) have no final formulation: ${missing.map((m) => m.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Plan failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
