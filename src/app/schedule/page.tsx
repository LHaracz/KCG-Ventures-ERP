"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { addDays, formatDate, toMidnight } from "@/lib/date";
import { toGrams } from "@/lib/units";
import {
  AggregatedIngredientRequirement,
  BomLineForScaling,
  CycleIngredientRequirement,
  aggregateCycleRequirements,
  scaleBomLines,
  splitIntoCycles,
} from "@/lib/manufacturing";
import {
  BomLineRow,
  FreezeDryerMachineSettingsRow,
  FreezeDryerProfileRow,
  MicrogreenRow,
  ProductionCycleRow,
  ProductionTargetRow,
  ProductRow,
  YieldEntryRow,
  buildRunsForMicrogreen,
  computeDriedMicrogreenDemand,
  deriveGrowTasksFromRuns,
  estimateTraysNeededForDriedDemand,
  getProfileForMicrogreen,
  hasAnyDriedMicrogreenLines,
  isBotanIQalsCycle,
  scheduleRunsWithTwoDayBuffer,
} from "@/lib/botaniqalsScheduling";
import { normalizeBusinessType } from "@/lib/businessType";

type InventoryItemRow = {
  id: string;
  name: string;
  unit: string;
};

type ScheduleEventRow = {
  id: string;
  production_cycle_id: string;
  business_type?: string | null;
  microgreen_id?: string | null;
  event_type: string;
  title: string;
  start_at: string;
  trays?: number | null;
  run_number?: number | null;
};

function filterScopedRows<T extends { user_id?: string | null }>(
  rows: T[],
  userId: string,
): T[] {
  return rows.filter((row) => row.user_id == null || row.user_id === userId);
}

