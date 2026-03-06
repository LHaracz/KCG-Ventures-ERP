"use client";

import { useMemo, useState, FormEvent, useEffect } from "react";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { addDays, formatDate, msPerDay, toMidnight } from "@/lib/date";
import { useSupabase } from "@/components/InstantProvider";

type TargetForm = {
  id?: string;
  productId: string;
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
  const [isLoading, setIsLoading] = useState(true);

  const [targetForm, setTargetForm] = useState<TargetForm>({
    productId: "",
    target_units: "",
  });
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
      ]);

      if (cRes.data) setCycle(cRes.data);
      setTargets(tRes.data || []);
      setProducts(pRes.data || []);
      setMicrogreens(mRes.data || []);
      setBomLines(bRes.data || []);
      setItems(iRes.data || []);
      setCalibration(calRes.data || null);
      setPlanLines(planRes.data || []);
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
    if (!targetForm.productId) {
      setTargetError("Choose a product.");
      return;
    }
    setTargetSaving(true);
    setTargetError(null);
    try {
      if (targetForm.id) {
        const { error } = await supabase
          .from("production_targets")
          .update({
            product: targetForm.productId,
            target_units: Number(targetForm.target_units || 0),
          })
          .eq("id", targetForm.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("production_targets").insert({
          production_cycle: cycleId,
          product: targetForm.productId,
          target_units: Number(targetForm.target_units || 0),
          user_id: user.id,
        });
        if (error) throw error;
      }
      const { data: refreshed } = await supabase
        .from("production_targets")
        .select("*")
        .eq("production_cycle", cycleId)
        .eq("user_id", user.id);
      setTargets(refreshed || []);
      setTargetForm({ productId: "", target_units: "" });
    } catch (err: any) {
      setTargetError(err.message || "Failed to save target.");
    } finally {
      setTargetSaving(false);
    }
  };

  const handleEditTarget = (t: any) => {
    setTargetError(null);
    setTargetForm({
      id: t.id,
      productId: t.product,
      target_units: t.target_units,
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

  const feasibility = useMemo(() => {
    if (!cycle || !calibration || !targets.length) {
      return null;
    }
    const startMidnight = toMidnight(cycle.start_date);
    const endMidnight = toMidnight(cycle.end_date);
    const production_days =
      Math.floor(
        (endMidnight.getTime() - startMidnight.getTime()) / msPerDay
      ) + 1;

    const totals = targets.reduce(
      (acc: any, t: any) => {
        const product = products.find((p: any) => p.id === t.product);
        if (!product) return acc;
        const dried =
          t.target_units * Number(product.dried_needed_g_per_unit || 0);
        const fresh =
          product.fresh_needed_g_per_unit != null
            ? t.target_units * Number(product.fresh_needed_g_per_unit)
            : dried / Number(calibration.dry_matter_fraction || 1);
        acc.total_dried_needed_g += dried;
        acc.total_fresh_needed_g += fresh;
        return acc;
      },
      { total_dried_needed_g: 0, total_fresh_needed_g: 0 }
    );

    const { total_dried_needed_g, total_fresh_needed_g } = totals;

    const hours_per_cycle =
      Number(calibration.cycle_time_hours || 0) +
      Number(calibration.defrost_cleaning_hours || 0);
    const per_cycle_fresh_capacity =
      Number(calibration.number_of_freeze_dryers || 0) *
      Number(calibration.trays_per_machine_per_cycle || 0) *
      Number(calibration.fresh_load_per_tray_g || 0);
    const total_available_hours =
      production_days * Number(calibration.operating_hours_per_day || 0);
    const max_cycles_available = Math.floor(
      total_available_hours / (hours_per_cycle || 1)
    );
    const cycles_needed =
      per_cycle_fresh_capacity > 0
        ? total_fresh_needed_g / per_cycle_fresh_capacity
        : 0;
    const required_cycles = Math.ceil(cycles_needed || 0);
    const feasible = max_cycles_available >= required_cycles;
    const total_required_hours = required_cycles * hours_per_cycle;
    const hours_short = Math.max(
      0,
      total_required_hours - total_available_hours
    );

    return {
      production_days,
      total_dried_needed_g,
      total_fresh_needed_g,
      hours_per_cycle,
      per_cycle_fresh_capacity,
      total_available_hours,
      max_cycles_available,
      cycles_needed,
      required_cycles,
      feasible,
      total_required_hours,
      hours_short,
    };
  }, [cycle, calibration, targets, products]);

  const shortages = useMemo(() => {
    if (!targets.length || !bomLines.length || !items.length) return [];
    const requiredByItem: Record<
      string,
      { item: any; required: number }
    > = {};

    for (const t of targets) {
      const product = products.find((p: any) => p.id === t.product);
      if (!product) continue;
      const lines = bomLines.filter((b: any) => b.product === product.id);
      for (const line of lines) {
        const item = items.find((i: any) => i.id === line.inventory_item);
        if (!item) continue;
        const required_qty =
          Number(t.target_units || 0) * Number(line.qty_per_unit || 0);
        if (!requiredByItem[item.id]) {
          requiredByItem[item.id] = { item, required: 0 };
        }
        requiredByItem[item.id].required += required_qty;
      }
    }

    return Object.values(requiredByItem).map(({ item, required }) => {
      const onHand = Number(item.quantity_on_hand || 0);
      const shortage = Math.max(0, required - onHand);
      return {
        id: item.id,
        name: item.name,
        unit: item.unit,
        required,
        onHand,
        shortage,
      };
    });
  }, [targets, bomLines, items, products]);

  const financials = useMemo(() => {
    if (!targets.length) return null;

    let revenue = 0;
    const requiredByItem: Record<string, number> = {};

    for (const t of targets) {
      const product = products.find((p: any) => p.id === t.product);
      if (!product) continue;
      revenue +=
        Number(t.target_units || 0) *
        Number(product.sale_price_per_unit || 0);
      const lines = bomLines.filter((b: any) => b.product === product.id);
      for (const line of lines) {
        const required_qty =
          Number(t.target_units || 0) * Number(line.qty_per_unit || 0);
        requiredByItem[line.inventory_item] =
          (requiredByItem[line.inventory_item] || 0) + required_qty;
      }
    }

    let material_cost = 0;
    for (const [inventory_item_id, required] of Object.entries(
      requiredByItem
    )) {
      const item = items.find((i: any) => i.id === inventory_item_id);
      if (!item) continue;
      material_cost += required * Number(item.cost_per_unit || 0);
    }

    const gross_profit = revenue - material_cost;

    const perProduct = targets.map((t: any) => {
      const product = products.find((p: any) => p.id === t.product);
      if (!product) return null;
      const productRevenue =
        Number(t.target_units || 0) *
        Number(product.sale_price_per_unit || 0);
      return {
        id: t.id,
        productName: product.name,
        target_units: t.target_units,
        revenue: productRevenue,
      };
    }).filter(Boolean) as any[];

    return { revenue, material_cost, gross_profit, perProduct };
  }, [targets, products, bomLines, items]);

  const handleGeneratePlan = async () => {
    if (!user || !cycle || !calibration) {
      setPlanError(
        "Calibration, cycle, and targets must exist before generating a plan."
      );
      return;
    }
    if (!targets.length) {
      setPlanError("Add at least one production target before generating.");
      return;
    }

    setPlanSaving(true);
    setPlanError(null);
    setPlanWarning(null);

    try {
      // delete existing plan lines for this cycle
      const { error: delError } = await supabase
        .from("production_plan_lines")
        .delete()
        .eq("production_cycle", cycle.id)
        .eq("user_id", user.id);
      if (delError) throw delError;

      const startMidnight = toMidnight(cycle.start_date);
      const endMidnight = toMidnight(cycle.end_date);
      const newInserts: any[] = [];
      const lateProducts: string[] = [];

      for (const t of targets) {
        const product = products.find((p: any) => p.id === t.product);
        if (!product) continue;
        const mg = microgreens.find((m: any) => m.id === product.microgreen);
        if (!mg) continue;

        const dried_for_product_g =
          Number(t.target_units || 0) *
          Number(product.dried_needed_g_per_unit || 0);
        const fresh_for_product_g =
          product.fresh_needed_g_per_unit != null
            ? Number(t.target_units || 0) *
              Number(product.fresh_needed_g_per_unit)
            : dried_for_product_g /
              Number(calibration.dry_matter_fraction || 1);

        const trays_this_run =
          Number(calibration.fresh_load_per_tray_g || 0) > 0
            ? Math.ceil(
                fresh_for_product_g /
                  Number(calibration.fresh_load_per_tray_g || 1)
              )
            : 0;

        const sowDate = startMidnight;
        const soakDate = mg.soaking_required
          ? addDays(sowDate, -1)
          : null;
        const lightDate = addDays(
          sowDate,
          Number(mg.germination_days || 0)
        );
        const harvestDate = addDays(
          sowDate,
          Number(mg.days_to_harvest || 0)
        );

        if (harvestDate.getTime() > endMidnight.getTime()) {
          lateProducts.push(product.name);
        }

        newInserts.push({
          production_cycle: cycle.id,
          microgreen: mg.id,
          source_product: product.id,
          fresh_required_g: fresh_for_product_g,
          run_number: 1,
          trays_this_run,
          soak_date: soakDate?.toISOString() ?? null,
          sow_date: sowDate.toISOString(),
          light_date: lightDate.toISOString(),
          harvest_date: harvestDate.toISOString(),
          user_id: user.id,
        });
      }

      if (newInserts.length) {
        const { error } = await supabase
          .from("production_plan_lines")
          .insert(newInserts);
        if (error) throw error;
      }

      const { data: refreshed } = await supabase
        .from("production_plan_lines")
        .select("*")
        .eq("production_cycle", cycle.id)
        .eq("user_id", user.id);
      setPlanLines(refreshed || []);

      if (lateProducts.length) {
        setPlanWarning(
          `Some harvest dates fall after the cycle end date for: ${lateProducts.join(
            ", "
          )}. The plan was saved, but review these runs.`
        );
      }
    } catch (err: any) {
      setPlanError(err.message || "Failed to generate tray plan.");
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
            <p className="text-sm text-zinc-600">
              {formatDate(cycle.start_date)} – {formatDate(cycle.end_date)} ·
              Status: {cycle.status}
            </p>
          )}
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-1">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Production targets
              </h2>
              <form onSubmit={handleTargetSubmit} className="space-y-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Product
                  </label>
                  <select
                    required
                    value={targetForm.productId}
                    onChange={(e) =>
                      setTargetForm((prev) => ({
                        ...prev,
                        productId: e.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Select…</option>
                    {products.map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Target units
                  </label>
                  <input
                    type="number"
                    required
                    value={targetForm.target_units}
                    onChange={(e) =>
                      setTargetForm((prev) => ({
                        ...prev,
                        target_units:
                          e.target.value === ""
                            ? ""
                            : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
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
                    const product = products.find(
                      (p: any) => p.id === t.product
                    );
                    return (
                      <div
                        key={t.id}
                        className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1"
                      >
                        <div className="text-[11px] text-zinc-800">
                          {product?.name ?? "Unknown"} · {t.target_units}{" "}
                          {product?.unit}
                        </div>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            className="text-[11px] text-emerald-700 underline"
                            onClick={() => handleEditTarget(t)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-[11px] text-red-600 underline"
                            onClick={() => handleDeleteTarget(t.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-[11px] text-zinc-500">
                    No production targets yet. Add targets to compute
                    feasibility and plans.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4 lg:col-span-2">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">
                  Freeze dryer feasibility
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
                <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                  <Metric
                    label="Total dried needed (g)"
                    value={feasibility.total_dried_needed_g.toFixed(1)}
                  />
                  <Metric
                    label="Total fresh needed (g)"
                    value={feasibility.total_fresh_needed_g.toFixed(1)}
                  />
                  <Metric
                    label="Production days"
                    value={String(feasibility.production_days)}
                  />
                  <Metric
                    label="Per-cycle fresh capacity (g)"
                    value={feasibility.per_cycle_fresh_capacity.toFixed(1)}
                  />
                  <Metric
                    label="Required cycles"
                    value={String(feasibility.required_cycles)}
                  />
                  <Metric
                    label="Max cycles available"
                    value={String(feasibility.max_cycles_available)}
                  />
                  <Metric
                    label="Total hours required"
                    value={feasibility.total_required_hours.toFixed(1)}
                  />
                  <Metric
                    label="Total hours available"
                    value={feasibility.total_available_hours.toFixed(1)}
                  />
                  <Metric
                    label="Hours short (if any)"
                    value={feasibility.hours_short.toFixed(1)}
                  />
                  <Metric
                    label="Feasible?"
                    value={feasibility.feasible ? "Yes" : "No"}
                    highlight={!feasibility.feasible}
                  />
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
                  Add calibration and production targets to compute feasibility.
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
                  <thead className="bg-zinc-50 text-[11px] text-zinc-600">
                    <tr>
                      <th className="px-2 py-1 font-medium">Item</th>
                      <th className="px-2 py-1 font-medium">Required</th>
                      <th className="px-2 py-1 font-medium">On hand</th>
                      <th className="px-2 py-1 font-medium">Shortage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortages.map((s) => (
                      <tr key={s.id} className="border-b text-[11px]">
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
                <p className="text-xs text-zinc-500">
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
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Metric
                      label="Total revenue"
                      value={financials.revenue.toFixed(2)}
                    />
                    <Metric
                      label="Total material cost"
                      value={financials.material_cost.toFixed(2)}
                    />
                    <Metric
                      label="Gross profit"
                      value={financials.gross_profit.toFixed(2)}
                    />
                  </div>
                  <table className="min-w-full border-collapse text-left">
                    <thead className="bg-zinc-50 text-[11px] text-zinc-600">
                      <tr>
                        <th className="px-2 py-1 font-medium">Product</th>
                        <th className="px-2 py-1 font-medium">Target units</th>
                        <th className="px-2 py-1 font-medium">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {financials.perProduct.map((p: any) => (
                        <tr key={p.id} className="border-b text-[11px]">
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
                <p className="text-xs text-zinc-500">
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
                    <thead className="bg-zinc-50 text-[11px] text-zinc-600">
                      <tr>
                        <th className="px-2 py-1 font-medium">Microgreen</th>
                        <th className="px-2 py-1 font-medium">Source product</th>
                        <th className="px-2 py-1 font-medium">Run #</th>
                        <th className="px-2 py-1 font-medium">
                          Trays this run
                        </th>
                        <th className="px-2 py-1 font-medium">
                          Fresh required (g)
                        </th>
                        <th className="px-2 py-1 font-medium">Soak</th>
                        <th className="px-2 py-1 font-medium">Sow</th>
                        <th className="px-2 py-1 font-medium">Light</th>
                        <th className="px-2 py-1 font-medium">Harvest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planLines.map((p: any) => {
                        const mg = microgreens.find(
                          (m: any) => m.id === p.microgreen
                        );
                        const product = products.find(
                          (pr: any) => pr.id === p.source_product
                        );
                        return (
                          <tr key={p.id} className="border-b text-[11px]">
                            <td className="px-2 py-1">{mg?.name ?? "-"}</td>
                            <td className="px-2 py-1">
                              {product?.name ?? "-"}
                            </td>
                            <td className="px-2 py-1">{p.run_number}</td>
                            <td className="px-2 py-1">{p.trays_this_run}</td>
                            <td className="px-2 py-1">
                              {p.fresh_required_g.toFixed(1)}
                            </td>
                            <td className="px-2 py-1">
                              {formatDate(p.soak_date)}
                            </td>
                            <td className="px-2 py-1">
                              {formatDate(p.sow_date)}
                            </td>
                            <td className="px-2 py-1">
                              {formatDate(p.light_date)}
                            </td>
                            <td className="px-2 py-1">
                              {formatDate(p.harvest_date)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
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
      <div className="text-[11px] text-zinc-600">{label}</div>
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

