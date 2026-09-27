"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { preloadInventoryCache } from "@/lib/finishedGoodsInventory";
import {
  OBJECTIVES,
  OBJECTIVE_LABELS,
  DEFAULT_CALIBRATION,
  resolveEffectiveSettings,
  computeDemandRates,
  computeTargetQuantities,
  buildAndSolveOptimization,
  type Objective,
  type CalibrationFields,
  type CalibrationOverrideRow,
  type ProductRow,
  type BomLineRow,
  type InventoryItemRow,
  type OrderRow,
  type OrderLineItemRow,
  type VariantMappingRow,
  type OptimizationSummary,
  type OptimizationResultRow,
} from "@/lib/botaniqalsOptimization";

// BotanIQals Optimization (BotanIQals only — MiniLeaf/microgreens are out of
// scope, no business selector on this page). Recommends how many units of
// each BotanIQals product to produce next, balancing demand history, current
// finished-goods inventory, and raw-material scarcity, under a choice of
// four objectives. Everything is fetched and computed client-side, matching
// this app's established convention (see src/lib/feasibility.ts +
// src/app/cycles/page.tsx) — no API route needed.

const SETTINGS_ID = "e0000000-0000-0000-0000-000000000001";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

type GlobalForm = {
  trailing_window_days: number | "";
  safety_stock_qty: number | "";
  min_buffer_qty: number | "";
  lead_time_days: number | "";
};

type OverrideForm = {
  trailing_window_days: string;
  safety_stock_qty: string;
  min_buffer_qty: string;
  lead_time_days: string;
};

type PreviousRun = {
  id: string;
  run_at: string;
  objective: Objective;
  results: OptimizationResultRow[];
};