export default function SchedulePage() {
  const { user, supabase } = useSupabase();

  const [activeTab, setActiveTab] = useState<
    "microgreen_grow" | "freeze_dryer" | "manufacturing"
  >("microgreen_grow");

  const [cycles, setCycles] = useState<ProductionCycleRow[]>([]);
  const [targets, setTargets] = useState<ProductionTargetRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [bomLines, setBomLines] = useState<BomLineRow[]>([]);
  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [microgreens, setMicrogreens] = useState<MicrogreenRow[]>([]);
  const [yieldEntries, setYieldEntries] = useState<YieldEntryRow[]>([]);
  const [profiles, setProfiles] = useState<FreezeDryerProfileRow[]>([]);
  const [scheduleEvents, setScheduleEvents] = useState<ScheduleEventRow[]>([]);
  const [machine, setMachine] = useState<FreezeDryerMachineSettingsRow | null>(
    null,
  );

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      const [
        cyclesRes,
        targetsRes,
        productsRes,
        bomRes,
        itemsRes,
        mgRes,
        yieldRes,
        profilesRes,
        scheduleEventsRes,
        machineRes,
      ] = await Promise.all([
        supabase
          .from("production_cycles")
          .select("*")
          .eq("user_id", user.id)
          .order("start_date", { ascending: true }),
        supabase
          .from("production_targets")
          .select("*")
          .eq("user_id", user.id),
        supabase.from("products").select("*").order("name", { ascending: true }),
        supabase.from("bom_lines").select("*"),
        supabase
          .from("inventory_items")
          .select("*")
          .order("name", { ascending: true }),
        supabase
          .from("microgreens")
          .select("*")
          .order("name", { ascending: true }),
        supabase.from("yield_entries").select("*"),
        supabase
          .from("freeze_dryer_profiles")
          .select("*")
          ,
        supabase.from("schedule_events").select("*").eq("user_id", user.id),
        supabase
          .from("freeze_dryer_machine_settings")
          .select("*")
          .maybeSingle(),
      ]);

      const anyError =
        cyclesRes.error ||
        targetsRes.error ||
        productsRes.error ||
        bomRes.error ||
        itemsRes.error ||
        mgRes.error ||
        yieldRes.error ||
        profilesRes.error ||
        scheduleEventsRes.error ||
        machineRes.error;
      if (anyError) {
        setError(
          anyError.message ||
            "Failed to load production planning data for schedule.",
        );
        setIsLoading(false);
        return;
      }

      setCycles((cyclesRes.data || []) as ProductionCycleRow[]);
      setTargets((targetsRes.data || []) as ProductionTargetRow[]);
      setProducts(
        filterScopedRows(
          ((productsRes.data || []) as (ProductRow & { user_id?: string | null })[]),
          user.id,
        ),
      );
      setBomLines(
        filterScopedRows(
          ((bomRes.data || []) as (BomLineRow & { user_id?: string | null })[]),
          user.id,
        ),
      );
      setItems(
        filterScopedRows(
          ((itemsRes.data || []) as (InventoryItemRow & {
            user_id?: string | null;
          })[]),
          user.id,
        ),
      );
      setMicrogreens(
        filterScopedRows(
          ((mgRes.data || []) as (MicrogreenRow & { user_id?: string | null })[]),
          user.id,
        ),
      );
      setYieldEntries(
        filterScopedRows(
          ((yieldRes.data || []) as (YieldEntryRow & {
            user_id?: string | null;
          })[]),
          user.id,
        ),
      );
      setProfiles(
        filterScopedRows(
          ((profilesRes.data || []) as (FreezeDryerProfileRow & {
            user_id?: string | null;
          })[]),
          user.id,
        ),
      );
      setScheduleEvents((scheduleEventsRes.data || []) as ScheduleEventRow[]);
      const machineData = (machineRes.data || null) as
        | (FreezeDryerMachineSettingsRow & { user_id?: string | null })
        | null;
      setMachine(
        machineData && machineData.user_id && machineData.user_id !== user.id
          ? null
          : machineData,
      );
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const botaniqalsCycles = useMemo(
    () => cycles.filter(isBotanIQalsCycle),
    [cycles],
  );

  const minileafCycles = useMemo(
    () => cycles.filter((c) => normalizeBusinessType(c) === "MiniLeaf"),
    [cycles],
  );

  const targetsByCycleId = useMemo(() => {
    const map: Record<string, ProductionTargetRow[]> = {};
    for (const t of targets) {
      if (!map[t.production_cycle]) map[t.production_cycle] = [];
      map[t.production_cycle].push(t);
    }
    return map;
  }, [targets]);

  const dryFractionByMicrogreen = useMemo(() => {
    const map: Record<string, number | null> = {};
    for (const mg of microgreens) {
      const profile =
        profiles.find((p) => p.linked_microgreen_id === mg.id) || null;
      map[mg.id] = profile?.dry_matter_fraction ?? null;
    }
    return map;
  }, [microgreens, profiles]);

  const growSchedule = useMemo(() => {
    const entries: {
      cycleId: string;
      dateKey: string;
      microgreenId: string;
      microgreenName: string;
      trays: number;
      runNumber: number;
      taskType: string;
    }[] = [];

    const warnings: string[] = [];

    for (const cycle of botaniqalsCycles) {
      const cycleTargets = targetsByCycleId[cycle.id] || [];
      const demand = computeDriedMicrogreenDemand(cycleTargets, products, bomLines);
      const trayEst = estimateTraysNeededForDriedDemand(
        demand,
        yieldEntries,
        dryFractionByMicrogreen,
      );

      const numMachines = Number(machine?.number_of_freeze_dryers ?? 1);
      const defaultProfileFreshCapacityG = Number(
        machine?.default_fresh_load_per_tray_g ?? 0,
      );
      if (!machine) {
        warnings.push(
          `${cycle.id}: Freeze-dryer machine settings not found; assuming ${numMachines} freeze-dryer machine(s).`,
        );
      }

      // Build and schedule runs per microgreen, sequentially per cycle.
      const allRuns = trayEst.flatMap((t) => {
        const prof = getProfileForMicrogreen(
          t.microgreenId,
          demand[t.microgreenId]?.explicitProfileId ?? null,
          profiles,
        );
        const profileFreshCapacityG = Number(
          prof?.fresh_load_per_tray_g_override ?? defaultProfileFreshCapacityG,
        );
        const avgFreshGPerTray = Number(t.avgFreshGPerTray ?? 0);
        const traysPerMachineThisProfile =
          profileFreshCapacityG > 0 && avgFreshGPerTray > 0
            ? Math.max(1, Math.floor(profileFreshCapacityG / avgFreshGPerTray))
            : 1;
        const capacityTraysPerRun = traysPerMachineThisProfile * numMachines;

        if (!(profileFreshCapacityG > 0)) {
          warnings.push(
            `${cycle.id}: ${prof?.name ?? "Freeze-dryer profile"} has no fresh-capacity (g) set; defaulting to 1 tray per machine per run.`,
          );
        } else if (!(avgFreshGPerTray > 0)) {
          warnings.push(
            `${cycle.id}: Missing avg fresh yield for ${t.microgreenId}; defaulting to 1 tray per machine per run for ${prof?.name ?? "freeze-dryer profile"}.`,
          );
        }

        return buildRunsForMicrogreen(
          t.microgreenId,
          t.traysNeeded,
          capacityTraysPerRun,
          prof?.id ?? null,
        );
      });

      const { scheduled, warning } = scheduleRunsWithTwoDayBuffer(
        cycle,
        allRuns,
        profiles,
        machine,
        2,
      );
      if (warning) warnings.push(`${cycle.id}: ${warning}`);

      const tasks = deriveGrowTasksFromRuns(scheduled, microgreens);
      for (const task of tasks) {
        const mg = microgreens.find((m) => m.id === task.microgreenId);
        const dateKey = task.date.toISOString().slice(0, 10);
        entries.push({
          cycleId: task.cycleId,
          dateKey,
          microgreenId: task.microgreenId,
          microgreenName: mg?.name ?? "?",
          trays: task.trays,
          runNumber: task.runNumber,
          taskType: task.taskType,
        });
      }

      for (const t of trayEst) {
        if (t.warning) warnings.push(`${cycle.id}: ${t.warning}`);
      }
    }

    entries.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    return { entries, warnings };
  }, [
    botaniqalsCycles,
    targetsByCycleId,
    products,
    bomLines,
    yieldEntries,
    dryFractionByMicrogreen,
    profiles,
    machine,
    microgreens,
  ]);

  const minileafGrowEntries = useMemo(() => {
    const allowedTypes = new Set([
      "soak",
      "drain",
      "sow",
      "move_to_light",
      "harvest",
    ]);

    return scheduleEvents
      .filter((e) => normalizeBusinessType(e) === "MiniLeaf")
      .filter((e) => allowedTypes.has(e.event_type))
      .map((e) => {
        const mg = microgreens.find((m) => m.id === e.microgreen_id);
        return {
          cycleId: e.production_cycle_id,
          dateKey: toMidnight(e.start_at).toISOString().slice(0, 10),
          microgreenId: e.microgreen_id || "",
          microgreenName:
            mg?.name ??
            e.title.replace(/^(Soak|Drain|Sow|Move to light|Harvest)\s+/i, ""),
          trays: Number(e.trays ?? 0),
          runNumber: Number(e.run_number ?? 1),
          taskType: e.event_type,
        };
      });
  }, [scheduleEvents, microgreens]);

  const allGrowEntries = useMemo(
    () =>
      [...growSchedule.entries, ...minileafGrowEntries].sort((a, b) =>
        a.dateKey.localeCompare(b.dateKey),
      ),
    [growSchedule.entries, minileafGrowEntries],
  );

  const freezeDryerSchedule = useMemo(() => {
    const rows: {
      cycleId: string;
      microgreenId: string;
      microgreenName: string;
      trays: number;
      runNumber: number;
      startKey: string;
      endKey: string;
      profileName: string;
    }[] = [];

    const warnings: string[] = [];

    for (const cycle of botaniqalsCycles) {
      const cycleTargets = targetsByCycleId[cycle.id] || [];
      const demand = computeDriedMicrogreenDemand(cycleTargets, products, bomLines);
      const trayEst = estimateTraysNeededForDriedDemand(
        demand,
        yieldEntries,
        dryFractionByMicrogreen,
      );

      const numMachines = Number(machine?.number_of_freeze_dryers ?? 1);
      const defaultProfileFreshCapacityG = Number(
        machine?.default_fresh_load_per_tray_g ?? 0,
      );
      if (!machine) {
        warnings.push(
          `${cycle.id}: Freeze-dryer machine settings not found; assuming ${numMachines} freeze-dryer machine(s).`,
        );
      }

      const allRuns = trayEst.flatMap((t) => {
        const prof = getProfileForMicrogreen(
          t.microgreenId,
          demand[t.microgreenId]?.explicitProfileId ?? null,
          profiles,
        );
        const profileFreshCapacityG = Number(
          prof?.fresh_load_per_tray_g_override ?? defaultProfileFreshCapacityG,
        );
        const avgFreshGPerTray = Number(t.avgFreshGPerTray ?? 0);
        const traysPerMachineThisProfile =
          profileFreshCapacityG > 0 && avgFreshGPerTray > 0
            ? Math.max(1, Math.floor(profileFreshCapacityG / avgFreshGPerTray))
            : 1;
        const capacityTraysPerRun = traysPerMachineThisProfile * numMachines;

        if (!(profileFreshCapacityG > 0)) {
          warnings.push(
            `${cycle.id}: ${prof?.name ?? "Freeze-dryer profile"} has no fresh-capacity (g) set; defaulting to 1 tray per machine per run.`,
          );
        } else if (!(avgFreshGPerTray > 0)) {
          warnings.push(
            `${cycle.id}: Missing avg fresh yield for ${t.microgreenId}; defaulting to 1 tray per machine per run for ${prof?.name ?? "freeze-dryer profile"}.`,
          );
        }

        return buildRunsForMicrogreen(
          t.microgreenId,
          t.traysNeeded,
          capacityTraysPerRun,
          prof?.id ?? null,
        );
      });

      const { scheduled, warning } = scheduleRunsWithTwoDayBuffer(
        cycle,
        allRuns,
        profiles,
        machine,
        2,
      );
      if (warning) warnings.push(`${cycle.id}: ${warning}`);

      for (const run of scheduled) {
        const mg = microgreens.find((m) => m.id === run.microgreenId);
        const profile = getProfileForMicrogreen(
          run.microgreenId,
          run.profileId,
          profiles,
        );
        rows.push({
          cycleId: run.cycleId,
          microgreenId: run.microgreenId,
          microgreenName: mg?.name ?? "?",
          trays: run.trays,
          runNumber: run.runIndex,
          startKey: run.runStart.toISOString().slice(0, 10),
          endKey: run.runEnd.toISOString().slice(0, 10),
          profileName: profile?.name ?? "Default",
        });
      }

      for (const t of trayEst) {
        if (t.warning) warnings.push(`${cycle.id}: ${t.warning}`);
      }
    }

    rows.sort((a, b) => a.startKey.localeCompare(b.startKey));
    return { rows, warnings };
  }, [
    botaniqalsCycles,
    targetsByCycleId,
    products,
    bomLines,
    yieldEntries,
    dryFractionByMicrogreen,
    profiles,
    machine,
    microgreens,
  ]);

  const manufacturingSchedule = useMemo(() => {
    const sections: {
      cycleId: string;
      cycleLabel: string;
      productId: string;
      productName: string;
      plannedQty: number;
      targetBatchSize: number | null;
      cycles: { index: number; quantity: number }[];
      perCycle: CycleIngredientRequirement[][];
      totals: AggregatedIngredientRequirement[];
      warnings: string[];
    }[] = [];

    for (const cycle of botaniqalsCycles) {
      const cycleTargets = targetsByCycleId[cycle.id] || [];
      const cycleLabel = `${formatDate(cycle.start_date)} – ${formatDate(
        cycle.end_date,
      )}`;

      for (const t of cycleTargets) {
        const product = products.find((p) => p.id === t.product);
        if (!product) continue;

        // Only include products that do NOT require dried microgreens.
        if (hasAnyDriedMicrogreenLines(product.id, bomLines)) continue;

        const plannedQty = Number(t.quantity_to_produce ?? t.target_units ?? 0);
        if (!plannedQty || plannedQty <= 0) continue;

        const targetBatchSize =
          product.target_batch_size != null ? Number(product.target_batch_size) : null;

        const batchCycles =
          targetBatchSize && targetBatchSize > 0
            ? splitIntoCycles(plannedQty, targetBatchSize)
            : [{ index: 1, quantity: plannedQty }];

        const warnings: string[] = [];
        if (!targetBatchSize || targetBatchSize <= 0) {
          warnings.push("Target batch size not set; showing a single cycle.");
        }

        const bomLinesForScaling: BomLineForScaling[] = bomLines
          .filter((b) => b.product === product.id)
          .filter((b) => b.line_type !== "dried_microgreen")
          .map((b) => {
            const item = b.inventory_item
              ? items.find((i) => i.id === b.inventory_item)
              : null;
            const mg = (b as any).microgreen_id
              ? microgreens.find((m) => m.id === (b as any).microgreen_id)
              : null;
            let materialName = (b as any).material_name_snapshot as string | null;
            if (!materialName) {
              if (item) materialName = item.name;
              else if (mg) materialName = mg.name;
            }
            return {
              bomLineId: b.id,
              productId: product.id,
              ingredientId: b.inventory_item || b.id,
              ingredientName: materialName || "Unknown",
              qtyPerUnit: Number(b.qty_per_unit || 0),
              unitLabel: b.unit_label || item?.unit || product.unit || "",
            };
          })
          .filter((l) => l.qtyPerUnit > 0);

        if (!bomLinesForScaling.length) {
          warnings.push("No BOM lines found for scaling.");
        }

        const perCycle = batchCycles.map((c) =>
          scaleBomLines(bomLinesForScaling, c.quantity).map((r) => ({
            ...r,
            cycleIndex: c.index,
          })),
        );

        const totals = aggregateCycleRequirements(perCycle);

        sections.push({
          cycleId: cycle.id,
          cycleLabel,
          productId: product.id,
          productName: product.name,
          plannedQty,
          targetBatchSize,
          cycles: batchCycles,
          perCycle,
          totals,
          warnings,
        });
      }
    }

    return sections;
  }, [botaniqalsCycles, targetsByCycleId, products, bomLines, items]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Production Schedule
          </h1>
          <p className="text-sm text-zinc-600">
            View MiniLeaf and BotanIQals grow tasks, plus BotanIQals freeze-dryer
            runs and manufacturing batches.
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            Active cycles: {minileafCycles.length} MiniLeaf,{" "}
            {botaniqalsCycles.length} BotanIQals
          </p>
        </header>

        <div className="flex gap-2 border-b border-zinc-200 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab("microgreen_grow")}
            className={`border-b-2 px-3 py-1.5 ${
              activeTab === "microgreen_grow"
                ? "border-emerald-600 text-emerald-700"
                : "border-transparent text-zinc-600 hover:text-zinc-900"
            }`}
          >
            Microgreen grow
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("freeze_dryer")}
            className={`border-b-2 px-3 py-1.5 ${
              activeTab === "freeze_dryer"
                ? "border-emerald-600 text-emerald-700"
                : "border-transparent text-zinc-600 hover:text-zinc-900"
            }`}
          >
            Freeze dryer
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("manufacturing")}
            className={`border-b-2 px-3 py-1.5 ${
              activeTab === "manufacturing"
                ? "border-emerald-600 text-emerald-700"
                : "border-transparent text-zinc-600 hover:text-zinc-900"
            }`}
          >
            Manufacturing
          </button>
        </div>

        {isLoading ? (
          <p className="text-sm text-black">Loading schedules…</p>
        ) : error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : activeTab === "microgreen_grow" ? (
          <MicrogreenGrowTab
            cycles={cycles}
            entries={allGrowEntries}
            warnings={growSchedule.warnings}
          />
        ) : activeTab === "freeze_dryer" ? (
          <FreezeDryerTab
            cycles={botaniqalsCycles}
            rows={freezeDryerSchedule.rows}
            warnings={freezeDryerSchedule.warnings}
          />
        ) : (
          <ManufacturingTab sections={manufacturingSchedule} />
        )}
      </div>
    </AuthGuard>
  );
}

