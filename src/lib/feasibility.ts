import { msPerDay, toMidnight } from "@/lib/date";
import { toGrams, gramsToOz } from "@/lib/units";

/**
 * Shared feasibility / shortage calculations.
 *
 * Extracted from the per-cycle planner (src/app/cycles/[id]/plan/page.tsx) so the
 * dashboard's status table and the planner page always agree on what "feasible"
 * means for a given cycle — there is exactly one implementation of this math.
 */

export type MinileafAggregateRow = {
  microgreen_id: string;
  microgreen_name: string;
  total_oz_needed: number;
  avg_yield_oz_per_tray: number;
  estimated_trays: number;
  extra_full_trays: number;
  final_trays: number;
  hasYield: boolean;
};

export type MiniLeafFeasibility = {
  mode: "MiniLeaf";
  harvest_date: string | null;
  harvestDate: Date | null;
  minileafAggregate: MinileafAggregateRow[];
  hasYield: boolean;
  feasible: boolean;
  warning: string | null;
};

export type BotaniqalsFeasibility = {
  mode: "BotanIQals";
  production_days: number;
  total_dried_needed_g: number;
  total_fresh_needed_g: number;
  hours_per_cycle: number;
  per_cycle_fresh_capacity: number;
  total_available_hours: number;
  max_cycles_available: number;
  required_cycles: number;
  feasible: boolean;
};

export type Feasibility = MiniLeafFeasibility | BotaniqalsFeasibility;

export type ShortageRow = {
  id: string;
  name: string;
  unit: string;
  required: number;
  onHand: number;
  shortage: number;
};

/** Per-microgreen tray aggregation for a MiniLeaf cycle's targets. */
export function computeMinileafAggregate(params: {
  isMiniLeaf: boolean;
  targets: any[];
  products: any[];
  variants: any[];
  microgreens: any[];
  yieldEntries: any[];
}): MinileafAggregateRow[] | null {
  const { isMiniLeaf, targets, products, variants, microgreens, yieldEntries } = params;
  if (!isMiniLeaf || !targets.length) return null;

  const ozByMicrogreen: Record<
    string,
    { total_oz: number; extra_full_trays: number; lines: { productName: string; variantName: string; qty: number; oz: number }[] }
  > = {};

  for (const t of targets) {
    const product = products.find((p: any) => p.id === t.product);
    if (!product || !product.microgreen) continue;
    const variant = t.product_variant_id
      ? variants.find((v: any) => v.id === t.product_variant_id)
      : null;
    if (!variant) continue;
    const qty = Number(t.quantity_to_produce ?? t.target_units ?? 0);
    const oz = qty * Number(variant.size_oz || 0);
    const mgId = product.microgreen;
    if (!ozByMicrogreen[mgId]) {
      ozByMicrogreen[mgId] = { total_oz: 0, extra_full_trays: 0, lines: [] };
    }
    ozByMicrogreen[mgId].total_oz += oz;
    ozByMicrogreen[mgId].extra_full_trays += Number(t.extra_full_trays || 0);
    ozByMicrogreen[mgId].lines.push({
      productName: product.name,
      variantName: variant.name,
      qty,
      oz,
    });
  }

  const result: MinileafAggregateRow[] = [];
  for (const [mgId, data] of Object.entries(ozByMicrogreen)) {
    const mg = microgreens.find((m: any) => m.id === mgId);
    const entries = yieldEntries.filter((y: any) => y.microgreen === mgId);
    const avgFreshG = entries.length
      ? entries.reduce((s: number, e: any) => s + Number(e.fresh_yield_g || 0), 0) / entries.length
      : 0;
    const avg_yield_oz_per_tray = gramsToOz(avgFreshG);
    const estimated_trays = avg_yield_oz_per_tray > 0
      ? Math.ceil(data.total_oz / avg_yield_oz_per_tray)
      : 0;
    const final_trays = estimated_trays + (data.extra_full_trays || 0);
    result.push({
      microgreen_id: mgId,
      microgreen_name: mg?.name ?? "?",
      total_oz_needed: data.total_oz,
      avg_yield_oz_per_tray,
      estimated_trays,
      extra_full_trays: data.extra_full_trays || 0,
      final_trays,
      hasYield: entries.length > 0,
    });
  }
  return result;
}

/**
 * Feasibility for a single production cycle. Mirrors the calculation that used to
 * live inline in the planner page's `feasibility` useMemo.
 */