function formatMoney(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function ProductionOptimizationPage() {
  const { user, supabase } = useSupabase();

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [bomLines, setBomLines] = useState<BomLineRow[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [objective, setObjective] = useState<Objective>("maximize_revenue");
  const [globalForm, setGlobalForm] = useState<GlobalForm>({
    trailing_window_days: DEFAULT_CALIBRATION.trailing_window_days,
    safety_stock_qty: DEFAULT_CALIBRATION.safety_stock_qty,
    min_buffer_qty: DEFAULT_CALIBRATION.min_buffer_qty,
    lead_time_days: DEFAULT_CALIBRATION.lead_time_days,
  });
  const [overrideForms, setOverrideForms] = useState<Record<string, OverrideForm>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [latestSummary, setLatestSummary] = useState<OptimizationSummary | null>(null);

  const [previousRuns, setPreviousRuns] = useState<PreviousRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>(""); // "" = latest live result

  const emptyOverrideForm: OverrideForm = {
    trailing_window_days: "",
    safety_stock_qty: "",
    min_buffer_qty: "",
    lead_time_days: "",
  };

  const loadAll = async () => {
    const [productsRes, bomRes, itemsRes, settingsRes, overridesRes, runsRes] = await Promise.all([
      supabase
        .from("products")
        .select("id, name, sale_price_per_unit")
        .eq("is_microgreen", false)
        .order("name", { ascending: true }),
      supabase.from("bom_lines").select("product, line_type, inventory_item, qty_per_unit"),
      supabase.from("inventory_items").select("id, name, unit, cost_per_unit, quantity_on_hand"),
      supabase
        .from("demand_calibration_settings")
        .select("trailing_window_days, safety_stock_qty, min_buffer_qty, lead_time_days, default_objective")
        .eq("id", SETTINGS_ID)
        .maybeSingle(),
      supabase.from("demand_calibration_overrides").select("*"),
      supabase
        .from("optimization_runs")
        .select("id, run_at, objective, results")
        .order("run_at", { ascending: false })
        .limit(20),
    ]);

    const errors = [
      productsRes.error?.message,
      bomRes.error?.message,
      itemsRes.error?.message,
      settingsRes.error?.message,
      overridesRes.error?.message,
      runsRes.error?.message,
    ].filter(Boolean);
    if (errors.length > 0) {
      setLoadError(errors.join(" | "));
      return;
    }

    const productRows = (productsRes.data || []) as ProductRow[];
    setProducts(productRows);
    setBomLines((bomRes.data || []) as BomLineRow[]);
    setInventoryItems((itemsRes.data || []) as InventoryItemRow[]);

    if (settingsRes.data) {
      setGlobalForm({
        trailing_window_days: Number(settingsRes.data.trailing_window_days ?? DEFAULT_CALIBRATION.trailing_window_days),
        safety_stock_qty: Number(settingsRes.data.safety_stock_qty ?? DEFAULT_CALIBRATION.safety_stock_qty),
        min_buffer_qty: Number(settingsRes.data.min_buffer_qty ?? DEFAULT_CALIBRATION.min_buffer_qty),
        lead_time_days: Number(settingsRes.data.lead_time_days ?? DEFAULT_CALIBRATION.lead_time_days),
      });
      if (settingsRes.data.default_objective) {
        setObjective(settingsRes.data.default_objective as Objective);
      }
    }

    const overridesByProductId = new Map(
      ((overridesRes.data || []) as Array<CalibrationOverrideRow>).map((o) => [o.product_id, o]),
    );
    const forms: Record<string, OverrideForm> = {};
    for (const p of productRows) {
      const o = overridesByProductId.get(p.id);
      forms[p.id] = o
        ? {
            trailing_window_days: o.trailing_window_days != null ? String(o.trailing_window_days) : "",
            safety_stock_qty: o.safety_stock_qty != null ? String(o.safety_stock_qty) : "",
            min_buffer_qty: o.min_buffer_qty != null ? String(o.min_buffer_qty) : "",
            lead_time_days: o.lead_time_days != null ? String(o.lead_time_days) : "",
          }
        : { ...emptyOverrideForm };
    }
    setOverrideForms(forms);

    setPreviousRuns((runsRes.data || []) as PreviousRun[]);
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      await loadAll();
      if (!cancelled) setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, supabase]);

  const globalSettings: CalibrationFields = useMemo(
    () => ({
      trailing_window_days: Number(globalForm.trailing_window_days || 0),
      safety_stock_qty: Number(globalForm.safety_stock_qty || 0),
      min_buffer_qty: Number(globalForm.min_buffer_qty || 0),
      lead_time_days: Number(globalForm.lead_time_days || 0),
    }),
    [globalForm],
  );

  const overridesByProductId = useMemo(() => {
    const map = new Map<string, CalibrationOverrideRow>();
    for (const [productId, form] of Object.entries(overrideForms)) {
      map.set(productId, {
        product_id: productId,
        trailing_window_days: form.trailing_window_days.trim() === "" ? null : Number(form.trailing_window_days),
        safety_stock_qty: form.safety_stock_qty.trim() === "" ? null : Number(form.safety_stock_qty),
        min_buffer_qty: form.min_buffer_qty.trim() === "" ? null : Number(form.min_buffer_qty),
        lead_time_days: form.lead_time_days.trim() === "" ? null : Number(form.lead_time_days),
      });
    }
    return map;
  }, [overrideForms]);

  const updateOverrideField = (productId: string, field: keyof OverrideForm, value: string) => {
    setOverrideForms((prev) => ({
      ...prev,
      [productId]: { ...(prev[productId] || emptyOverrideForm), [field]: value },
    }));
  };

  const handleSaveSettings = async () => {
    if (!user) return;
    setSavingSettings(true);
    setSettingsMessage(null);
    try {
      const { error: settingsError } = await supabase.from("demand_calibration_settings").upsert(
        {
          id: SETTINGS_ID,
          trailing_window_days: globalSettings.trailing_window_days,
          safety_stock_qty: globalSettings.safety_stock_qty,
          min_buffer_qty: globalSettings.min_buffer_qty,
          lead_time_days: globalSettings.lead_time_days,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (settingsError) throw settingsError;

      for (const product of products) {
        const form = overrideForms[product.id] || emptyOverrideForm;
        const allBlank =
          form.trailing_window_days.trim() === "" &&
          form.safety_stock_qty.trim() === "" &&
          form.min_buffer_qty.trim() === "" &&
          form.lead_time_days.trim() === "";

        if (allBlank) {
          const { error } = await supabase.from("demand_calibration_overrides").delete().eq("product_id", product.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("demand_calibration_overrides").upsert(
            {
              product_id: product.id,
              trailing_window_days: form.trailing_window_days.trim() === "" ? null : Number(form.trailing_window_days),
              safety_stock_qty: form.safety_stock_qty.trim() === "" ? null : Number(form.safety_stock_qty),
              min_buffer_qty: form.min_buffer_qty.trim() === "" ? null : Number(form.min_buffer_qty),
              lead_time_days: form.lead_time_days.trim() === "" ? null : Number(form.lead_time_days),
            },
            { onConflict: "product_id" },
          );
          if (error) throw error;
        }
      }

      setSettingsMessage({ type: "ok", text: "Settings saved." });
    } catch (err: any) {
      setSettingsMessage({ type: "error", text: err.message || "Failed to save settings." });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRun = async () => {
    if (!user) return;
    setRunning(true);
    setRunError(null);
    try {
      const effectiveSettingsByProduct = new Map<string, CalibrationFields>();
      for (const p of products) {
        effectiveSettingsByProduct.set(p.id, resolveEffectiveSettings(p.id, globalSettings, overridesByProductId));
      }

      const maxWindowDays = Math.max(
        globalSettings.trailing_window_days,
        ...Array.from(effectiveSettingsByProduct.values()).map((s) => s.trailing_window_days),
        1,
      );
      const now = new Date();
      const cutoffIso = new Date(now.getTime() - maxWindowDays * 24 * 60 * 60 * 1000).toISOString();

      const [ordersRes, mapRes, inventoryCache] = await Promise.all([
        supabase.from("orders").select("id, created_at").gte("created_at", cutoffIso),
        supabase.from("variant_component_map").select("lineitem_name, components"),
        preloadInventoryCache(supabase),
      ]);
      if (ordersRes.error) throw new Error(ordersRes.error.message);
      if (mapRes.error) throw new Error(mapRes.error.message);

      const orders = (ordersRes.data || []) as OrderRow[];
      const orderIds = orders.map((o) => o.id);

      // Batch order_line_items lookups so a large order history doesn't hit
      // an overly long IN() clause in one request.
      let orderLineItems: OrderLineItemRow[] = [];
      const CHUNK_SIZE = 500;
      for (let i = 0; i < orderIds.length; i += CHUNK_SIZE) {
        const chunk = orderIds.slice(i, i + CHUNK_SIZE);
        const { data, error } = await supabase
          .from("order_line_items")
          .select("order_id, lineitem_name, quantity")
          .in("order_id", chunk);
        if (error) throw new Error(error.message);
        orderLineItems = orderLineItems.concat((data || []) as OrderLineItemRow[]);
      }

      const variantComponentMap = (mapRes.data || []) as VariantMappingRow[];

      const demandRates = computeDemandRates({
        products,
        orders,
        orderLineItems,
        variantComponentMap,
        effectiveSettingsByProduct,
        now,
      });

      const onHandByProduct = new Map<string, number>();
      for (const [productId, row] of inventoryCache.entries()) {
        onHandByProduct.set(productId, row.on_hand_qty);
      }

      const targetRows = computeTargetQuantities({
        products,
        demandRates,
        onHandByProduct,
        effectiveSettingsByProduct,
      });
      const included = targetRows.filter((r) => r.targetQty > 0);

      const inventoryItemsById = new Map(inventoryItems.map((i) => [i.id, i]));
      const summary = buildAndSolveOptimization({
        rows: included,
        objective,
        products,
        bomLines,
        inventoryItemsById,
      });

      setLatestSummary(summary);
      setSelectedRunId("");

      // Always persist the chosen objective as the new default, independent
      // of the explicit "Save Settings" action (which only covers global
      // defaults / per-product overrides) — see the plan's spec note.
      await supabase
        .from("demand_calibration_settings")
        .upsert(
          { id: SETTINGS_ID, default_objective: objective, updated_at: new Date().toISOString() },
          { onConflict: "id" },
        );

      const settingsSnapshot = {
        objective,
        global: globalSettings,
        overrides: Object.fromEntries(overridesByProductId),
      };
      const { data: inserted, error: insertError } = await supabase
        .from("optimization_runs")
        .insert({
          objective,
          settings_snapshot: settingsSnapshot,
          results: summary.rows,
          created_by: user.id,
        })
        .select("id, run_at, objective, results")
        .single();
      if (!insertError && inserted) {
        setPreviousRuns((prev) => [inserted as PreviousRun, ...prev].slice(0, 20));
      }
    } catch (err: any) {
      setRunError(err.message || "Failed to run optimization.");
    } finally {
      setRunning(false);
    }
  };

  const displayedSummary: OptimizationSummary | null = useMemo(() => {
    if (selectedRunId) {
      const run = previousRuns.find((r) => r.id === selectedRunId);
      if (!run) return null;
      const rows = run.results || [];
      return {
        objective: run.objective,
        totalRecommendedUnits: rows.reduce((s, r) => s + r.recommendedQty, 0),
        totalProjectedRevenue: rows.reduce((s, r) => s + r.projectedRevenue, 0),
        totalProjectedProfit: rows.reduce((s, r) => s + r.projectedProfit, 0),
        rows,
      };
    }
    return latestSummary;
  }, [selectedRunId, previousRuns, latestSummary]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">BotanIQals Optimization</h1>
            <p className="text-sm text-black">
              Recommended production quantities based on demand history, current finished-goods
              inventory, and raw-material availability.
            </p>
          </div>
        </section>

        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        ) : (
          <>
            <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                aria-expanded={settingsOpen}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-semibold text-zinc-900">Tune Settings</span>
                <ChevronIcon open={settingsOpen} />
              </button>

              {settingsOpen && (
                <div className="space-y-5 border-t border-zinc-200 px-4 py-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-700">Objective</label>
                    <select
                      value={objective}
                      onChange={(e) => setObjective(e.target.value as Objective)}
                      className={`${inputClassName} max-w-sm`}
                    >
                      {OBJECTIVES.map((o) => (
                        <option key={o} value={o}>
                          {OBJECTIVE_LABELS[o]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Global Defaults
                    </h3>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-600">Trailing window (days)</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={globalForm.trailing_window_days}
                          onChange={(e) =>
                            setGlobalForm((prev) => ({
                              ...prev,
                              trailing_window_days: e.target.value === "" ? "" : Number(e.target.value),
                            }))
                          }
                          className={inputClassName}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-600">Safety stock (qty)</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={globalForm.safety_stock_qty}
                          onChange={(e) =>
                            setGlobalForm((prev) => ({
                              ...prev,
                              safety_stock_qty: e.target.value === "" ? "" : Number(e.target.value),
                            }))
                          }
                          className={inputClassName}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-600">Min stock buffer (qty)</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={globalForm.min_buffer_qty}
                          onChange={(e) =>
                            setGlobalForm((prev) => ({
                              ...prev,
                              min_buffer_qty: e.target.value === "" ? "" : Number(e.target.value),
                            }))
                          }
                          className={inputClassName}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-600">Lead time (days)</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={globalForm.lead_time_days}
                          onChange={(e) =>
                            setGlobalForm((prev) => ({
                              ...prev,
                              lead_time_days: e.target.value === "" ? "" : Number(e.target.value),
                            }))
                          }
                          className={inputClassName}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Per-Product Overrides
                    </h3>
                    <p className="mb-2 text-[11px] text-zinc-600">
                      Blank fields use the global default above.
                    </p>
                    {products.length === 0 ? (
                      <p className="text-xs text-zinc-600">No BotanIQals products found.</p>
                    ) : (
                      <div className="overflow-x-auto rounded border border-zinc-100">
                        <table className="min-w-full border-collapse text-left text-xs">
                          <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                            <tr>
                              <th className="px-3 py-2 font-medium">Product</th>
                              <th className="px-3 py-2 font-medium">Trailing Window</th>
                              <th className="px-3 py-2 font-medium">Safety Stock</th>
                              <th className="px-3 py-2 font-medium">Min Buffer</th>
                              <th className="px-3 py-2 font-medium">Lead Time</th>
                            </tr>
                          </thead>
                          <tbody>
                            {products.map((p) => {
                              const form = overrideForms[p.id] || emptyOverrideForm;
                              return (
                                <tr key={p.id} className="border-t border-zinc-100">
                                  <td className="px-3 py-2 font-medium text-zinc-900">{p.name}</td>
                                  {(["trailing_window_days", "safety_stock_qty", "min_buffer_qty", "lead_time_days"] as const).map(
                                    (field) => (
                                      <td key={field} className="px-3 py-1.5">
                                        <input
                                          type="number"
                                          value={form[field]}
                                          placeholder="default"
                                          onChange={(e) => updateOverrideField(p.id, field, e.target.value)}
                                          className={`${inputClassName} w-24`}
                                        />
                                      </td>
                                    ),
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSaveSettings}
                      disabled={savingSettings}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {savingSettings ? "Saving…" : "Save Settings"}
                    </button>
                    {settingsMessage && (
                      <span
                        className={`text-xs ${settingsMessage.type === "ok" ? "text-emerald-700" : "text-red-600"}`}
                      >
                        {settingsMessage.text}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleRun}
                disabled={running}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {running ? "Running…" : "Run Optimization"}
              </button>
              {runError && (
                <span className="text-xs text-red-600" role="alert">
                  {runError}
                </span>
              )}
            </section>

            {displayedSummary && (
              <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-900">
                      Objective: {OBJECTIVE_LABELS[displayedSummary.objective]}
                    </h2>
                    {selectedRunId && (
                      <p className="text-[11px] text-zinc-500">Viewing a previous run — not the latest live result.</p>
                    )}
                  </div>
                  <div className="flex gap-4 text-xs text-zinc-700">
                    <span>
                      Total units: <span className="font-semibold text-zinc-900">{Math.round(displayedSummary.totalRecommendedUnits)}</span>
                    </span>
                    <span>
                      Revenue: <span className="font-semibold text-zinc-900">{formatMoney(displayedSummary.totalProjectedRevenue)}</span>
                    </span>
                    <span>
                      Profit: <span className="font-semibold text-zinc-900">{formatMoney(displayedSummary.totalProjectedProfit)}</span>
                    </span>
                  </div>
                </div>

                {displayedSummary.rows.length === 0 ? (
                  <p className="text-xs text-zinc-600">
                    No products need production right now — every BotanIQals product&apos;s target quantity is 0.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full border-collapse text-left text-xs">
                      <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                        <tr>
                          <th className="px-3 py-2 font-medium">Product</th>
                          <th className="px-3 py-2 font-medium">Current On Hand</th>
                          <th className="px-3 py-2 font-medium">Daily Demand Rate</th>
                          <th className="px-3 py-2 font-medium">Target Qty</th>
                          <th className="px-3 py-2 font-medium">Recommended Qty</th>
                          <th className="px-3 py-2 font-medium">Fill Rate</th>
                          <th className="px-3 py-2 font-medium">Unit Cost</th>
                          <th className="px-3 py-2 font-medium">Sale Price</th>
                          <th className="px-3 py-2 font-medium">Proj. Revenue</th>
                          <th className="px-3 py-2 font-medium">Proj. Profit</th>
                          <th className="px-3 py-2 font-medium">Limiting Raw Material</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedSummary.rows
                          .slice()
                          .sort((a, b) => b.recommendedQty - a.recommendedQty)
                          .map((row) => (
                            <tr key={row.productId} className="border-b border-zinc-100">
                              <td className="px-3 py-2 font-medium text-zinc-900">{row.productName}</td>
                              <td className="px-3 py-2 text-zinc-700">{row.currentOnHandQty}</td>
                              <td className="px-3 py-2 text-zinc-700">{row.dailyDemandRate.toFixed(2)}</td>
                              <td className="px-3 py-2 text-zinc-700">{row.targetQty.toFixed(2)}</td>
                              <td className="px-3 py-2">
                                <span className="text-sm font-bold text-emerald-700">
                                  {Math.round(row.recommendedQty)}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-zinc-700">{row.fillRatePct.toFixed(1)}%</td>
                              <td className="px-3 py-2 text-zinc-700">{formatMoney(row.unitCost)}</td>
                              <td className="px-3 py-2 text-zinc-700">{formatMoney(row.salePrice)}</td>
                              <td className="px-3 py-2 text-zinc-700">{formatMoney(row.projectedRevenue)}</td>
                              <td className="px-3 py-2 text-zinc-700">{formatMoney(row.projectedProfit)}</td>
                              <td className="px-3 py-2 text-zinc-700">{row.limitingRawMaterial || "—"}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {previousRuns.length > 0 && (
              <section className="flex items-center gap-2">
                <label className="text-xs font-medium text-zinc-700">Previous Runs</label>
                <select
                  value={selectedRunId}
                  onChange={(e) => setSelectedRunId(e.target.value)}
                  className={`${inputClassName} max-w-sm`}
                >
                  <option value="">Latest run</option>
                  {previousRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {formatDate(run.run_at)} — {OBJECTIVE_LABELS[run.objective]}
                    </option>
                  ))}
                </select>
              </section>
            )}
          </>
        )}
      </div>
    </AuthGuard>
  );
}
