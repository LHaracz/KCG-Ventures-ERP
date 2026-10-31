/**
 * Rolls converted SOPs back to their previous PDF version: that PDF version
 * becomes current again and sops.format goes back to 'pdf'. The migrated
 * versions stay as history (nothing is deleted).
 *
 *   npx tsx --env-file=.env.local scripts/rollback-sop-migration.ts             # dry run
 *   npx tsx --env-file=.env.local scripts/rollback-sop-migration.ts --apply     # roll back
 *   ... --sop <slug>
 */
import { adminClient, backupTables, flag, option } from "./lib/sopMigrationShared";

async function main() {
  const apply = flag("apply");
  const only = option("sop");
  const db = adminClient();
  let q = db.from("sop_migration_staging").select("id, sop_id, slug, source_version_id, applied_version_id").not("applied_version_id", "is", null);
  if (only) q = q.eq("slug", only);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; sop_id: string; slug: string; source_version_id: string; applied_version_id: string }[];
  if (!rows.length) {
    console.log("No applied conversions to roll back.");
    return;
  }
  console.log(apply ? "APPLY mode: backing up first." : "DRY RUN (no changes). Use --apply to roll back.");
  if (apply) await backupTables(db);

  for (const r of rows) {
    const { data: sop } = await db.from("sops").select("title").eq("id", r.sop_id).maybeSingle();
    const name = sop?.title ?? r.slug;
    const { data: pdf } = await db
      .from("sop_versions")
      .select("id, version_number")
      .eq("id", r.source_version_id)
      .not("file_path", "is", null)
      .maybeSingle();
    if (!pdf) {
      console.log(`- ${name}: source PDF version not found, skipped`);
      continue;
    }
    if (!apply) {
      console.log(`- ${name}: would make PDF v${pdf.version_number} current again`);
      continue;
    }
    const { error: rpcError } = await db.rpc("sop_rollback_to_version", { p_sop_id: r.sop_id, p_version_id: pdf.id });
    if (rpcError) {
      console.log(`- ${name}: FAILED (${rpcError.message})`);
      continue;
    }
    await db.from("sop_migration_staging").update({ applied_version_id: null, updated_at: new Date().toISOString() }).eq("id", r.id);
    console.log(`- ${name}: PDF v${pdf.version_number} is current again`);
  }
}

main().catch((e) => {
  console.error(`Rollback failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
