/**
 * Release-warnings panel (Phase 5) — the compliance check shown before the
 * actuals modal when Complete Production is chosen on a BotanIQals cycle.
 * Warnings only, never a hard block (see cycles/page.tsx's
 * beginCompleteProduction). Four checks, each documented at its call site
 * below; reuses the exact same overdue logic as the Logs hub
 * (complianceOverdue.ts) so "overdue" means the same thing everywhere.
 */

import {
  computeCycleWindowCoverage,
  computePerCycleOverdue,
  computeScheduledOverdue,
  type CycleForOverdue,
} from "@/lib/complianceOverdue";
import type { LogEntry, LogType } from "@/lib/complianceLogs";

export type ReleaseWarning = {
  key: string;
  message: string;
};

export type ReleaseCheckCycle = {
  id: string;
  start_date: string | null;
  end_date: string | null;
};

export async function computeReleaseWarnings(supabase: any, cycle: ReleaseCheckCycle): Promise<ReleaseWarning[]> {
  const warnings: ReleaseWarning[] = [];
  const now = new Date();

  const [typesResult, cycleTargetsResult] = await Promise.all([
    supabase
      .from("log_types")
      .select("*")
      .eq("include_in_release_check", true)
      .is("archived_at", null),
    supabase.from("production_targets").select("product").eq("production_cycle", cycle.id),
  ]);
  if (typesResult.error) throw new Error(typesResult.error.message);
  if (cycleTargetsResult.error) throw new Error(cycleTargetsResult.error.message);

  const releaseCheckTypes = (typesResult.data ?? []) as LogType[];
  const productIds = Array.from(
    new Set(((cycleTargetsResult.data ?? []) as any[]).map((t) => t.product).filter(Boolean)),
  ) as string[];

  // Checks 1 & 3 — only meaningful when there's at least one release-check
  // log type configured.
  if (releaseCheckTypes.length > 0) {
    const typeIds = releaseCheckTypes.map((t) => t.id);
    const { data: entryRows, error: entriesError } = await supabase
      .from("log_entries")
      .select("*")
      .in("log_type_id", typeIds);
    if (entriesError) throw new Error(entriesError.message);
    const allEntries = (entryRows ?? []) as LogEntry[];
    const entriesByType = new Map<string, LogEntry[]>();
    for (const entry of allEntries) {
      const list = entriesByType.get(entry.log_type_id) ?? [];
      list.push(entry);
      entriesByType.set(entry.log_type_id, list);
    }

    for (const logType of releaseCheckTypes) {
      const typeEntries = entriesByType.get(logType.id) ?? [];

      if (logType.schedule_type === "per_cycle") {
        // Check 1 (per_cycle): this specific cycle needs a linked entry.
        const cycleForOverdue: CycleForOverdue & { label: string } = {
          id: cycle.id,
          status: "planned",
          completed_at: null,
          start_date: cycle.start_date,
          businessType: "BotanIQals",
          label: "this cycle",
        };
        const result = computePerCycleOverdue([cycleForOverdue], typeEntries);
        if (result.isOverdue) {
          warnings.push({
            key: `per_cycle:${logType.id}`,
            message: `${logType.name}: no entry linked to this cycle.`,
          });
        }
      } else if (logType.schedule_type !== "none") {
        // Check 1 (daily/weekly/monthly): coverage across this cycle's own
        // window, through today.
        const coverage = computeCycleWindowCoverage(logType, typeEntries, cycle.start_date, now);
        if (!coverage.isCovered) {
          const detail =
            coverage.missingDates.length > 0
              ? ` Missing: ${coverage.missingDates.slice(0, 5).join(", ")}${
                  coverage.missingDates.length > 5 ? `, +${coverage.missingDates.length - 5} more` : ""
                }.`
              : "";
          warnings.push({
            key: `window:${logType.id}`,
            message: `${logType.name}: not fully logged for this cycle's period.${detail}`,
          });
        }

        // Check 3: is it overdue right now, independent of this cycle.
        const overdue = computeScheduledOverdue(logType, typeEntries, now);
        if (overdue.isOverdue) {
          warnings.push({
            key: `overdue:${logType.id}`,
            message: `${logType.name} is overdue (${overdue.missedPeriods.length} missed period${
              overdue.missedPeriods.length === 1 ? "" : "s"
            }).`,
          });
        }
      }
    }
  }

  // Check 2 — out-of-spec entries during the cycle's window or linked to
  // it, for awareness (any log type, not just release-check ones).
  // start_date/end_date are already full timestamptz strings (see
  // handleSubmit's cycle insert) — never append a time suffix to them, and
  // only fall back to "now" (as a bare date, which needs one) when a
  // cycle has no end_date yet.
  const dateFrom = cycle.start_date;
  const dateTo = cycle.end_date || `${now.toISOString().slice(0, 10)}T23:59:59`;
  let outOfSpecQuery = supabase.from("log_entries").select("*, log_types(name)").eq("is_out_of_spec", true);
  if (dateFrom) {
    outOfSpecQuery = outOfSpecQuery.or(
      `production_cycle_id.eq.${cycle.id},and(performed_at.gte.${dateFrom},performed_at.lte.${dateTo})`,
    );
  } else {
    outOfSpecQuery = outOfSpecQuery.eq("production_cycle_id", cycle.id);
  }
  const { data: outOfSpecRows, error: outOfSpecError } = await outOfSpecQuery;
  if (outOfSpecError) throw new Error(outOfSpecError.message);
  for (const row of (outOfSpecRows ?? []) as any[]) {
    warnings.push({
      key: `out_of_spec:${row.id}`,
      message: `Out of spec: ${row.log_types?.name ?? "Log"} entry #${row.entry_number} (${row.performed_by_name}).`,
    });
  }

  // Check 4 — every raw material in the cycle's product(s) BOM needs at
  // least one receiving entry with a COA-type file. Two plain queries +a
  // client-side join (not a PostgREST embed) — matches the proven pattern
  // in rawMaterialDeduction.ts, since bom_lines predates this app's
  // migrations and its FK setup isn't something to assume.
  if (productIds.length > 0) {
    const [bomResult, itemsResult] = await Promise.all([
      supabase
        .from("bom_lines")
        .select("inventory_item, product, line_type")
        .in("product", productIds)
        .eq("line_type", "inventory_item"),
      supabase.from("inventory_items").select("id, name"),
    ]);
    if (bomResult.error) throw new Error(bomResult.error.message);
    if (itemsResult.error) throw new Error(itemsResult.error.message);

    const itemNameById = new Map<string, string>(((itemsResult.data ?? []) as any[]).map((it) => [it.id, it.name]));
    const rawMaterials = new Map<string, string>();
    for (const line of (bomResult.data ?? []) as any[]) {
      if (line.inventory_item) rawMaterials.set(line.inventory_item, itemNameById.get(line.inventory_item) ?? "Unknown material");
    }

    if (rawMaterials.size > 0) {
      const rawMaterialIds = Array.from(rawMaterials.keys());
      const { data: receiptRows, error: receiptError } = await supabase
        .from("receiving_details")
        .select("raw_material_id, log_entry_id")
        .in("raw_material_id", rawMaterialIds);
      if (receiptError) throw new Error(receiptError.message);

      const receiptsByMaterial = new Map<string, string[]>();
      for (const r of (receiptRows ?? []) as any[]) {
        const list = receiptsByMaterial.get(r.raw_material_id) ?? [];
        list.push(r.log_entry_id);
        receiptsByMaterial.set(r.raw_material_id, list);
      }

      const allReceivingEntryIds = Array.from(new Set((receiptRows ?? []).map((r: any) => r.log_entry_id)));
      let coaEntryIds = new Set<string>();
      if (allReceivingEntryIds.length > 0) {
        const { data: coaFileRows, error: coaFileError } = await supabase
          .from("log_entry_files")
          .select("log_entry_id")
          .in("log_entry_id", allReceivingEntryIds)
          .eq("document_type", "coa");
        if (coaFileError) throw new Error(coaFileError.message);
        coaEntryIds = new Set((coaFileRows ?? []).map((f: any) => f.log_entry_id));
      }

      for (const [materialId, materialName] of rawMaterials.entries()) {
        const entryIds = receiptsByMaterial.get(materialId) ?? [];
        const hasCoa = entryIds.some((id) => coaEntryIds.has(id));
        if (!hasCoa) {
          warnings.push({
            key: `coa:${materialId}`,
            message: `No COA on file for ${materialName}.`,
          });
        }
      }
    }
  }

  return warnings;
}
