"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { gramsToOz, toGrams } from "@/lib/units";
import { formatDate } from "@/lib/date";
import { optimizeMicrogreenPlan, type OptimizationMix } from "@/lib/microgreenOptimization";

type YieldForm = {
  microgreenId: string;
  harvest_date: string;
  fresh_yield_oz: number | "";
  dried_yield_oz: number | "";
  tray_identifier: string;
};

type MixForm = {
  id?: string;
  name: string;
  is_active: boolean;
};

type ComponentForm = {
  id?: string;
  mix_id: string;
  microgreen_id: string;
  percentage: number | "";
};

const DEFAULT_MIX_TEMPLATES: Array<{
  name: string;
  unitSizeOz: number;
  salePrice: number;
  components: Array<{ microgreenName: string; ratio: number }>;
}> = [
  {
    name: "Immunity Mix",
    unitSizeOz: 2,
    salePrice: 8,
    components: [
      { microgreenName: "Broccoli", ratio: 0.35 },
      { microgreenName: "Cabbage", ratio: 0.25 },
      { microgreenName: "Arugula", ratio: 0.25 },
      { microgreenName: "Sunflower", ratio: 0.15 },
    ],
  },
  {
    name: "Mental Clarity Mix",
    unitSizeOz: 2,
    salePrice: 8,
    components: [
      { microgreenName: "Basil", ratio: 0.4 },
      { microgreenName: "Pea", ratio: 0.3 },
      { microgreenName: "Cantaloupe", ratio: 0.2 },
      { microgreenName: "Popcorn", ratio: 0.1 },
    ],
  },
  {
    name: "Energy Detox",
    unitSizeOz: 2,
    salePrice: 8,
    components: [
      { microgreenName: "Sunflower", ratio: 0.45 },
      { microgreenName: "Arugula", ratio: 0.3 },
      { microgreenName: "Broccoli", ratio: 0.15 },
      { microgreenName: "Radish", ratio: 0.1 },
    ],
  },
  {
    name: "Anti-Inflammation Mix",
    unitSizeOz: 2,
    salePrice: 8,
    components: [
      { microgreenName: "Radish", ratio: 0.4 },
      { microgreenName: "Mustard", ratio: 0.2 },
      { microgreenName: "Sunflower", ratio: 0.3 },
      { microgreenName: "Amaranth", ratio: 0.1 },
    ],
  },
  {
    name: "Hormone Balancing Mix",
    unitSizeOz: 2,
    salePrice: 8,
    components: [
      { microgreenName: "Pea", ratio: 0.35 },
      { microgreenName: "Cabbage", ratio: 0.3 },
      { microgreenName: "Popcorn", ratio: 0.25 },
      { microgreenName: "Arugula", ratio: 0.1 },
    ],
  },
];