function MicrogreenGrowTab({
  cycles,
  entries,
  warnings,
}: {
  cycles: ProductionCycleRow[];
  entries: {
    cycleId: string;
    dateKey: string;
    microgreenId: string;
    microgreenName: string;
    trays: number;
    runNumber: number;
    taskType: string;
  }[];
  warnings: string[];
}) {
  const byDate = useMemo(() => {
    const map: Record<string, typeof entries> = {};
    for (const e of entries) {
      if (!map[e.dateKey]) map[e.dateKey] = [];
      map[e.dateKey].push(e);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  return (
    <section className="space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs">
      <h2 className="text-sm font-semibold text-zinc-900">
        Microgreen grow schedule (MiniLeaf + BotanIQals)
      </h2>
      {warnings.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
          <div className="font-semibold">Warnings</div>
          <ul className="mt-1 list-disc pl-4">
            {warnings.slice(0, 6).map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="text-xs text-black">
          No grow tasks found. Generate a cycle plan for MiniLeaf or BotanIQals
          to populate this schedule.
        </p>
      ) : (
        <div className="max-h-[36rem] space-y-4 overflow-y-auto">
          {byDate.map(([dateKey, day]) => (
            <div key={dateKey}>
              <div className="mb-1.5 text-[11px] font-semibold text-zinc-700">
                {formatDate(dateKey)}
              </div>
              <div className="space-y-2">
                {day.map((e, idx) => (
                  <div
                    key={`${e.cycleId}-${e.microgreenId}-${e.taskType}-${idx}`}
                    className="rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                  >
                    <div className="text-[11px] font-semibold text-zinc-900">
                      {e.taskType} · {e.microgreenName}
                    </div>
                    <div className="text-[11px] text-zinc-600">
                      Trays: {e.trays} · Run #{e.runNumber}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Cycle: {cycles.find((c) => c.id === e.cycleId)?.start_date}–{cycles.find((c) => c.id === e.cycleId)?.end_date}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FreezeDryerTab({
  cycles,
  rows,
  warnings,
}: {
  cycles: ProductionCycleRow[];
  rows: {
    cycleId: string;
    microgreenId: string;
    microgreenName: string;
    trays: number;
    runNumber: number;
    startKey: string;
    endKey: string;
    profileName: string;
  }[];
  warnings: string[];
}) {
  const byDate = useMemo(() => {
    const map: Record<string, typeof rows> = {};
    for (const r of rows) {
      if (!map[r.startKey]) map[r.startKey] = [];
      map[r.startKey].push(r);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  return (
    <section className="space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs">
      <h2 className="text-sm font-semibold text-zinc-900">
        Freeze dryer schedule (2-day buffer between runs)
      </h2>
      {warnings.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
          <div className="font-semibold">Warnings</div>
          <ul className="mt-1 list-disc pl-4">
            {warnings.slice(0, 6).map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-black">
          No freeze-dryer runs found. Add BotanIQals cycle targets with dried
          microgreen BOM lines and yield data to generate runs.
        </p>
      ) : (
        <div className="max-h-[36rem] space-y-4 overflow-y-auto">
          {byDate.map(([dateKey, day]) => (
            <div key={dateKey}>
              <div className="mb-1.5 text-[11px] font-semibold text-zinc-700">
                {formatDate(dateKey)}
              </div>
              <div className="space-y-2">
                {day.map((r, idx) => (
                  <div
                    key={`${r.cycleId}-${r.microgreenId}-${r.runNumber}-${idx}`}
                    className="rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                  >
                    <div className="text-[11px] font-semibold text-zinc-900">
                      Run #{r.runNumber} · {r.microgreenName}
                    </div>
                    <div className="text-[11px] text-zinc-600">
                      Trays: {r.trays} · Profile: {r.profileName}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Start: {formatDate(r.startKey)} · End: {formatDate(r.endKey)}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Cycle: {cycles.find((c) => c.id === r.cycleId)?.start_date}–{cycles.find((c) => c.id === r.cycleId)?.end_date}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ManufacturingTab({
  sections,
}: {
  sections: {
    cycleId: string;
    cycleLabel: string;
    productId: string;
    productName: string;
    plannedQty: number;
    targetBatchSize: number | null;
    cycles: { index: number; quantity: number }[];
    perCycle: CycleIngredientRequirement[][];
    totals: AggregatedIngredientRequirement[];
    warnings: string[];
  }[];
}) {
  const byCycle = useMemo(() => {
    const map: Record<string, typeof sections> = {};
    for (const s of sections) {
      if (!map[s.cycleId]) map[s.cycleId] = [];
      map[s.cycleId].push(s);
    }
    return Object.entries(map);
  }, [sections]);

  return (
    <section className="space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs">
      <h2 className="text-sm font-semibold text-zinc-900">
        Manufacturing schedule (products without dried microgreens)
      </h2>
      {sections.length === 0 ? (
        <p className="text-xs text-black">
          No manufacturing batches found for the current BotanIQals cycle targets.
        </p>
      ) : (
        <div className="space-y-4">
          {byCycle.map(([cycleId, list]) => (
            <div key={cycleId} className="rounded border border-zinc-200 bg-zinc-50 p-3">
              <div className="mb-2 text-[11px] font-semibold text-zinc-900">
                Cycle {cycleId}
              </div>
              {list.map((s) => (
                <div key={s.productId} className="mb-3 rounded border border-zinc-200 bg-white p-3">
                  <div className="text-[11px] font-semibold text-zinc-900">
                    {s.productName} · Planned: {s.plannedQty}
                  </div>
                  <div className="text-[11px] text-zinc-600">
                    Target batch size: {s.targetBatchSize ?? "—"} · Cycles: {s.cycles.map((c) => c.quantity).join(" + ")}
                  </div>
                  {s.warnings.length > 0 && (
                    <div className="mt-2 text-[11px] text-amber-700">
                      {s.warnings.join(" ")}
                    </div>
                  )}
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-zinc-900">
                        Ingredients per cycle
                      </div>
                      {s.perCycle.map((cycleReqs, idx) => (
                        <div key={idx} className="mb-2">
                          <div className="text-[11px] font-medium text-zinc-800">
                            Cycle {idx + 1}: {s.cycles[idx]?.quantity}
                          </div>
                          <ul className="text-[11px] text-black">
                            {cycleReqs.map((r) => (
                              <li key={r.bomLineId}>
                                {r.ingredientName}: {r.quantity.toFixed(4)} {r.unitLabel}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-zinc-900">
                        Totals
                      </div>
                      <ul className="text-[11px] text-black">
                        {s.totals.map((r) => (
                          <li key={r.ingredientId}>
                            {r.ingredientName}: {r.totalQuantity.toFixed(4)} {r.unitLabel}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

