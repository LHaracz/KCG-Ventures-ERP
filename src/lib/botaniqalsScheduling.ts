import { addDays, toMidnight } from "@/lib/date";
import { toGrams } from "@/lib/units";

export type ProductionCycleRow = {
  id: string;
  start_date: string;
  end_date: string;
  business_type?: string | null;
  brand?: string | null;
};

export type ProductionTargetRow = {
  id: string;
  production_cycle: string;
  product: string;
  target_units?: number | null;
  quantity_to_produce?: number | null;
};

export type ProductRow = {
  id: string;
  name: string;
  unit: string;
  is_microgreen?: boolean | null;
  target_batch_size?: number | null;
};

export type BomLineRow = {
  id: string;
  product: string;
  line_type?: string | null;
  inventory_item?: string | null;
  microgreen_id?: string | null;
  freeze_dryer_profile_id?: string | null;
  qty_per_unit?: number | null;
  unit_label?: string | null;
};

export type MicrogreenRow = {
  id: string;
  name: string;
  soaking_required: boolean;
  germination_days: number;
  days_to_harvest: number;
  light_offset_days?: number | null;
  harvest_offset_days?: number | null;
};

export type YieldEntryRow = {
  id: string;
  microgreen: string;
  harvest_date: string;
  fresh_yield_g: number;
  dried_yield_g?: number | null;
};

export type FreezeDryerProfileRow = {
  id: string;
  name: string;
  linked_microgreen_id: string | null;
  cycle_time_hours: number;
  defrost_cleaning_hours_override: number | null;
  dry_matter_fraction: number | null;
  fresh_load_per_tray_g_override: number | null;
};

export type FreezeDryerMachineSettingsRow = {
  number_of_freeze_dryers: number;
  trays_per_machine_per_cycle: number;
  default_defrost_cleaning_hours: number;
  default_fresh_load_per_tray_g: number;
};

export type DriedDemandByMicrogreen = Record<
  string,
  {
    microgreenId: string;
    driedRequiredG: number;
    explicitProfileId: string | null;
  }
>;

export function isBotanIQalsCycle(cycle: ProductionCycleRow): boolean {
  const bt = (cycle.business_type || "").toLowerCase();
  const brand = (cycle.brand || "").toLowerCase();
  if (bt === "minileaf" || brand === "minileaf") return false;
  return true;
}

export function getTargetPlannedQty(target: ProductionTargetRow): number {
  return Number(target.quantity_to_produce ?? target.target_units ?? 0) || 0;
}

export function computeDriedMicrogreenDemand(
  targets: ProductionTargetRow[],
  products: ProductRow[],
  bomLines: BomLineRow[],
): DriedDemandByMicrogreen {
  const demand: DriedDemandByMicrogreen = {};

  for (const t of targets) {
    const product = products.find((p) => p.id === t.product);
    if (!product) continue;
    const plannedQty = getTargetPlannedQty(t);
    if (plannedQty <= 0) continue;

    const lines = bomLines.filter((b) => b.product === product.id);
    for (const line of lines) {
      if (line.line_type !== "dried_microgreen") continue;
      if (!line.microgreen_id) continue;
      const qtyPerUnit = Number(line.qty_per_unit || 0);
      if (qtyPerUnit <= 0) continue;

      const lineQty = plannedQty * qtyPerUnit;
      const driedG = toGrams(lineQty, line.unit_label || "g");

      if (!demand[line.microgreen_id]) {
        demand[line.microgreen_id] = {
          microgreenId: line.microgreen_id,
          driedRequiredG: 0,
          explicitProfileId: line.freeze_dryer_profile_id || null,
        };
      }
      demand[line.microgreen_id].driedRequiredG += driedG;
      // Prefer an explicitly selected profile on the BOM line (if present).
      if (!demand[line.microgreen_id].explicitProfileId && line.freeze_dryer_profile_id) {
        demand[line.microgreen_id].explicitProfileId = line.freeze_dryer_profile_id;
      }
    }
  }

  return demand;
}

export function hasAnyDriedMicrogreenLines(
  productId: string,
  bomLines: BomLineRow[],
): boolean {
  return bomLines.some(
    (b) => b.product === productId && b.line_type === "dried_microgreen",
  );
}