export default function MicrogreenOptimizationPage() {
  const { user, supabase } = useSupabase();
  const [microgreens, setMicrogreens] = useState<any[]>([]);
  const [mixes, setMixes] = useState<any[]>([]);
  const [components, setComponents] = useState<any[]>([]);
  const [recentEntries, setRecentEntries] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [optimizationDate, setOptimizationDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [newMixName, setNewMixName] = useState("");
  const [mixEditing, setMixEditing] = useState<MixForm | null>(null);
  const [componentEditing, setComponentEditing] = useState<ComponentForm | null>(null);
  const [savingMix, setSavingMix] = useState(false);
  const [savingComponent, setSavingComponent] = useState(false);

  const [yieldForm, setYieldForm] = useState<YieldForm>({
    microgreenId: "",
    harvest_date: new Date().toISOString().slice(0, 10),
    fresh_yield_oz: "",
    dried_yield_oz: "",
    tray_identifier: "",
  });
  const [savingYield, setSavingYield] = useState(false);
  const [yieldError, setYieldError] = useState<string | null>(null);

  const [optimizationResult, setOptimizationResult] = useState<ReturnType<
    typeof optimizeMicrogreenPlan
  > | null>(null);
  const [optimizationError, setOptimizationError] = useState<string | null>(null);
  const [maxMixSharePercent, setMaxMixSharePercent] = useState(45);
  const [maxMixSpread, setMaxMixSpread] = useState(5);
  const [loadingDefaults, setLoadingDefaults] = useState(false);

  const loadData = async () => {
    if (!user) return;
    setIsLoading(true);
    const [mgs, mixRes, compRes, yieldRes] = await Promise.all([
      supabase.from("microgreens").select("*").order("name", { ascending: true }),
      supabase.from("microgreen_mixes").select("*").order("name", { ascending: true }),
      supabase.from("microgreen_mix_components").select("*"),
      supabase
        .from("yield_entries")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    if (mgs.error || mixRes.error || compRes.error || yieldRes.error) {
      setError(
        [mgs.error?.message, mixRes.error?.message, compRes.error?.message, yieldRes.error?.message]
          .filter(Boolean)
          .join(" | "),
      );
    } else {
      setError(null);
      setMicrogreens(mgs.data || []);
      setMixes(mixRes.data || []);
      setComponents(compRes.data || []);
      setRecentEntries(yieldRes.data || []);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const componentsByMix = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const comp of components) {
      if (!map[comp.mix_id]) map[comp.mix_id] = [];
      map[comp.mix_id].push(comp);
    }
    return map;
  }, [components]);

  const microgreenNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const mg of microgreens) map[mg.id] = mg.name;
    return map;
  }, [microgreens]);

  const availableOzByMicrogreen = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const entry of recentEntries) {
      const dateKey = new Date(entry.harvest_date).toISOString().slice(0, 10);
      if (dateKey !== optimizationDate) continue;
      const mgId = entry.microgreen as string;
      totals[mgId] = (totals[mgId] || 0) + gramsToOz(Number(entry.fresh_yield_g || 0));
    }
    return totals;
  }, [recentEntries, optimizationDate]);

  const activeMixValidation = useMemo(() => {
    const errors: string[] = [];
    for (const mix of mixes.filter((m: any) => m.is_active !== false)) {
      const mixComponents = componentsByMix[mix.id] || [];
      if (!mixComponents.length) {
        errors.push(`${mix.name}: add at least one component.`);
        continue;
      }
      const ratioSum = mixComponents.reduce(
        (sum, component) => sum + Number(component.ratio || 0),
        0,
      );
      const unique = new Set(mixComponents.map((component) => component.microgreen_id));
      if (unique.size !== mixComponents.length) {
        errors.push(`${mix.name}: duplicate microgreens in components.`);
      }
      if (Math.abs(ratioSum - 1) > 0.001) {
        errors.push(`${mix.name}: component ratios must sum to 1.0.`);
      }
    }
    return errors;
  }, [mixes, componentsByMix]);

  const handleSaveMix = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !mixEditing) return;
    setSavingMix(true);
    setError(null);
    try {
      const payload = {
        name: mixEditing.name.trim(),
        unit_size_oz: 2,
        sale_price: 8,
        is_active: mixEditing.is_active,
        updated_at: new Date().toISOString(),
      };
      if (mixEditing.id) {
        const { error: updateError } = await supabase
          .from("microgreen_mixes")
          .update(payload)
          .eq("id", mixEditing.id)
          .eq("user_id", user.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase.from("microgreen_mixes").insert({
          ...payload,
          user_id: user.id,
        });
        if (insertError) throw insertError;
      }
      await loadData();
      setMixEditing(null);
    } catch (err: any) {
      setError(err.message || "Failed to save mix.");
    } finally {
      setSavingMix(false);
    }
  };

  const handleQuickCreateMix = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !newMixName.trim()) return;
    setSavingMix(true);
    setError(null);
    try {
      const { error: insertError } = await supabase.from("microgreen_mixes").insert({
        user_id: user.id,
        name: newMixName.trim(),
        unit_size_oz: 2,
        sale_price: 8,
        is_active: true,
      });
      if (insertError) throw insertError;
      setNewMixName("");
      await loadData();
    } catch (err: any) {
      setError(err.message || "Failed to create mix.");
    } finally {
      setSavingMix(false);
    }
  };

  const handleDeleteMix = async (mixId: string) => {
    try {
      const { error: deleteError } = await supabase
        .from("microgreen_mixes")
        .delete()
        .eq("id", mixId)
        .eq("user_id", user?.id || "");
      if (deleteError) throw deleteError;
      await loadData();
    } catch (err: any) {
      setError(err.message || "Failed to delete mix.");
    }
  };

  const handleSaveComponent = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !componentEditing) return;
    setSavingComponent(true);
    setError(null);
    try {
      const payload = {
        mix_id: componentEditing.mix_id,
        microgreen_id: componentEditing.microgreen_id,
        ratio: Number(componentEditing.percentage || 0) / 100,
        updated_at: new Date().toISOString(),
      };
      if (payload.ratio <= 0 || payload.ratio > 1) {
        throw new Error("Percentage must be greater than 0 and at most 100.");
      }
      if (componentEditing.id) {
        const { error: updateError } = await supabase
          .from("microgreen_mix_components")
          .update(payload)
          .eq("id", componentEditing.id)
          .eq("user_id", user.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase.from("microgreen_mix_components").insert({
          ...payload,
          user_id: user.id,
        });
        if (insertError) throw insertError;
      }
      await loadData();
      setComponentEditing(null);
    } catch (err: any) {
      setError(err.message || "Failed to save mix component.");
    } finally {
      setSavingComponent(false);
    }
  };

  const handleDeleteComponent = async (componentId: string) => {
    try {
      const { error: deleteError } = await supabase
        .from("microgreen_mix_components")
        .delete()
        .eq("id", componentId)
        .eq("user_id", user?.id || "");
      if (deleteError) throw deleteError;
      await loadData();
    } catch (err: any) {
      setError(err.message || "Failed to delete component.");
    }
  };

  const handleYieldSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !yieldForm.microgreenId) {
      setYieldError("Please select a microgreen.");
      return;
    }
    setSavingYield(true);
    setYieldError(null);
    try {
      const freshInGrams = toGrams(Number(yieldForm.fresh_yield_oz || 0), "oz");
      const driedInGrams =
        yieldForm.dried_yield_oz === ""
          ? null
          : toGrams(Number(yieldForm.dried_yield_oz), "oz");

      const { error: insertError } = await supabase.from("yield_entries").insert({
        microgreen: yieldForm.microgreenId,
        harvest_date: new Date(yieldForm.harvest_date).toISOString(),
        fresh_yield_g: freshInGrams,
        dried_yield_g: driedInGrams,
        tray_identifier: yieldForm.tray_identifier || null,
        user_id: user.id,
      });
      if (insertError) throw insertError;
      await loadData();
      setYieldForm((prev) => ({
        ...prev,
        harvest_date: new Date().toISOString().slice(0, 10),
        fresh_yield_oz: "",
        dried_yield_oz: "",
        tray_identifier: "",
      }));
    } catch (err: any) {
      setYieldError(err.message || "Failed to save yield entry.");
    } finally {
      setSavingYield(false);
    }
  };

  const handleLoadDefaults = async () => {
    if (!user) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "Load MiniLeaf default mixes? This will overwrite components for any existing mixes with matching names.",
      );
      if (!confirmed) return;
    }
    setLoadingDefaults(true);
    setError(null);
    try {
      const microgreenByName = new Map(
        microgreens.map((mg: any) => [String(mg.name).trim().toLowerCase(), mg.id as string]),
      );

      const missingMicrogreens = new Set<string>();
      for (const template of DEFAULT_MIX_TEMPLATES) {
        for (const component of template.components) {
          if (!microgreenByName.has(component.microgreenName.trim().toLowerCase())) {
            missingMicrogreens.add(component.microgreenName);
          }
        }
      }
      if (missingMicrogreens.size > 0) {
        throw new Error(
          `Cannot load defaults. Missing microgreens: ${Array.from(missingMicrogreens).join(", ")}.`,
        );
      }

      for (const template of DEFAULT_MIX_TEMPLATES) {
        const { data: existingMix, error: existingMixError } = await supabase
          .from("microgreen_mixes")
          .select("id")
          .eq("user_id", user.id)
          .eq("name", template.name)
          .maybeSingle();
        if (existingMixError) throw existingMixError;

        let mixId = existingMix?.id as string | undefined;
        if (!mixId) {
          const { data: insertedMix, error: insertMixError } = await supabase
            .from("microgreen_mixes")
            .insert({
              user_id: user.id,
              name: template.name,
              unit_size_oz: template.unitSizeOz,
              sale_price: template.salePrice,
              is_active: true,
            })
            .select("id")
            .maybeSingle();
          if (insertMixError) throw insertMixError;
          mixId = insertedMix?.id;
        } else {
          const { error: updateMixError } = await supabase
            .from("microgreen_mixes")
            .update({
              unit_size_oz: template.unitSizeOz,
              sale_price: template.salePrice,
              is_active: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", mixId)
            .eq("user_id", user.id);
          if (updateMixError) throw updateMixError;
        }

        const { error: deleteComponentsError } = await supabase
          .from("microgreen_mix_components")
          .delete()
          .eq("mix_id", mixId)
          .eq("user_id", user.id);
        if (deleteComponentsError) throw deleteComponentsError;

        const payload = template.components.map((component) => ({
          user_id: user.id,
          mix_id: mixId,
          microgreen_id: microgreenByName.get(component.microgreenName.trim().toLowerCase()),
          ratio: component.ratio,
        }));
        const { error: insertComponentsError } = await supabase
          .from("microgreen_mix_components")
          .insert(payload);
        if (insertComponentsError) throw insertComponentsError;
      }

      await loadData();
    } catch (err: any) {
      setError(err.message || "Failed to load default mixes.");
    } finally {
      setLoadingDefaults(false);
    }
  };

  const handleRunOptimization = () => {
    if (activeMixValidation.length > 0) {
      setOptimizationError(activeMixValidation.join(" | "));
      setOptimizationResult(null);
      return;
    }
    const hasSupply = Object.values(availableOzByMicrogreen).some((oz) => oz > 0);
    if (!hasSupply) {
      setOptimizationError(
        "No harvest supply found for selected date. Log yields in this tab first.",
      );
      setOptimizationResult(null);
      return;
    }

    const normalizedMixShare = Math.min(100, Math.max(0, Number(maxMixSharePercent) || 0)) / 100;
    const normalizedMixSpread = Math.max(0, Math.floor(Number(maxMixSpread) || 0));

    const modelMixes: OptimizationMix[] = mixes.map((mix: any) => ({
      id: mix.id,
      name: mix.name,
      unitSizeOz: Number(mix.unit_size_oz || 2),
      salePrice: Number(mix.sale_price || 8),
      isActive: mix.is_active !== false,
      components: (componentsByMix[mix.id] || []).map((component: any) => ({
        microgreenId: component.microgreen_id,
        ratio: Number(component.ratio || 0),
      })),
    }));

    const result = optimizeMicrogreenPlan({
      availableOzByMicrogreen,
      microgreenNames: microgreenNameById,
      mixes: modelMixes,
      singleUnitSizeOz: 2,
      singleSalePrice: 6,
      maxMixShare: normalizedMixShare,
      maxMixSpread: normalizedMixSpread,
    });
    if (result.infeasibleReason) {
      setOptimizationError(result.infeasibleReason);
      setOptimizationResult(null);
      return;
    }
    setOptimizationError(null);
    setOptimizationResult(result);
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Microgreen Optimization
          </h1>
          <p className="text-sm text-black">
            Configure mix recipes, log harvest yields, and generate a profit-first
            recommendation for 2oz containers.
          </p>
        </header>

        {error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}

        <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900">Mix management</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-70"
                onClick={handleLoadDefaults}
                disabled={loadingDefaults}
              >
                {loadingDefaults ? "Loading defaults…" : "Load MiniLeaf defaults"}
              </button>
            </div>
          </div>
          <form
            onSubmit={handleQuickCreateMix}
            className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-zinc-50 p-3"
          >
            <label className="text-[11px] font-medium text-zinc-800">
              Mix name (fixed 2oz):
            </label>
            <input
              required
              value={newMixName}
              onChange={(e) => setNewMixName(e.target.value)}
              placeholder="Type mix name and press Enter"
              className="min-w-64 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-black placeholder:text-gray-400"
            />
            <button
              type="submit"
              disabled={savingMix}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-70"
            >
              {savingMix ? "Adding…" : "Add mix"}
            </button>
          </form>
          {isLoading ? (
            <p className="text-xs text-black">Loading mix data…</p>
          ) : (
            <div className="space-y-3">
              {mixes.length === 0 && (
                <p className="text-xs text-black">
                  No mixes yet. Add a mix, then add component microgreens with ratios
                  that sum to 1.0.
                </p>
              )}
              {mixes.map((mix: any) => {
                const mixComponents = componentsByMix[mix.id] || [];
                const ratioTotal = mixComponents.reduce(
                  (sum, component) => sum + Number(component.ratio || 0),
                  0,
                );
                return (
                  <div key={mix.id} className="rounded border border-zinc-200 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div>
                        <div className="font-medium text-zinc-900">{mix.name}</div>
                        <div className="text-[11px] text-black">
                          {mix.unit_size_oz} oz fixed · ${Number(mix.sale_price || 0).toFixed(2)} ·{" "}
                          {mix.is_active !== false ? "Active" : "Inactive"} · Total:{" "}
                          {(ratioTotal * 100).toFixed(1)}%
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="text-xs text-emerald-700 underline"
                          onClick={() =>
                            setMixEditing({
                              id: mix.id,
                              name: mix.name,
                              is_active: mix.is_active !== false,
                            })
                          }
                        >
                          Edit mix
                        </button>
                        <button
                          type="button"
                          className="text-xs text-red-600 underline"
                          onClick={() => handleDeleteMix(mix.id)}
                        >
                          Delete mix
                        </button>
                        <button
                          type="button"
                          className="text-xs text-blue-700 underline"
                          onClick={() =>
                            setComponentEditing({
                              mix_id: mix.id,
                              microgreen_id: "",
                              percentage: "",
                            })
                          }
                        >
                          Add component
                        </button>
                      </div>
                    </div>
                    {mixComponents.length > 0 && (
                      <>
                        <table className="min-w-full border-collapse text-left text-[11px]">
                          <thead className="bg-zinc-50 text-black">
                            <tr>
                              <th className="px-2 py-1 font-medium">Microgreen</th>
                              <th className="px-2 py-1 font-medium">Percentage</th>
                              <th className="px-2 py-1 font-medium">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {mixComponents.map((component: any) => (
                              <tr key={component.id} className="border-b text-black">
                                <td className="px-2 py-1">
                                  {microgreenNameById[component.microgreen_id] ?? "Unknown"}
                                </td>
                                <td className="px-2 py-1">
                                  {(Number(component.ratio) * 100).toFixed(1)}%
                                </td>
                                <td className="px-2 py-1">
                                  <button
                                    type="button"
                                    className="mr-2 text-emerald-700 underline"
                                    onClick={() =>
                                      setComponentEditing({
                                        id: component.id,
                                        mix_id: component.mix_id,
                                        microgreen_id: component.microgreen_id,
                                        percentage: Number(component.ratio) * 100,
                                      })
                                    }
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="text-red-600 underline"
                                    onClick={() => handleDeleteComponent(component.id)}
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="mt-2 text-[11px] text-zinc-700">
                          2oz breakdown:{" "}
                          {mixComponents
                            .map((component: any) => {
                              const percentage = Number(component.ratio) * 100;
                              const ounces = 2 * Number(component.ratio);
                              const mgName =
                                microgreenNameById[component.microgreen_id] ?? "Unknown";
                              return `${mgName} ${percentage.toFixed(1)}% = ${ounces.toFixed(2)} oz`;
                            })
                            .join(" | ")}
                        </p>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {mixEditing && (
            <form onSubmit={handleSaveMix} className="mt-3 grid gap-2 rounded-md bg-zinc-50 p-3 sm:grid-cols-3">
              <input
                required
                placeholder="Mix name"
                value={mixEditing.name}
                onChange={(e) => setMixEditing({ ...mixEditing, name: e.target.value })}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-black placeholder:text-gray-400"
              />
              <select
                value={mixEditing.is_active ? "active" : "inactive"}
                onChange={(e) =>
                  setMixEditing({ ...mixEditing, is_active: e.target.value === "active" })
                }
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-black"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={savingMix}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-700 disabled:opacity-70"
                >
                  {savingMix ? "Saving…" : "Save mix"}
                </button>
                <button
                  type="button"
                  className="text-black underline"
                  onClick={() => setMixEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {componentEditing && (
            <form
              onSubmit={handleSaveComponent}
              className="mt-3 grid gap-2 rounded-md bg-zinc-50 p-3 sm:grid-cols-4"
            >
              <select
                required
                value={componentEditing.mix_id}
                onChange={(e) =>
                  setComponentEditing({ ...componentEditing, mix_id: e.target.value })
                }
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-black"
              >
                <option value="">Select mix…</option>
                {mixes.map((mix: any) => (
                  <option key={mix.id} value={mix.id}>
                    {mix.name}
                  </option>
                ))}
              </select>
              <select
                required
                value={componentEditing.microgreen_id}
                onChange={(e) =>
                  setComponentEditing({
                    ...componentEditing,
                    microgreen_id: e.target.value,
                  })
                }
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-black"
              >
                <option value="">Select microgreen…</option>
                {microgreens.map((mg: any) => (
                  <option key={mg.id} value={mg.id}>
                    {mg.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                required
                value={componentEditing.percentage}
                onChange={(e) =>
                  setComponentEditing({
                    ...componentEditing,
                    percentage: e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
                placeholder="Percentage (0-100)"
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-black placeholder:text-gray-400"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={savingComponent}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-700 disabled:opacity-70"
                >
                  {savingComponent ? "Saving…" : "Save component"}
                </button>
                <button
                  type="button"
                  className="text-black underline"
                  onClick={() => setComponentEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">Harvest yield input</h2>
            <p className="mb-2 text-[11px] text-black">
              Entries saved here go into the same `yield_entries` table used by Yield
              Logging.
            </p>
            <form onSubmit={handleYieldSubmit} className="space-y-2">
              <div>
                <label className="mb-1 block font-medium text-zinc-800">Microgreen</label>
                <select
                  value={yieldForm.microgreenId}
                  onChange={(e) =>
                    setYieldForm((prev) => ({ ...prev, microgreenId: e.target.value }))
                  }
                  className="w-full rounded-md border border-zinc-300 px-2 py-1.5"
                >
                  <option value="">Select…</option>
                  {microgreens.map((mg: any) => (
                    <option key={mg.id} value={mg.id}>
                      {mg.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Harvest date</label>
                  <input
                    type="date"
                    value={yieldForm.harvest_date}
                    onChange={(e) =>
                      setYieldForm((prev) => ({ ...prev, harvest_date: e.target.value }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Tray identifier</label>
                  <input
                    type="text"
                    value={yieldForm.tray_identifier}
                    onChange={(e) =>
                      setYieldForm((prev) => ({ ...prev, tray_identifier: e.target.value }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  />
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Fresh yield (oz)</label>
                  <input
                    type="number"
                    value={yieldForm.fresh_yield_oz}
                    onChange={(e) =>
                      setYieldForm((prev) => ({
                        ...prev,
                        fresh_yield_oz: e.target.value === "" ? "" : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Dried yield (oz, optional)
                  </label>
                  <input
                    type="number"
                    value={yieldForm.dried_yield_oz}
                    onChange={(e) =>
                      setYieldForm((prev) => ({
                        ...prev,
                        dried_yield_oz: e.target.value === "" ? "" : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  />
                </div>
              </div>
              {yieldError && <p className="text-xs text-red-600">{yieldError}</p>}
              <button
                type="submit"
                disabled={savingYield}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-70"
              >
                {savingYield ? "Saving…" : "Save yield entry"}
              </button>
            </form>
          </div>

          <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">
              Recent yield entries
            </h2>
            {recentEntries.length ? (
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {recentEntries.slice(0, 25).map((entry: any) => (
                  <div
                    key={entry.id}
                    className="rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                  >
                    <div className="font-medium text-zinc-900">
                      {microgreenNameById[entry.microgreen] ?? "Unknown"}
                    </div>
                    <div className="text-[11px] text-black">
                      {formatDate(entry.harvest_date)} · Fresh:{" "}
                      {gramsToOz(Number(entry.fresh_yield_g || 0)).toFixed(2)} oz
                      {entry.tray_identifier ? ` · Tray: ${entry.tray_identifier}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-black">No yield entries yet.</p>
            )}
          </div>
        </section>

        <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-900">Optimization output</h2>
            <label className="ml-auto flex items-center gap-2 text-xs">
              Harvest date
              <input
                type="date"
                value={optimizationDate}
                onChange={(e) => setOptimizationDate(e.target.value)}
                className="rounded-md border border-zinc-300 px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              Max mix share (%)
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={maxMixSharePercent}
                onChange={(e) => setMaxMixSharePercent(Number(e.target.value || 0))}
                className="w-20 rounded-md border border-zinc-300 px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              Max mix spread
              <input
                type="number"
                min={0}
                step={1}
                value={maxMixSpread}
                onChange={(e) => setMaxMixSpread(Number(e.target.value || 0))}
                className="w-20 rounded-md border border-zinc-300 px-2 py-1"
              />
            </label>
            <button
              type="button"
              onClick={handleRunOptimization}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
            >
              Run optimization
            </button>
          </div>

          {activeMixValidation.length > 0 && (
            <p className="mb-2 text-xs text-amber-700">
              Fix mix validation issues before optimization:{" "}
              {activeMixValidation.join(" | ")}
            </p>
          )}
          {optimizationError && (
            <p className="mb-2 text-xs text-red-600">{optimizationError}</p>
          )}
          <p className="mb-2 text-[11px] text-zinc-600">
            Constraint rules: mix containers are capped at {Math.max(0, Math.min(100, maxMixSharePercent))}% of
            total containers, and all feasible active mixes are produced with counts kept within{" "}
            {Math.max(0, Math.floor(maxMixSpread))} containers of each other.
          </p>

          <div className="mb-3 grid gap-2 sm:grid-cols-2 md:grid-cols-4">
            {Object.entries(availableOzByMicrogreen)
              .sort((a, b) => (microgreenNameById[a[0]] || "").localeCompare(microgreenNameById[b[0]] || ""))
              .map(([microgreenId, oz]) => (
                <div key={microgreenId} className="rounded border border-zinc-200 bg-zinc-50 p-2">
                  <div className="text-[11px] text-black">
                    {microgreenNameById[microgreenId] ?? "Unknown"}
                  </div>
                  <div className="text-sm font-semibold text-zinc-900">{oz.toFixed(2)} oz</div>
                </div>
              ))}
          </div>

          {optimizationResult ? (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                <Metric label="Projected revenue" value={`$${optimizationResult.totals.profit.toFixed(2)}`} />
                <Metric label="Total containers" value={`${optimizationResult.totals.containers}`} />
                <Metric label="Mix containers" value={`${optimizationResult.totals.mixContainers}`} />
                <Metric label="Single containers" value={`${optimizationResult.totals.singleContainers}`} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-zinc-900">
                    Mix recommendation (2oz at $8)
                  </h3>
                  {optimizationResult.mixes.length ? (
                    <table className="min-w-full border-collapse text-left text-[11px]">
                      <thead className="bg-zinc-50 text-black">
                        <tr>
                          <th className="px-2 py-1 font-medium">Mix</th>
                          <th className="px-2 py-1 font-medium">Containers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {optimizationResult.mixes.map((row) => (
                          <tr key={row.mixId} className="border-b text-black">
                            <td className="px-2 py-1">{row.mixName}</td>
                            <td className="px-2 py-1">{row.containers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-[11px] text-black">No mix containers recommended.</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-zinc-900">
                    Single recommendation (2oz at $6)
                  </h3>
                  {optimizationResult.singles.length ? (
                    <table className="min-w-full border-collapse text-left text-[11px]">
                      <thead className="bg-zinc-50 text-black">
                        <tr>
                          <th className="px-2 py-1 font-medium">Microgreen</th>
                          <th className="px-2 py-1 font-medium">Containers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {optimizationResult.singles.map((row) => (
                          <tr key={row.microgreenId} className="border-b text-black">
                            <td className="px-2 py-1">{row.microgreenName}</td>
                            <td className="px-2 py-1">{row.containers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-[11px] text-black">
                      No single containers recommended.
                    </p>
                  )}
                </div>
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold text-zinc-900">Leftover inventory (oz)</h3>
                <table className="min-w-full border-collapse text-left text-[11px]">
                  <thead className="bg-zinc-50 text-black">
                    <tr>
                      <th className="px-2 py-1 font-medium">Microgreen</th>
                      <th className="px-2 py-1 font-medium">Leftover oz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optimizationResult.leftoversOz.map((row) => (
                      <tr key={row.microgreenId} className="border-b text-black">
                        <td className="px-2 py-1">{row.microgreenName}</td>
                        <td className="px-2 py-1">{row.leftoverOz.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-xs text-black">
              Run optimization to generate a production recommendation.
            </p>
          )}
        </section>
      </div>
    </AuthGuard>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-2">
      <div className="text-[11px] text-black">{label}</div>
      <div className="text-sm font-semibold text-zinc-900">{value}</div>
    </div>
  );
}
