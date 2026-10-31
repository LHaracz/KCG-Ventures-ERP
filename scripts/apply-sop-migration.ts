/**
 * Phase 4, Step C: publish the approved, staged editable bodies as new SOP
 * versions. Reads authored content from sop_migration_staging (never from
 * local files). Contains no SOP text.
 *
 *   npx tsx --env-file=.env.local scripts/apply-sop-migration.ts            # dry run (default)
 *   npx tsx --env-file=.env.local scripts/apply-sop-migration.ts --apply    # publish
 *   ... --sop <slug>                                                         # one SOP only
 *
 * Per SOP, in one database transaction (sop_publish_version): version n+1
 * with the authored content and a snapshot of the current final formula
 * (product SOPs), source 'migration', Published by "System migration",
 * effective today (America/New_York); set current; format 'document';
 * product_id for product SOPs; sop_formula_refs rewritten. The PDF version
 * stays on file as an older version. Idempotent per SOP.
 */
import { adminClient, backupTables, flag, option } from "./lib/sopMigrationShared";
import { extractSearchText, findFormulaTables, validateSopDocument, type DocNode } from "../src/lib/sopDocument";
import { captureFormulaSnapshot, dateInNewYork } from "../src/lib/sopService";

type Staging = {
  id: string;
  sop_id: string;
  slug: string;
  source_version_id: string;
  is_product_sop: boolean;
  product_id: string | null;
  product_ids: string[];
  content: DocNode;
  applied_version_id: string | null;
};

async function main() {
  const apply = flag("apply");
  const only = option("sop");
  const db = adminClient();

  let q = db.from("sop_migration_staging").select("id, sop_id, slug, source_version_id, is_product_sop, product_id, product_ids, content, applied_version_id").order("slug");
  if (only) q = q.eq("slug", only);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Staging[];
  if (!rows.length) {
    console.log("Nothing staged.");
    return;
  }

  console.log(apply ? "APPLY mode: backing up first." : "DRY RUN (no changes). Use --apply to publish.");
  if (apply) {
    const dir = await backupTables(db);
    console.log(`  backup written under .private/backup/${dir.split(/[\\/]/).pop()}`);
  }

  let created = 0;
  let skipped = 0;
  for (const r of rows) {
    const { data: sop } = await db.from("sops").select("id, title, format").eq("id", r.sop_id).maybeSingle();
    if (!sop) {
      console.log(`- ${r.slug}: SOP no longer exists, skipped`);
      skipped++;
      continue;
    }
    const { data: current } = await db
      .from("sop_versions")
      .select("id, version_number, original_filename, source")
      .eq("sop_id", r.sop_id)
      .eq("is_current", true)
      .maybeSingle();

    // Idempotent: already applied and still current, or already a document.
    if (r.applied_version_id && current?.id === r.applied_version_id) {
      console.log(`- ${sop.title}: already converted (v${current.version_number}), skipped`);
      skipped++;
      continue;
    }
    if (sop.format === "document" && current?.source !== "upload") {
      console.log(`- ${sop.title}: already an editable document, skipped`);
      skipped++;
      continue;
    }
    if (!current || current.id !== r.source_version_id) {
      console.log(`- ${sop.title}: its current PDF changed since the dry run; re-run the plan and stage steps. Skipped.`);
      skipped++;
      continue;
    }

    const valid = validateSopDocument(r.content);
    if (!valid.ok) {
      console.log(`- ${sop.title}: content failed validation (${valid.error}). Skipped.`);
      skipped++;
      continue;
    }
    const tables = findFormulaTables(valid.doc);
    const planned = new Set(r.product_ids ?? []);
    if (r.is_product_sop && (tables.length === 0 || tables.some((t) => !t.productId || !planned.has(t.productId)) || [...planned].some((id) => !tables.some((t) => t.productId === id)))) {
      console.log(`- ${sop.title}: formula tables do not match the planned products. Skipped.`);
      skipped++;
      continue;
    }

    const { snapshot, productIds } = await captureFormulaSnapshot(db, valid.doc);
    const notOk = Object.values(snapshot).filter((s) => s.status !== "ok").length;
    const changeNote = `Converted PDF ${current.original_filename ?? "file"} (v${current.version_number}) to an editable document. Body text copied unchanged.`;

    if (!apply) {
      console.log(`- ${sop.title}: would publish v${current.version_number + 1}${r.is_product_sop ? ` with ${tables.length} formula table(s)` : ""}${notOk ? ` (WARNING: ${notOk} empty table(s))` : ""}`);
      continue;
    }

    const { data: versionId, error: rpcError } = await db.rpc("sop_publish_version", {
      p_sop_id: r.sop_id,
      p_content: valid.doc,
      p_formula_snapshot: snapshot,
      p_source: "migration",
      p_published_by_name: "System migration",
      p_change_note: changeNote,
      p_effective_date: dateInNewYork(),
      p_search_text: extractSearchText(valid.doc),
      p_trigger_formulation_id: null,
      p_product_ids: productIds,
      p_clear_draft: false,
      p_expected_draft_revision: null,
      p_expected_current_version_id: r.source_version_id,
      p_user_id: null,
      p_set_format_document: true,
      p_set_product_id: r.is_product_sop ? r.product_id : null,
    });
    if (rpcError) {
      console.log(`- ${sop.title}: FAILED (${rpcError.message})`);
      skipped++;
      continue;
    }
    await db.from("sop_migration_staging").update({ applied_version_id: versionId, approved: true, updated_at: new Date().toISOString() }).eq("id", r.id);
    console.log(`- ${sop.title}: converted (v${current.version_number + 1})`);
    created++;
  }
  console.log(`\n${apply ? "Converted" : "Would convert"}: ${apply ? created : rows.length - skipped}, skipped: ${skipped}.`);
}

main().catch((e) => {
  console.error(`Apply failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
