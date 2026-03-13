"use client";

import { useMemo, useState, FormEvent, useEffect } from "react";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { addDays, formatDate, msPerDay, toMidnight } from "@/lib/date";
import { toGrams, gramsToOz } from "@/lib/units";
import { useSupabase } from "@/components/InstantProvider";

type TargetForm = {
  id?: string;
  product_id: string;
  product_variant_id: string;
  quantity_to_produce: number | "";
  extra_full_trays: number | "";
  selection: string;
  target_units: number | "";
};

export default function CyclePlanPage() {
  const params = useParams<{ id: string }>();
  const cycleId = params.id;
  const { user, supabase } = useSupabase();

  const [cycle, setCycle] = useState<any | null>(null);
  const [targets, setTargets] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [microgreens, setMicrogreens] = useState<any[]>([]);
  const [bomLines, setBomLines] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [calibration, setCalibration] = useState<any | null>(null);
  const [planLines, setPlanLines] = useState<any[]>([]);
  const [yieldEntries, setYieldEntries] = useState<any[]>([]);
  const [variants, setVariants] = useState<any[]>([]);
  const [machine, setMachine] = useState<any | null>(null);
  const [freezeDryerProfiles, setFreezeDryerProfiles] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [targetForm, setTargetForm] = useState<TargetForm>({
    product_id: "",
    product_variant_id: "",
    quantity_to_produce: "",
    extra_full_trays: "",
    selection: "",
    target_units: "",
  });

  const isMiniLeaf =
    cycle?.business_type === "MiniLeaf" || cycle?.brand === "minileaf";

  const microgreenProducts = useMemo(
    () => products.filter((p: any) => p.is_microgreen === true),
    [products]
  );

  const variantOptionsByProduct = useMemo(() => {
    const map: Record<string, { id: string; name: string; size_oz: number }[]> = {};
    microgreenProducts.forEach((p: any) => {
      const list = variants
        .filter((v: any) => v.product_id === p.id && v.is_active !== false)
        .map((v: any) => ({ id: v.id, name: v.name, size_oz: Number(v.size_oz || 0) }));
      map[p.id] = list;
    });
    return map;
  }, [microgreenProducts, variants]);

  const productOptionsMiniLeaf = useMemo(
    () =>
      microgreenProducts.map((p: any) => ({
        value: p.id,
        label: p.name,
        product: p,
      })),
    [microgreenProducts]
  );

  const productOptionsBotanIQals = useMemo(
    () =>
      products
        .filter((p: any) => !p.is_microgreen)
        .map((p: any) => ({ value: p.id, label: p.name, product: p })),
    [products]
  );
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);

  const [planError, setPlanError] = useState<string | null>(null);
  const [planWarning, setPlanWarning] = useState<string | null>(null);
  const [planSaving, setPlanSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const [
        cRes,
        tRes,
        pRes,
        mRes,
        bRes,
        iRes,
        calRes,
        planRes,
        yRes,
        vRes,
        machineRes,
        profilesRes,
      ] = await Promise.all([
        supabase
          .from("production_cycles")
          .select("*")
          .eq("id", cycleId)
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("production_targets")
          .select("*")
          .eq("production_cycle", cycleId)
          .eq("user_id", user.id),
        supabase.from("products").select("*").eq("user_id", user.id),
        supabase.from("microgreens").select("*").eq("user_id", user.id),
        supabase.from("bom_lines").select("*").eq("user_id", user.id),
        supabase.from("inventory_items").select("*").eq("user_id", user.id),
        supabase
          .from("calibration")
          .select("*")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle(),
        supabase
          .from("production_plan_lines")
          .select("*")
          .eq("production_cycle", cycleId)
          .eq("user_id", user.id),
        supabase
          .from("yield_entries")
          .select("*")
          .eq("user_id", user.id),
        supabase
          .from("product_variants")
          .select("*")
          .eq("user_id", user.id),
        supabase
          .from("freeze_dryer_machine_settings")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("freeze_dryer_profiles")
          .select("*")
          .eq("user_id", user.id),
      ]);

      if (cRes.data) setCycle(cRes.data);
      setTargets(tRes.data || []);
      setProducts(pRes.data || []);
      setMicrogreens(mRes.data || []);
      setBomLines(bRes.data || []);
      setItems(iRes.data || []);
      setCalibration(calRes.data || null);
      setPlanLines(planRes.data || []);
      setYieldEntries(yRes.data || []);
      setVariants(vRes.data || []);
      setMachine(machineRes.data || null);
      setFreezeDryerProfiles(profilesRes.data || []);
      setIsLoading(false);
    };
    load();
  }, [user, supabase, cycleId]);

  if (!cycle && !isLoading) {
    return (
      <AuthGuard>
        <div className="mx-auto max-w-3xl text-sm text-red-600">
          Production cycle not found.
        </div>
      </AuthGuard>
    );
  }

  const handleTargetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !cycleId) return;
    const qty = isMiniLeaf
      ? Number(targetForm.quantity_to_produce || 0)
      : Number(targetForm.target_units || 0);
    if (isMiniLeaf) {
      if (!targetForm.product_id) {
        setTargetError("Choose a product.");
        return;
      }
      if (!targetForm.product_variant_id) {
        setTargetError("Choose a variant.");
        return;
      }
      if (qty <= 0) {
        setTargetError("Enter quantity to produce.");
        return;
      }
    } else {
      if (!targetForm.product_id) {
        setTargetError("Choose a product.");
        return;
      }
      if (qty <= 0) {
        setTargetError("Enter quantity to produce.");
        return;
      }
    }
    setTargetSaving(true);
    setTargetError(null);
    try {
      const payload: any = {
        product: targetForm.product_id,
        target_units: qty,
        quantity_to_produce: qty,
        user_id: user.id,
      };
      if (isMiniLeaf) {
        payload.product_variant_id = targetForm.product_variant_id || null;
        payload.extra_full_trays = Number(targetForm.extra_full_trays || 0) || null;
      } else {
        payload.product_variant_id = null;
        payload.extra_full_trays = null;
      }
      if (targetForm.id) {
        const { error } = await supabase
          .from("production_targets")
          .update(payload)
          .eq("id", targetForm.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("production_targets").insert({
          production_cycle: cycleId,
          ...payload,
        });
        if (error) throw error;
      }
      const { data: refreshed } = await supabase
        .from("production_targets")
        .select("*")
        .eq("production_cycle", cycleId)
        .eq("user_id", user.id);
      setTargets(refreshed || []);
      setTargetForm({
        product_id: "",
        product_variant_id: "",
        quantity_to_produce: "",
        extra_full_trays: "",
        selection: "",
        target_units: "",
      });
    } catch (err: any) {
      setTargetError(err.message || "Failed to save target.");
    } finally {
      setTargetSaving(false);
    }
  };

  const handleEditTarget = (t: any) => {
    setTargetError(null);
    const qty = t.quantity_to_produce ?? t.target_units;
    setTargetForm({
      id: t.id,
      product_id: t.product,
      product_variant_id: t.product_variant_id || "",
      quantity_to_produce: qty ?? "",
      extra_full_trays: t.extra_full_trays ?? "",
      selection: "",
      target_units: qty ?? "",
    });
  };

  const handleDeleteTarget = async (id: string) => {
    setTargetError(null);
    try {
      const { error } = await supabase
        .from("production_targets")
        .delete()
        .eq("id", id)
        .eq("user_id", user?.id || "");
      if (error) throw error;
      setTargets((prev) => prev.filter((t) => t.id !== id));
    } catch (err: any) {
      setTargetError(err.message || "Failed to delete target.");
    }
  };

  const minileafAggregate = useMemo(() => {
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
    const result: { microgreen_id: string; microgreen_name: string; total_oz_needed: number; avg_yield_oz_per_tray: number; estimated_trays: number; extra_full_trays: number; final_trays: number; hasYield: boolean }[] = [];
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
  }, [isMiniLeaf, targets, products, variants, microgreens, yieldEntries]);

  const feasibility = useMemo(() => {
    if (!cycle || !targets.length) return null;
    if (isMiniLeaf) {
      const harvestDate = cycle.harvest_date ? toMidnight(cycle.harvest_date) : null;
      const hasYield = minileafAggregate?.every((a) => a.hasYield) ?? false;
      return {
        mode: "MiniLeaf" as const,
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
      mode: "BotanIQals" as const,
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
  }, [cycle, calibration, machine, targets, products, bomLines, isMiniLeaf, minileafAggregate]);

  const shortages = useMemo(() => {
    if (!targets.length || !items.length) return [];
    const requiredByItem: Record<string, { item: any; required: number }> = {};
    const qtyKey = isMiniLeaf ? "quantity_to_produce" : "quantity_to_produce";
    for (const t of targets) {
      const product = products.find((p: any) => p.id === t.product);
      if (!product) continue;
      const qty = Number(t[qtyKey] ?? t.target_units ?? 0);
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
  }, [targets, bomLines, items, products, isMiniLeaf]);

  const financials = useMemo(() => {
    if (!targets.length) return null;
    let revenue = 0;
    let variantCost = 0;
    const requiredByItem: Record<string, number> = {};
    const qtyKey = isMiniLeaf ? "quantity_to_produce" : "quantity_to_produce";
    for (const t of targets) {
      const product = products.find((p: any) => p.id === t.product);
      if (!product) continue;
      const qty = Number(t[qtyKey] ?? t.target_units ?? 0);
      const variant = t.product_variant_id ? variants.find((v: any) => v.id === t.product_variant_id) : null;
      const variantLine = t.bom_line ? bomLines.find((b: any) => b.id === t.bom_line) : null;
      const unitPrice = variant?.sale_price != null ? Number(variant.sale_price) : variantLine?.sale_price != null ? Number(variantLine.sale_price) : Number(product.sale_price_per_unit || 0);
      revenue += qty * unitPrice;
      if (variant?.unit_cost != null) variantCost += qty * Number(variant.unit_cost);
      const lines = bomLines.filter((b: any) => b.product === product.id);
      for (const line of lines) {
        if (!line.inventory_item) continue;
        requiredByItem[line.inventory_item] = (requiredByItem[line.inventory_item] || 0) + qty * Number(line.qty_per_unit || 0);
      }
    }
    let material_cost = 0;
    for (const [inventory_item_id, required] of Object.entries(requiredByItem)) {
      const item = items.find((i: any) => i.id === inventory_item_id);
      if (!item) continue;
      material_cost += required * Number(item.cost_per_unit || 0);
    }
    const totalCost = material_cost + variantCost;
    const perProduct = targets.map((t: any) => {
      const product = products.find((p: any) => p.id === t.product);
      if (!product) return null;
      const qty = Number(t.quantity_to_produce ?? t.target_units ?? 0);
      const variant = t.product_variant_id ? variants.find((v: any) => v.id === t.product_variant_id) : null;
      const variantLine = t.bom_line ? bomLines.find((b: any) => b.id === t.bom_line) : null;
      const unitPrice = variant?.sale_price != null ? Number(variant.sale_price) : variantLine?.sale_price != null ? Number(variantLine.sale_price) : Number(product.sale_price_per_unit || 0);
      const displayName = variant ? `${product.name} (${variant.name})` : product.name;
      return { id: t.id, productName: displayName, target_units: qty, revenue: qty * unitPrice };
    }).filter(Boolean) as any[];
    return { revenue, material_cost, variantCost, gross_profit: revenue - totalCost, perProduct };
  }, [targets, products, bomLines, items, variants, isMiniLeaf]);

  const handleGeneratePlan = async () => {
    if (!user || !cycle) {
      setPlanError("Cycle is required.");
      return;
    }
    if (!targets.length) {
      setPlanError("Add at least one production target before generating.");
      return;
    }
    if (isMiniLeaf && !cycle.harvest_date) {
      setPlanError("MiniLeaf cycles require a harvest date. Edit the cycle to set it.");
      return;
    }
    if (isMiniLeaf && targets.length > 0 && (!minileafAggregate || minileafAggregate.length === 0)) {
      setPlanWarning("No schedule can be generated. Ensure each target has a product with a microgreen selected and a variant with size (oz). Then the schedule will appear on the Schedule page.");
      setPlanError(null);
      return;
    }

    setPlanSaving(true);
    setPlanError(null);
    setPlanWarning(null);

    try {
      const { error: delEventsError } = await supabase
        .from("schedule_events")
        .delete()
        .eq("production_cycle_id", cycle.id)
        .eq("user_id", user.id);
      if (delEventsError) throw delEventsError;

      const { error: delPlanError } = await supabase
        .from("production_plan_lines")
        .delete()
        .eq("production_cycle", cycle.id)
        .eq("user_id", user.id);
      if (delPlanError) throw delPlanError;

      const businessType = cycle.business_type || (cycle.brand === "minileaf" ? "MiniLeaf" : "BotanIQals");

      if (isMiniLeaf && minileafAggregate && minileafAggregate.length > 0) {
        const harvestDate = toMidnight(cycle.harvest_date);
        const planInserts: any[] = [];
        const eventInserts: any[] = [];
        for (const agg of minileafAggregate) {
          const mg = microgreens.find((m: any) => m.id === agg.microgreen_id);
          if (!mg) continue;
          const daysToHarvest = mg.harvest_offset_days ?? mg.days_to_harvest ?? 0;
          const germinationDays = mg.light_offset_days ?? mg.germination_days ?? 0;
          const soakOffset = mg.default_soak_offset_days ?? 1;
          const sowDate = addDays(harvestDate, -daysToHarvest);
          const lightDate = addDays(sowDate, germinationDays);
          const soakDate = mg.soaking_required ? addDays(sowDate, -soakOffset) : null;
          const drainDate = mg.soaking_required ? sowDate : null;

          planInserts.push({
            production_cycle: cycle.id,
            microgreen: mg.id,
            source_product: products.find((p: any) => p.microgreen === agg.microgreen_id)?.id ?? null,
            business_type: "MiniLeaf",
            fresh_required_g: Math.ceil(agg.total_oz_needed * 28.3495),
            run_number: 1,
            trays_this_run: agg.final_trays,
            soak_date: soakDate?.toISOString() ?? null,
            drain_date: drainDate?.toISOString() ?? null,
            sow_date: sowDate.toISOString(),
            light_date: lightDate.toISOString(),
            harvest_date: harvestDate.toISOString(),
            user_id: user.id,
          });

          const base = { production_cycle_id: cycle.id, user_id: user.id, business_type: "MiniLeaf", microgreen_id: mg.id, status: "planned" as const };
          if (soakDate) eventInserts.push({ ...base, event_type: "soak", title: `Soak ${mg.name}`, start_at: soakDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: null, run_number: null, machine_number: null, notes: null });
          if (drainDate) eventInserts.push({ ...base, event_type: "drain", title: `Drain ${mg.name}`, start_at: drainDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: null, run_number: null, machine_number: null, notes: null });
          eventInserts.push({ ...base, event_type: "sow", title: `Sow ${mg.name}`, start_at: sowDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: agg.final_trays, run_number: 1, machine_number: null, notes: null });
          eventInserts.push({ ...base, event_type: "move_to_light", title: `Move to light ${mg.name}`, start_at: lightDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: agg.final_trays, run_number: null, machine_number: null, notes: null });
          eventInserts.push({ ...base, event_type: "harvest", title: `Harvest ${mg.name}`, start_at: harvestDate.toISOString(), end_at: null, quantity: agg.total_oz_needed, quantity_unit: "oz", trays: agg.final_trays, run_number: null, machine_number: null, notes: null });
        }
        if (planInserts.length) {
          const { error: planErr } = await supabase.from("production_plan_lines").insert(planInserts);
          if (planErr) throw planErr;
        }
        if (eventInserts.length) {
          const { error: evErr } = await supabase.from("schedule_events").insert(eventInserts);
          if (evErr) {
            throw new Error(
              `Plan lines were saved but schedule events could not be created. Check that the schedule_events table exists and has columns production_cycle_id and user_id (run the migration in Supabase SQL Editor). Error: ${evErr.message}`
            );
          }
        }
        if (!minileafAggregate.every((a) => a.hasYield)) {
          setPlanWarning("Some microgreens have no yield data; tray estimates may be unreliable.");
        }
      } else if (!isMiniLeaf) {
        const startMidnight = toMidnight(cycle.start_date);
        const endMidnight = toMidnight(cycle.end_date);
        const cal = calibration || machine;
        const planInserts: any[] = [];
        const eventInserts: any[] = [];
        const THREE_DAYS_MS = 3 * msPerDay;
        const runBlocks: { start: Date; end: Date; microgreen_id: string; mgName: string; fresh_g: number; runNumber: number; machineNumber: number }[] = [];
        let runNumber = 0;
        let machineNumber = 0;
        const numMachines = Number(cal?.number_of_freeze_dryers || 1);

        for (const t of targets) {
          const product = products.find((p: any) => p.id === t.product);
          if (!product) continue;
          const qty = Number(t.quantity_to_produce ?? t.target_units ?? 0);
          const lines = bomLines.filter((b: any) => b.product === product.id);
          for (const line of lines) {
            if (line.line_type !== "dried_microgreen" || !line.microgreen_id) continue;
            const lineG = qty * Number(line.qty_per_unit || 0) * (line.unit_label?.toLowerCase() === "oz" ? 28.3495 : 1);
            const profile = freezeDryerProfiles.find((p: any) => p.id === line.freeze_dryer_profile_id) || freezeDryerProfiles.find((p: any) => p.linked_microgreen_id === line.microgreen_id);
            const dryFraction = profile?.dry_matter_fraction ?? cal?.dry_matter_fraction ?? 0.1;
            const freshG = lineG / dryFraction;
            const perRun = Number(cal?.trays_per_machine_per_cycle || 0) * (profile?.fresh_load_per_tray_g_override ?? cal?.default_fresh_load_per_tray_g ?? cal?.fresh_load_per_tray_g ?? 1500) * numMachines;
            const runsNeeded = perRun > 0 ? Math.ceil(freshG / perRun) : 0;
            const mg = microgreens.find((m: any) => m.id === line.microgreen_id);
            for (let r = 0; r < runsNeeded; r++) {
              runNumber++;
              machineNumber = (runNumber - 1) % numMachines;
              runBlocks.push({
                start: new Date(startMidnight.getTime() + (runNumber - 1) * THREE_DAYS_MS),
                end: new Date(startMidnight.getTime() + runNumber * THREE_DAYS_MS),
                microgreen_id: line.microgreen_id,
                mgName: mg?.name ?? "?",
                fresh_g: Math.ceil(freshG / runsNeeded),
                runNumber,
                machineNumber: machineNumber + 1,
              });
            }
          }
        }
        runBlocks.sort((a, b) => a.start.getTime() - b.start.getTime());
        let lastEnd = startMidnight.getTime();
        const scheduled: typeof runBlocks = [];
        for (const block of runBlocks) {
          if (block.start.getTime() < lastEnd) block.start = new Date(lastEnd);
          block.end = new Date(block.start.getTime() + THREE_DAYS_MS);
          if (block.end.getTime() > endMidnight.getTime()) {
            setPlanWarning("Not all freeze dryer runs fit in the cycle window; plan may be infeasible.");
          }
          scheduled.push(block);
          lastEnd = block.end.getTime();
        }

        for (const block of scheduled) {
          const mg = microgreens.find((m: any) => m.id === block.microgreen_id);
          const daysToHarvest = mg?.harvest_offset_days ?? mg?.days_to_harvest ?? 0;
          const germinationDays = mg?.light_offset_days ?? mg?.germination_days ?? 0;
          const sowDate = addDays(block.start, -daysToHarvest);
          const lightDate = addDays(sowDate, germinationDays);
          const soakDate = mg?.soaking_required ? addDays(sowDate, -(mg.default_soak_offset_days ?? 1)) : null;
          const drainDate = mg?.soaking_required ? sowDate : null;

          planInserts.push({
            production_cycle: cycle.id,
            microgreen: block.microgreen_id,
            source_product: null,
            business_type: "BotanIQals",
            fresh_required_g: block.fresh_g,
            run_number: block.runNumber,
            trays_this_run: Math.ceil(block.fresh_g / (cal?.default_fresh_load_per_tray_g ?? cal?.fresh_load_per_tray_g ?? 1500)),
            soak_date: soakDate?.toISOString() ?? null,
            drain_date: drainDate?.toISOString() ?? null,
            sow_date: sowDate.toISOString(),
            light_date: lightDate.toISOString(),
            harvest_date: block.start.toISOString(),
            user_id: user.id,
          });

          const base = { production_cycle_id: cycle.id, user_id: user.id, business_type: "BotanIQals", microgreen_id: block.microgreen_id, status: "planned" as const, product_id: null, product_variant_id: null, freeze_dryer_profile_id: null };
          if (soakDate) eventInserts.push({ ...base, event_type: "soak", title: `Soak ${block.mgName}`, start_at: soakDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: null, run_number: null, machine_number: null, notes: null });
          if (drainDate) eventInserts.push({ ...base, event_type: "drain", title: `Drain ${block.mgName}`, start_at: drainDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: null, run_number: null, machine_number: null, notes: null });
          eventInserts.push({ ...base, event_type: "sow", title: `Sow ${block.mgName}`, start_at: sowDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: null, run_number: block.runNumber, machine_number: block.machineNumber, notes: null });
          eventInserts.push({ ...base, event_type: "move_to_light", title: `Move to light ${block.mgName}`, start_at: lightDate.toISOString(), end_at: null, quantity: null, quantity_unit: null, trays: null, run_number: null, machine_number: null, notes: null });
          eventInserts.push({ ...base, event_type: "harvest", title: `Harvest ${block.mgName}`, start_at: block.start.toISOString(), end_at: null, quantity: block.fresh_g, quantity_unit: "g", trays: null, run_number: block.runNumber, machine_number: block.machineNumber, notes: null });
          eventInserts.push({ ...base, event_type: "freeze_dry_start", title: `Freeze dry start ${block.mgName}`, start_at: block.start.toISOString(), end_at: null, quantity: block.fresh_g, quantity_unit: "g", trays: null, run_number: block.runNumber, machine_number: block.machineNumber, notes: null });
          eventInserts.push({ ...base, event_type: "freeze_dry_end", title: `Freeze dry end ${block.mgName}`, start_at: block.start.toISOString(), end_at: block.end.toISOString(), quantity: null, quantity_unit: null, trays: null, run_number: block.runNumber, machine_number: block.machineNumber, notes: null });
        }

        if (planInserts.length) {
          const { error: planErr } = await supabase.from("production_plan_lines").insert(planInserts);
          if (planErr) throw planErr;
        }
        if (eventInserts.length) {
          const { error: evErr } = await supabase.from("schedule_events").insert(eventInserts);
          if (evErr) {
            throw new Error(
              `Plan lines were saved but schedule events could not be created. Check that the schedule_events table exists and has columns production_cycle_id and user_id (run the migration in Supabase SQL Editor). Error: ${evErr.message}`
            );
          }
        }
      }

      const { data: refreshed } = await supabase
        .from("production_plan_lines")
        .select("*")
        .eq("production_cycle", cycle.id)
        .eq("user_id", user.id);
      setPlanLines(refreshed || []);
    } catch (err: any) {
      setPlanError(err.message || "Failed to generate plan.");
    } finally {
      setPlanSaving(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Cycle Planner
          </h1>
          {cycle && (
            <p className="text-sm text-black">
              {isMiniLeaf && cycle.harvest_date
                ? `Harvest: ${formatDate(cycle.harvest_date)}`
                : `${formatDate(cycle.start_date)} – ${formatDate(cycle.end_date)}`}{" "}
              · {isMiniLeaf ? "MiniLeaf" : "BotanIQals"} · Status: {cycle.status}
            </p>
          )}
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-1">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Production targets
              </h2>
              {isMiniLeaf && productOptionsMiniLeaf.length === 0 && (
                <p className="mb-2 text-[11px] text-amber-700">
                  No microgreen products. Add products with &quot;Is Microgreen&quot; and variants in Products & BOM.
                </p>
              )}
              <form onSubmit={handleTargetSubmit} className="space-y-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Product
                  </label>
                  <select
                    required
                    value={targetForm.product_id}
                    onChange={(e) =>
                      setTargetForm((prev) => ({
                        ...prev,
                        product_id: e.target.value,
                        product_variant_id: "",
                      }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Select…</option>
                    {isMiniLeaf
                      ? productOptionsMiniLeaf.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))
                      : productOptionsBotanIQals.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                  </select>
                </div>
                {isMiniLeaf && targetForm.product_id && (
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">
                      Variant
                    </label>
                    <select
                      required
                      value={targetForm.product_variant_id}
                      onChange={(e) =>
                        setTargetForm((prev) => ({
                          ...prev,
                          product_variant_id: e.target.value,
                        }))
                      }
                      className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    >
                      <option value="">Select…</option>
                      {(variantOptionsByProduct[targetForm.product_id] || []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} ({v.size_oz} oz)
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    {isMiniLeaf ? "Quantity to produce" : "Quantity to produce"}
                  </label>
                  <input
                    type="number"
                    required
                    min={1}
                    value={isMiniLeaf ? targetForm.quantity_to_produce : targetForm.target_units}
                    onChange={(e) => {
                      const v = e.target.value === "" ? "" : Number(e.target.value);
                      if (isMiniLeaf) setTargetForm((prev) => ({ ...prev, quantity_to_produce: v }));
                      else setTargetForm((prev) => ({ ...prev, target_units: v }));
                    }}
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                {isMiniLeaf && (
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">
                      Extra full trays (optional)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={targetForm.extra_full_trays}
                      onChange={(e) =>
                        setTargetForm((prev) => ({
                          ...prev,
                          extra_full_trays: e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                      className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                )}
                {targetError && (
                  <p className="text-xs text-red-600" role="alert">
                    {targetError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={targetSaving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {targetSaving ? "Saving…" : "Save target"}
                </button>
              </form>

              <div className="mt-3 max-h-40 space-y-1 overflow-y-auto">
                {targets.length ? (
                  targets.map((t: any) => {
                    const product = products.find((p: any) => p.id === t.product);
                    const variant = t.product_variant_id ? variants.find((v: any) => v.id === t.product_variant_id) : null;
                    const qty = t.quantity_to_produce ?? t.target_units;
                    const displayName = variant ? `${product?.name ?? "?"} (${variant.name})` : product?.name ?? "Unknown";
                    return (
                      <div
                        key={t.id}
                        className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1"
                      >
                        <div className="text-[11px] text-zinc-800">
                          {displayName} · {qty}
                          {t.extra_full_trays ? ` · +${t.extra_full_trays} trays` : ""}
                        </div>
                        <div className="flex gap-1">
                          <button type="button" className="text-[11px] text-emerald-700 underline" onClick={() => handleEditTarget(t)}>Edit</button>
                          <button type="button" className="text-[11px] text-red-600 underline" onClick={() => handleDeleteTarget(t.id)}>Remove</button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-[11px] text-black">
                    No production targets yet. Add targets to compute feasibility and plans.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4 lg:col-span-2">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">
                  {isMiniLeaf ? "MiniLeaf plan" : "BotanIQals / Freeze dryer feasibility"}
                </h2>
                <button
                  type="button"
                  disabled={planSaving}
                  onClick={handleGeneratePlan}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {planSaving ? "Generating…" : "Generate / Regenerate Plan"}
                </button>
              </div>
              {feasibility ? (
                feasibility.mode === "MiniLeaf" ? (
                  <div className="space-y-2">
                    {feasibility.warning && (
                      <p className="text-xs text-amber-700" role="status">{feasibility.warning}</p>
                    )}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Metric label="Harvest date" value={feasibility.harvest_date ? formatDate(feasibility.harvest_date) : "—"} />
                      <Metric label="Feasible?" value={feasibility.feasible ? "Yes" : "Warning"} highlight={!feasibility.feasible} />
                    </div>
                    {feasibility.minileafAggregate.length > 0 && (
                      <table className="min-w-full border-collapse text-left text-[11px]">
                        <thead className="bg-zinc-50">
                          <tr>
                            <th className="px-2 py-1 font-medium">Microgreen</th>
                            <th className="px-2 py-1 font-medium">Total oz</th>
                            <th className="px-2 py-1 font-medium">Avg yield/tray (oz)</th>
                            <th className="px-2 py-1 font-medium">Est. trays</th>
                            <th className="px-2 py-1 font-medium">Extra trays</th>
                            <th className="px-2 py-1 font-medium">Final trays</th>
                          </tr>
                        </thead>
                        <tbody>
                          {feasibility.minileafAggregate.map((a) => (
                            <tr key={a.microgreen_id} className="border-b">
                              <td className="px-2 py-1">{a.microgreen_name}</td>
                              <td className="px-2 py-1">{a.total_oz_needed.toFixed(1)}</td>
                              <td className="px-2 py-1">{a.avg_yield_oz_per_tray.toFixed(2)}</td>
                              <td className="px-2 py-1">{a.estimated_trays}</td>
                              <td className="px-2 py-1">{a.extra_full_trays}</td>
                              <td className="px-2 py-1">{a.final_trays}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                    <Metric label="Total dried needed (g)" value={feasibility.total_dried_needed_g?.toFixed(1) ?? "—"} />
                    <Metric label="Total fresh needed (g)" value={feasibility.total_fresh_needed_g?.toFixed(1) ?? "—"} />
                    <Metric label="Production days" value={String(feasibility.production_days ?? "—")} />
                    <Metric label="Per-cycle fresh capacity (g)" value={feasibility.per_cycle_fresh_capacity?.toFixed(1) ?? "—"} />
                    <Metric label="Required cycles" value={String(feasibility.required_cycles ?? "—")} />
                    <Metric label="Max cycles available" value={String(feasibility.max_cycles_available ?? "—")} />
                    <Metric label="Feasible?" value={feasibility.feasible ? "Yes" : "No"} highlight={!feasibility.feasible} />
                  </div>
                )
              ) : (
                <p className="text-xs text-black">
                  Add production targets to compute feasibility and generate plan.
                </p>
              )}
              {planError && (
                <p className="mt-2 text-xs text-red-600" role="alert">
                  {planError}
                </p>
              )}
              {planWarning && (
                <p className="mt-2 text-xs text-amber-700" role="status">
                  {planWarning}
                </p>
              )}
            </div>

            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Resource feasibility (inventory shortages)
              </h2>
              {shortages.length ? (
                <table className="min-w-full border-collapse text-left">
                  <thead className="bg-zinc-50 text-[11px] text-black">
                    <tr>
                      <th className="px-2 py-1 font-medium">Item</th>
                      <th className="px-2 py-1 font-medium">Required</th>
                      <th className="px-2 py-1 font-medium">On hand</th>
                      <th className="px-2 py-1 font-medium">Shortage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortages.map((s) => (
                      <tr key={s.id} className="border-b text-[11px] text-black">
                        <td className="px-2 py-1">{s.name}</td>
                        <td className="px-2 py-1">
                          {s.required.toFixed(2)} {s.unit}
                        </td>
                        <td className="px-2 py-1">
                          {s.onHand.toFixed(2)} {s.unit}
                        </td>
                        <td className="px-2 py-1">
                          {s.shortage > 0
                            ? `${s.shortage.toFixed(2)} ${s.unit}`
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-black">
                  Shortages will appear once targets and BOMs are defined.
                </p>
              )}
            </div>

            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Cost, revenue, and gross profit
              </h2>
              {financials ? (
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                    <Metric
                      label="Total revenue"
                      value={financials.revenue.toFixed(2)}
                    />
                    <Metric
                      label="Material cost"
                      value={financials.material_cost.toFixed(2)}
                    />
                    {financials.variantCost != null && financials.variantCost > 0 && (
                      <Metric
                        label="Variant cost"
                        value={financials.variantCost.toFixed(2)}
                      />
                    )}
                    <Metric
                      label="Gross profit"
                      value={financials.gross_profit.toFixed(2)}
                    />
                  </div>
                  <table className="min-w-full border-collapse text-left">
                    <thead className="bg-zinc-50 text-[11px] text-black">
                      <tr>
                        <th className="px-2 py-1 font-medium">Product</th>
                        <th className="px-2 py-1 font-medium">Target units</th>
                        <th className="px-2 py-1 font-medium">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                    {financials.perProduct.map((p: any) => (
                      <tr key={p.id} className="border-b text-[11px] text-black">
                          <td className="px-2 py-1">{p.productName}</td>
                          <td className="px-2 py-1">{p.target_units}</td>
                          <td className="px-2 py-1">
                            {p.revenue.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-black">
                  Financial projections appear once targets and BOMs are
                  configured.
                </p>
              )}
            </div>

            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Tray plan lines
              </h2>
              {planLines.length ? (
                <div className="max-h-72 overflow-y-auto">
                  <table className="min-w-full border-collapse text-left">
                    <thead className="bg-zinc-50 text-[11px] text-black">
                      <tr>
                        <th className="px-2 py-1 font-medium">Microgreen</th>
                        <th className="px-2 py-1 font-medium">Source product</th>
                        <th className="px-2 py-1 font-medium">Run #</th>
                        <th className="px-2 py-1 font-medium">Trays this run</th>
                        <th className="px-2 py-1 font-medium">Fresh required (g)</th>
                        <th className="px-2 py-1 font-medium">Soak</th>
                        <th className="px-2 py-1 font-medium">Drain</th>
                        <th className="px-2 py-1 font-medium">Sow</th>
                        <th className="px-2 py-1 font-medium">Light</th>
                        <th className="px-2 py-1 font-medium">Harvest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planLines.map((p: any) => {
                        const mg = microgreens.find((m: any) => m.id === p.microgreen);
                        const product = products.find((pr: any) => pr.id === p.source_product);
                        return (
                          <tr key={p.id} className="border-b text-[11px] text-black">
                            <td className="px-2 py-1">{mg?.name ?? "-"}</td>
                            <td className="px-2 py-1">{product?.name ?? "-"}</td>
                            <td className="px-2 py-1">{p.run_number}</td>
                            <td className="px-2 py-1">{p.trays_this_run}</td>
                            <td className="px-2 py-1">{p.fresh_required_g?.toFixed(1) ?? "-"}</td>
                            <td className="px-2 py-1">{p.soak_date ? formatDate(p.soak_date) : "-"}</td>
                            <td className="px-2 py-1">{p.drain_date ? formatDate(p.drain_date) : "-"}</td>
                            <td className="px-2 py-1">{formatDate(p.sow_date)}</td>
                            <td className="px-2 py-1">{formatDate(p.light_date)}</td>
                            <td className="px-2 py-1">{formatDate(p.harvest_date)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-black">
                  Generate a plan to see tray-level runs traceable back to
                  products.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}

function Metric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-2">
      <div className="text-[11px] text-black">{label}</div>
      <div
        className={`text-sm font-semibold ${
          highlight ? "text-red-600" : "text-zinc-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