export function computeFeasibility(params: {
  cycle: any | null;
  isMiniLeaf: boolean;
  targets: any[];
  products: any[];
  bomLines: any[];
  calibration: any | null;
  machine?: any | null;
  minileafAggregate: MinileafAggregateRow[] | null;
}): Feasibility | null {
  const { cycle, isMiniLeaf, targets, products, bomLines, calibration, machine, minileafAggregate } = params;
  if (!cycle || !targets.length) return null;

  if (isMiniLeaf) {
    const harvestDate = cycle.harvest_date ? toMidnight(cycle.harvest_date) : null;
    const hasYield = minileafAggregate?.every((a) => a.hasYield) ?? false;
    return {
      mode: "MiniLeaf",
      harvest_date: cycle.harvest_date,
      harvestDate,
      minileafAggregate: minileafAggregate ?? [],
      hasYield,
      feasible: hasYield,
      warning: !hasYield ? "Some microgreens have no yield data; tray estimates may be unreliable." : null,
    };
  }

  const startMidnight = toMidnight(cycle.start_date);
  const endMidnight = toMidnight(cycle.end_date);
  const production_days =
    Math.floor((endMidnight.getTime() - startMidnight.getTime()) / msPerDay) + 1;
  const cal = calibration || machine;
  const totals = targets.reduce(
    (acc: any, t: any) => {
      const product = products.find((p: any) => p.id === t.product);
      if (!product) return acc;
      const qty = Number(t.quantity_to_produce ?? t.target_units ?? 0);
      const lines = bomLines.filter((b: any) => b.product === product.id);
      let dried = qty * Number(product.dried_needed_g_per_unit || 0);
      let fresh = product.fresh_needed_g_per_unit != null ? qty * Number(product.fresh_needed_g_per_unit) : 0;
      if (lines.length) {
        let bomFresh = 0;
        let bomDried = 0;
        for (const line of lines) {
          const lineQty = qty * Number(line.qty_per_unit || 0);
          const g = toGrams(lineQty, line.unit_label || "g");
          if (line.line_type === "raw_microgreen") bomFresh += g;
          if (line.line_type === "dried_microgreen") bomDried += g;
        }
        if (bomFresh > 0 || bomDried > 0) {
          fresh = bomFresh || fresh;
          dried = bomDried || dried;
          if (fresh > 0 && dried === 0 && cal)
            dried = fresh / Number(cal.dry_matter_fraction || 1);
        }
      } else if (fresh === 0 && dried > 0 && cal) {
        fresh = dried / Number(cal.dry_matter_fraction || 1);
      }
      acc.total_dried_needed_g += dried;
      acc.total_fresh_needed_g += fresh;
      return acc;
    },
    { total_dried_needed_g: 0, total_fresh_needed_g: 0 }
  );
  const hours_per_cycle =
    Number(cal?.cycle_time_hours || 0) + Number(cal?.defrost_cleaning_hours ?? cal?.default_defrost_cleaning_hours ?? 0);
  const per_cycle_fresh_capacity =
    Number(cal?.number_of_freeze_dryers || 0) *
    Number(cal?.trays_per_machine_per_cycle || 0) *
    Number(cal?.fresh_load_per_tray_g ?? cal?.default_fresh_load_per_tray_g ?? 0);
  const total_available_hours = production_days * Number(cal?.operating_hours_per_day || 0);
  const max_cycles_available = Math.floor(total_available_hours / (hours_per_cycle || 1));
  const cycles_needed = per_cycle_fresh_capacity > 0 ? totals.total_fresh_needed_g / per_cycle_fresh_capacity : 0;
  const required_cycles = Math.ceil(cycles_needed || 0);
  const feasible = max_cycles_available >= required_cycles;
  return {
    mode: "BotanIQals",
    production_days,
    total_dried_needed_g: totals.total_dried_needed_g,
    total_fresh_needed_g: totals.total_fresh_needed_g,
    hours_per_cycle,
    per_cycle_fresh_capacity,
    total_available_hours,
    max_cycles_available,
    required_cycles,
    feasible,
  };
}

/** Inventory shortages implied by a cycle's targets against on-hand quantities. */
export function computeShortages(params: {
  targets: any[];
  products: any[];
  bomLines: any[];
  items: any[];
}): ShortageRow[] {
  const { targets, products, bomLines, items } = params;
  if (!targets.length || !items.length) return [];
  const requiredByItem: Record<string, { item: any; required: number }> = {};
  for (const t of targets) {
    const product = products.find((p: any) => p.id === t.product);
    if (!product) continue;
    const qty = Number(t.quantity_to_produce ?? t.target_units ?? 0);
    const lines = bomLines.filter((b: any) => b.product === product.id);
    for (const line of lines) {
      if (!line.inventory_item) continue;
      const item = items.find((i: any) => i.id === line.inventory_item);
      if (!item) continue;
      const required_qty = qty * Number(line.qty_per_unit || 0);
      if (!requiredByItem[item.id]) requiredByItem[item.id] = { item, required: 0 };
      requiredByItem[item.id].required += required_qty;
    }
  }
  return Object.values(requiredByItem).map(({ item, required }) => {
    const onHand = Number(item.quantity_on_hand || 0);
    return {
      id: item.id,
      name: item.name,
      unit: item.unit,
      required,
      onHand,
      shortage: Math.max(0, required - onHand),
    };
  });
}

/** Short label + color classes for a feasibility badge, used by both the planner and dashboard. */
export function feasibilityBadge(feasibility: Feasibility | null): {
  label: string;
  className: string;
} {
  if (!feasibility) {
    return { label: "No targets yet", className: "bg-zinc-100 text-zinc-600" };
  }
  if (feasibility.mode === "MiniLeaf") {
    return feasibility.feasible
      ? { label: "Feasible", className: "bg-emerald-100 text-emerald-800" }
      : { label: "Warning", className: "bg-amber-100 text-amber-800" };
  }
  return feasibility.feasible
    ? { label: "Feasible", className: "bg-emerald-100 text-emerald-800" }
    : { label: "Not feasible", className: "bg-red-100 text-red-800" };
}