export type TrayEstimation = {
  microgreenId: string;
  driedRequiredG: number;
  avgFreshGPerTray: number | null;
  avgDriedGPerTray: number | null;
  dryMatterFractionUsed: number | null;
  freshRequiredG: number | null;
  traysNeeded: number;
  warning: string | null;
};

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function estimateTraysNeededForDriedDemand(
  demand: DriedDemandByMicrogreen,
  yieldEntries: YieldEntryRow[],
  dryFractionByMicrogreen: Record<string, number | null>,
): TrayEstimation[] {
  const result: TrayEstimation[] = [];

  for (const microgreenId of Object.keys(demand)) {
    const driedRequiredG = demand[microgreenId].driedRequiredG;
    const entries = yieldEntries.filter((y) => y.microgreen === microgreenId);

    const freshSamples = entries
      .map((e) => Number(e.fresh_yield_g ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const avgFresh = avg(freshSamples);
    const dryFraction = dryFractionByMicrogreen[microgreenId] ?? null;

    if (avgFresh && avgFresh > 0 && dryFraction && dryFraction > 0) {
      const inferredAvgDried = avgFresh * dryFraction; // dried per microgreen tray
      const freshRequiredG = driedRequiredG / dryFraction;
      result.push({
        microgreenId,
        driedRequiredG,
        avgFreshGPerTray: avgFresh,
        avgDriedGPerTray: inferredAvgDried,
        dryMatterFractionUsed: dryFraction,
        freshRequiredG,
        traysNeeded: Math.ceil(freshRequiredG / avgFresh),
        warning: null,
      });
      continue;
    }

    // Fallback: if dried_yield_g is logged, we can estimate trays even without dry fraction.
    const driedSamples = entries
      .map((e) => Number(e.dried_yield_g ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const avgDriedDirect = avg(driedSamples);
    if (avgDriedDirect && avgDriedDirect > 0) {
      result.push({
        microgreenId,
        driedRequiredG,
        avgFreshGPerTray: avgFresh,
        avgDriedGPerTray: avgDriedDirect,
        dryMatterFractionUsed: null,
        freshRequiredG: null,
        traysNeeded: Math.ceil(driedRequiredG / avgDriedDirect),
        warning:
          "Dry matter fraction is missing; trays were estimated directly from logged dried yield per tray.",
      });
      continue;
    }

    result.push({
      microgreenId,
      driedRequiredG,
      avgFreshGPerTray: avgFresh,
      avgDriedGPerTray: null,
      dryMatterFractionUsed: dryFraction,
      freshRequiredG: null,
      traysNeeded: 0,
      warning:
        "Missing yield data (fresh yield and dry matter fraction, or dried yield) for this microgreen; cannot estimate trays needed.",
    });
  }

  return result;
}

export type FreezeDryerRun = {
  microgreenId: string;
  trays: number;
  runIndex: number; // within the cycle + microgreen
  profileId: string | null;
};

export type ScheduledFreezeDryerRun = FreezeDryerRun & {
  cycleId: string;
  runStart: Date; // harvest + freeze-dry start
  runEnd: Date;
};

export function getProfileForMicrogreen(
  microgreenId: string,
  explicitProfileId: string | null,
  profiles: FreezeDryerProfileRow[],
): FreezeDryerProfileRow | null {
  if (explicitProfileId) {
    return profiles.find((p) => p.id === explicitProfileId) || null;
  }
  return profiles.find((p) => p.linked_microgreen_id === microgreenId) || null;
}

export function buildRunsForMicrogreen(
  microgreenId: string,
  traysNeeded: number,
  capacityTraysPerRun: number,
  profileId: string | null,
): FreezeDryerRun[] {
  if (!Number.isFinite(traysNeeded) || traysNeeded <= 0) return [];
  const cap = Math.max(1, Math.floor(capacityTraysPerRun || 1));

  const runs: FreezeDryerRun[] = [];
  let remaining = traysNeeded;
  let runIndex = 1;
  while (remaining > 0) {
    const trays = remaining >= cap ? cap : remaining;
    runs.push({ microgreenId, trays, runIndex, profileId });
    remaining -= trays;
    runIndex += 1;
  }
  return runs;
}

export function scheduleRunsWithTwoDayBuffer(
  cycle: ProductionCycleRow,
  runs: FreezeDryerRun[],
  profiles: FreezeDryerProfileRow[],
  machine: FreezeDryerMachineSettingsRow | null,
  bufferDays: number = 2,
): { scheduled: ScheduledFreezeDryerRun[]; warning: string | null } {
  const start = toMidnight(cycle.start_date);
  const end = toMidnight(cycle.end_date);

  let cursor = start;
  const scheduled: ScheduledFreezeDryerRun[] = [];
  let warning: string | null = null;

  for (const run of runs) {
    const profile = getProfileForMicrogreen(run.microgreenId, run.profileId, profiles);
    const cycleHours = Number(profile?.cycle_time_hours || 0);
    const cleaningHours =
      profile?.defrost_cleaning_hours_override ??
      machine?.default_defrost_cleaning_hours ??
      0;
    const durationMs = Math.max(0, (cycleHours + Number(cleaningHours || 0)) * 60 * 60 * 1000);

    const runStart = cursor;
    const runEnd = new Date(runStart.getTime() + durationMs);

    scheduled.push({
      ...run,
      cycleId: cycle.id,
      runStart,
      runEnd,
    });

    // Next run: 2 days AFTER the previous run completes.
    const nextAnchor = toMidnight(runEnd.toISOString());
    cursor = addDays(nextAnchor, bufferDays);
  }

  if (scheduled.length) {
    const lastEnd = scheduled[scheduled.length - 1].runEnd;
    if (lastEnd.getTime() > end.getTime()) {
      warning =
        "Freeze-dryer runs extend beyond the production cycle end date. Consider expanding the cycle window.";
    }
  }

  return { scheduled, warning };
}

export type GrowTaskType = "soak" | "drain" | "sow" | "move_to_light" | "harvest";

export type GrowTask = {
  cycleId: string;
  microgreenId: string;
  trays: number;
  runNumber: number;
  taskType: GrowTaskType;
  date: Date;
};

export function deriveGrowTasksFromRuns(
  scheduledRuns: ScheduledFreezeDryerRun[],
  microgreens: MicrogreenRow[],
): GrowTask[] {
  const tasks: GrowTask[] = [];

  for (const run of scheduledRuns) {
    const mg = microgreens.find((m) => m.id === run.microgreenId);
    if (!mg) continue;

    const daysToHarvest = mg.harvest_offset_days ?? mg.days_to_harvest ?? 0;
    const germinationDays = mg.light_offset_days ?? mg.germination_days ?? 0;

    // Harvest date is the freeze-dry start (you harvest and immediately freeze-dry).
    const harvestDate = toMidnight(run.runStart.toISOString());
    const sowDate = addDays(harvestDate, -daysToHarvest);
    const lightDate = addDays(sowDate, germinationDays);
    const soakDate = mg.soaking_required ? addDays(sowDate, -1) : null;
    const drainDate = mg.soaking_required ? sowDate : null;

    if (soakDate) {
      tasks.push({
        cycleId: run.cycleId,
        microgreenId: run.microgreenId,
        trays: run.trays,
        runNumber: run.runIndex,
        taskType: "soak",
        date: soakDate,
      });
    }
    if (drainDate) {
      tasks.push({
        cycleId: run.cycleId,
        microgreenId: run.microgreenId,
        trays: run.trays,
        runNumber: run.runIndex,
        taskType: "drain",
        date: drainDate,
      });
    }
    tasks.push({
      cycleId: run.cycleId,
      microgreenId: run.microgreenId,
      trays: run.trays,
      runNumber: run.runIndex,
      taskType: "sow",
      date: sowDate,
    });
    tasks.push({
      cycleId: run.cycleId,
      microgreenId: run.microgreenId,
      trays: run.trays,
      runNumber: run.runIndex,
      taskType: "move_to_light",
      date: lightDate,
    });
    tasks.push({
      cycleId: run.cycleId,
      microgreenId: run.microgreenId,
      trays: run.trays,
      runNumber: run.runIndex,
      taskType: "harvest",
      date: harvestDate,
    });
  }

  tasks.sort((a, b) => a.date.getTime() - b.date.getTime());
  return tasks;
}

