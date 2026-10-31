/**
 * Phase 4, Step B (dry run): validate the authored editable bodies, save
 * them to sop_migration_staging, and write one review report per SOP.
 * Does NOT publish anything.
 *
 *   npx tsx --env-file=.env.local scripts/sop-migration-stage.ts [--sop <slug>]
 *
 * Inputs (all under .private/, never committed):
 *   migration/plan.json                 from sop-migration-plan.ts
 *   migration/sops/{slug}.json          authored Tiptap JSON
 *   migration/sops/{slug}.meta.json     replaced/kept tables, placement, notes
 *   work/text/{slug}.txt                pdftotext output of the source PDF
 *   work/pages/{slug}-{n}.png           rendered pages of the source PDF
 *   work/images/{slug}/{file}           images extracted from the PDF ("local:{file}" in the JSON)
 * Outputs:
 *   report/{slug}.html, report/index.html
 *
 * Console output: SOP names and counts only.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { diffWords } from "diff";
import Decimal from "decimal.js";
import { DIRS, PLAN_JSON, adminClient, option, type AuthoredMeta, type PlanEntry } from "./lib/sopMigrationShared";
import { extractSearchText, findFormulaTables, validateSopDocument, type DocNode } from "../src/lib/sopDocument";
import { captureFormulaSnapshot } from "../src/lib/sopService";
import { buildFormulaTable, parseQty, toDisplayUnit } from "../src/lib/formulaTable";
import { SopRenderProvider } from "../src/components/sop/SopRenderContext";
import { SopDocumentRenderer } from "../src/components/sop/SopDocumentRenderer";
import type { FormulaSnapshot } from "../src/lib/sopFormulaData";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** Normalizes text for comparison: list markers, bullets, whitespace, emoji. */
function normalizeText(s: string): string {
  return s
    .replace(/\f/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[•●▪◦○■□➢➤✓✔-]|\d{1,3}[.)]|[a-z][.)])\s+/i, ""))
    .join("\n")
    .replace(EMOJI, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Doc text excluding formula tables (they replace PDF tables). */
function docTextForDiff(doc: DocNode): string {
  const strip = (n: DocNode): DocNode => ({ ...n, content: n.content?.filter((c) => c.type !== "formulaTable").map(strip) });
  return extractSearchText(strip(doc));
}

async function uploadLocalImages(db: ReturnType<typeof adminClient>, slug: string, sopId: string, doc: DocNode): Promise<{ doc: DocNode; uploaded: number; missing: string[] }> {
  let uploaded = 0;
  const missing: string[] = [];
  const walk = async (n: DocNode): Promise<DocNode> => {
    if (n.type === "image" && typeof n.attrs?.path === "string" && n.attrs.path.startsWith("local:")) {
      const file = path.join(DIRS.migration, "..", "work", "images", slug, n.attrs.path.slice(6));
      if (!existsSync(file)) {
        missing.push(n.attrs.path.slice(6));
        return n;
      }
      const ext = path.extname(file).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const bucketPath = `${sopId}/migration-${path.basename(file).replace(/[^\w.-]/g, "_")}`;
      const bytes = readFileSync(file);
      const { error } = await db.storage.from("sop-images").upload(bucketPath, bytes, { contentType: mime, upsert: true });
      if (error) throw new Error(`image upload failed: ${error.message}`);
      await db.from("sop_images").upsert({ sop_id: sopId, path: bucketPath, original_filename: path.basename(file), file_size_bytes: bytes.length }, { onConflict: "path" });
      uploaded++;
      return { ...n, attrs: { ...n.attrs, path: bucketPath } };
    }
    return n.content ? { ...n, content: await Promise.all(n.content.map(walk)) } : n;
  };
  return { doc: await walk(doc), uploaded, missing };
}

function compareReplacedTable(meta: AuthoredMeta["replacedTables"][number], snapshot: FormulaSnapshot): { rows: string[]; mismatches: number } {
  const snap = snapshot[meta.nodeId];
  const formulaRows = snap?.rows ?? [];
  const built = buildFormulaTable(formulaRows);
  const rows: string[] = [];
  let mismatches = 0;
  const used = new Set<number>();
  for (const pr of meta.pdfRows) {
    const target = (pr.bomName ?? pr.name).trim().toLowerCase();
    const idx = formulaRows.findIndex((f, i) => !used.has(i) && f.name.trim().toLowerCase() === target);
    let formulaText = "not in formula";
    let ok = false;
    if (idx >= 0) {
      used.add(idx);
      formulaText = built.rows[idx].cells[0].display + (built.rows[idx].isMass ? " g" : "");
      const fq = parseQty(formulaRows[idx].qtyPerUnit);
      const pq = pr.pdfPerUnit ? parseQty(pr.pdfPerUnit.replace(/[^\d.\-]/g, "")) : null;
      if (fq && pq) {
        const fv = toDisplayUnit(fq, formulaRows[idx].unit).value;
        ok = fv.minus(pq).abs().lte(new Decimal("0.0005"));
      }
    }
    if (!ok) mismatches++;
    rows.push(`<tr class="${ok ? "" : "mismatch"}"><td>${esc(pr.name)}${pr.bomName && pr.bomName !== pr.name ? ` → <strong>${esc(pr.bomName)}</strong> (BOM name)` : ""}</td><td>${esc(pr.pdfPerUnit ?? "—")}</td><td>${esc(formulaText)}</td><td>${ok ? "match" : "MISMATCH"}</td></tr>`);
  }
  formulaRows.forEach((f, i) => {
    if (!used.has(i)) {
      mismatches++;
      rows.push(`<tr class="mismatch"><td>${esc(f.name)}</td><td>not in PDF table</td><td>${esc(built.rows[i].cells[0].display)}</td><td>MISMATCH</td></tr>`);
    }
  });
  return { rows, mismatches };
}

async function main() {
  if (!existsSync(PLAN_JSON)) {
    console.error("Run scripts/sop-migration-plan.ts first.");
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(PLAN_JSON, "utf8")) as { entries: PlanEntry[] };
  const only = option("sop");
  const entries = plan.entries.filter((e) => !only || e.slug === only);
  const undecided = entries.filter((e) => e.isProductSop === null);
  if (undecided.length) {
    console.error(`STOP: ${undecided.length} SOP(s) still need a product decision: ${undecided.map((e) => e.title).join("; ")}`);
    process.exit(1);
  }
  const db = adminClient();
  const css = readFileSync(path.join(process.cwd(), "src", "components", "sop", "sopDocument.css"), "utf8");
  const index: string[] = [];
  let staged = 0;
  let problems = 0;

  for (const e of entries) {
    const jsonPath = path.join(DIRS.authored, `${e.slug}.json`);
    const metaPath = path.join(DIRS.authored, `${e.slug}.meta.json`);
    if (!existsSync(jsonPath) || !existsSync(metaPath)) {
      console.log(`- ${e.title}: not authored yet`);
      problems++;
      continue;
    }
    let doc = JSON.parse(readFileSync(jsonPath, "utf8")) as DocNode;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as AuthoredMeta;

    const tables = findFormulaTables(doc);
    const issues: string[] = [];
    if (e.isProductSop) {
      const planned = new Set(e.productIds);
      const used = new Set(tables.map((t) => t.productId));
      if (tables.length === 0) issues.push("Product SOP has no formula table.");
      if (tables.some((t) => !t.productId || !planned.has(t.productId))) issues.push("A formula table does not point at a planned product.");
      for (const [i, id] of e.productIds.entries()) if (!used.has(id)) issues.push(`No formula table for planned product ${e.productNames[i]}.`);
    } else if (tables.length) issues.push("Non-product SOP must not contain a formula table.");

    const img = await uploadLocalImages(db, e.slug, e.sopId, doc);
    doc = img.doc;
    if (img.missing.length) issues.push(`Missing extracted images: ${img.missing.join(", ")}`);

    const valid = validateSopDocument(doc);
    if (!valid.ok) issues.push(`Schema validation failed: ${valid.error}`);

    const { snapshot } = await captureFormulaSnapshot(db, doc);

    // Text diff (formula tables excluded; replaced PDF tables will show as removed).
    const pdfTextPath = path.join(DIRS.text, `${e.slug}.txt`);
    const pdfText = existsSync(pdfTextPath) ? normalizeText(readFileSync(pdfTextPath, "utf8")) : "";
    const docText = normalizeText(docTextForDiff(doc));
    const parts = diffWords(pdfText, docText);
    const changed = parts.filter((p) => p.added || p.removed);
    const diffHtml = changed.length
      ? parts
          .map((p) => (p.added ? `<ins>${esc(p.value)}</ins>` : p.removed ? `<del>${esc(p.value)}</del>` : p.value.length > 160 ? `<span class="ctx">…${esc(p.value.slice(-80))}</span> ` : esc(p.value)))
          .join("")
      : "<p><strong>No differences.</strong></p>";
    if (!pdfText) issues.push("No extracted PDF text found for the diff.");

    const replaced = meta.replacedTables.map((rt) => ({ rt, ...compareReplacedTable(rt, snapshot) }));

    const pages = existsSync(DIRS.pages)
      ? readdirSync(DIRS.pages)
          .filter((f) => f.startsWith(`${e.slug}-`) && f.endsWith(".png"))
          .sort((a, b) => Number(a.match(/-(\d+)\.png$/)?.[1]) - Number(b.match(/-(\d+)\.png$/)?.[1]))
      : [];

    const rendered = renderToStaticMarkup(
      createElement(SopRenderProvider, {
        mode: "snapshot",
        snapshot,
        products: [],
        supabase: null,
        getToken: async () => "",
        children: createElement(SopDocumentRenderer, { doc }),
      }),
    );

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(e.title)} — conversion review</title>
<style>${css}
body{font-family:Arial,sans-serif;color:#000;margin:16px} h1{font-size:20px} h2{font-size:16px;margin-top:24px;border-bottom:1px solid #000}
.side{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start} .side img{width:100%;border:1px solid #999;margin-bottom:8px}
.rendered{border:1px solid #999;padding:16px;background:#fff}
ins{background:#bbf7d0;text-decoration:none} del{background:#fecaca} .ctx{color:#000;opacity:.6}
table.cmp{border-collapse:collapse} table.cmp td,table.cmp th{border:1px solid #000;padding:2px 6px} tr.mismatch td{background:#fee2e2}
.issue{background:#fef3c7;border:1px solid #f59e0b;padding:6px;margin:4px 0}
</style></head><body>
<h1>${esc(e.sopNumber ? `${e.sopNumber} ` : "")}${esc(e.title)}</h1>
<p>Source: v${e.sourceVersionNumber} ${esc(e.sourceFilename ?? "")} · ${e.isProductSop ? `Product SOP: ${esc(e.productNames.join(", "))}` : "Not a product SOP"}</p>
${issues.map((i) => `<div class="issue">${esc(i)}</div>`).join("")}
<h2>1. Original pages and rendered result</h2>
<div class="side"><div>${pages.map((p) => `<img src="../work/pages/${esc(p)}" alt="page">`).join("") || "<p>No page images found.</p>"}</div>
<div class="rendered">${rendered}</div></div>
<h2>2. Text differences (PDF → document, formula tables excluded)</h2>
<p>Expected: only the replaced ingredient table(s) and emoji. Removed text is red, added text is green.</p>
<div>${diffHtml}</div>
<h2>3. Replaced ingredient table(s): PDF per-unit vs formula 1-unit (information only)</h2>
${
  replaced.length
    ? replaced
        .map(
          (r) =>
            `<p>${esc(r.rt.description)}: ${r.mismatches ? `<strong>${r.mismatches} mismatch(es)</strong>` : "all rows match"}</p><table class="cmp"><tr><th>Ingredient</th><th>PDF per unit</th><th>Formula 1 unit</th><th></th></tr>${r.rows.join("")}</table>`,
        )
        .join("")
    : "<p>None.</p>"
}
${meta.insertedTable ? `<p>Formula table inserted (no ingredient table in the PDF): ${esc(meta.insertedTable.placement)}</p>` : ""}
<p>Static tables kept as manual tables: ${meta.manualTables.length ? meta.manualTables.map(esc).join("; ") : "none"}</p>
<h2>4. Not reproduced exactly</h2>
<ul>${meta.notReproduced.map((n) => `<li>${esc(n)}</li>`).join("") || "<li>Nothing noted.</li>"}</ul>
</body></html>`;
    writeFileSync(path.join(DIRS.report, `${e.slug}.html`), html);

    if (valid.ok && !issues.some((i) => i.startsWith("Schema") || i.includes("formula table"))) {
      const { error } = await db.from("sop_migration_staging").upsert(
        {
          sop_id: e.sopId,
          slug: e.slug,
          source_version_id: e.sourceVersionId,
          is_product_sop: !!e.isProductSop,
          product_id: e.productId,
          product_ids: e.productIds,
          content: valid.doc,
          approved: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sop_id" },
      );
      if (error) throw new Error(`staging upsert failed: ${error.message}`);
      staged++;
    } else problems++;

    const mism = replaced.reduce((s, r) => s + r.mismatches, 0);
    index.push(
      `<tr><td><a href="${esc(e.slug)}.html">${esc(e.title)}</a></td><td>${e.isProductSop ? "product" : "—"}</td><td>${changed.length}</td><td>${mism}</td><td>${issues.length}</td></tr>`,
    );
    console.log(`- ${e.title}: ${changed.length} text change hunk(s), ${replaced.length} replaced table(s), ${mism} amount mismatch(es), ${issues.length} issue(s), ${img.uploaded} image(s)`);
  }

  writeFileSync(
    path.join(DIRS.report, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>SOP conversion dry run</title><style>body{font-family:Arial;color:#000}td,th{border:1px solid #000;padding:3px 8px}table{border-collapse:collapse}</style><h1>SOP conversion dry run</h1><table><tr><th>SOP</th><th>Type</th><th>Text diff hunks</th><th>Amount mismatches</th><th>Issues</th></tr>${index.join("")}</table>`,
  );
  console.log(`\nStaged: ${staged}, not staged: ${problems}. Reports: .private/report/index.html`);
  console.log("Nothing has been published. Review the reports, then approve before running apply-sop-migration.ts --apply.");
}

main().catch((e) => {
  console.error(`Stage failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
