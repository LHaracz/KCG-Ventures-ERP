"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate } from "@/lib/date";
import { useSupabase } from "@/components/InstantProvider";
import { gramsToOz, toGrams } from "@/lib/units";

type YieldForm = {
  microgreenId: string;
  harvest_date: string;
  fresh_yield_oz: number | "";
  dried_yield_oz: number | "";
  tray_identifier: string;
};

export default function YieldPage() {
  const { user, supabase } = useSupabase();
  const [microgreens, setMicrogreens] = useState<any[]>([]);
  const [recentEntries, setRecentEntries] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [mode, setMode] = useState<"existing" | "quick">("existing");
  const [quickName, setQuickName] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);

  const [form, setForm] = useState<YieldForm>({
    microgreenId: "",
    harvest_date: new Date().toISOString().slice(0, 10),
    fresh_yield_oz: "",
    dried_yield_oz: "",
    tray_identifier: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const [m, y] = await Promise.all([
        supabase
          .from("microgreens")
          .select("*")
          .order("name", { ascending: true }),
        supabase
          .from("yield_entries")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
      setMicrogreens(m.data || []);
      setRecentEntries(y.data || []);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const handleQuickCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !quickName.trim()) return;
    setQuickSaving(true);
    setQuickError(null);
    try {
      const existing = microgreens;
      const duplicate = existing.find(
        (m: any) =>
          m.name.trim().toLowerCase() === quickName.trim().toLowerCase()
      );
      if (duplicate) {
        setQuickError(
          "A microgreen with this name already exists for your account."
        );
        setQuickSaving(false);
        return;
      }
      const { data, error } = await supabase
        .from("microgreens")
        .insert({
          name: quickName.trim(),
          soaking_required: false,
          germination_days: 3,
          days_to_harvest: 10,
          sow_rate_g_per_tray: 100,
          notes: null,
          default_soak_offset_days: null,
          light_offset_days: null,
          harvest_offset_days: null,
          user_id: user.id,
        })
        .select("*");
      if (error) throw error;
      const created = data?.[0];
      if (created) {
        setMicrogreens((prev) => [...prev, created]);
        setForm((prev) => ({ ...prev, microgreenId: created.id }));
      }
      setMode("existing");
      setQuickName("");
    } catch (err: any) {
      setQuickError(err.message || "Failed to create microgreen.");
    } finally {
      setQuickSaving(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !form.microgreenId) {
      setError("Please select a microgreen.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const freshInGrams = toGrams(Number(form.fresh_yield_oz || 0), "oz");
      const driedInGrams =
        form.dried_yield_oz === ""
          ? null
          : toGrams(Number(form.dried_yield_oz), "oz");

      const { error } = await supabase.from("yield_entries").insert({
        microgreen: form.microgreenId,
        harvest_date: new Date(form.harvest_date).toISOString(),
        fresh_yield_g: freshInGrams,
        dried_yield_g: driedInGrams,
        tray_identifier: form.tray_identifier || null,
        user_id: user.id,
      });
      if (error) throw error;
      const { data: refreshed } = await supabase
        .from("yield_entries")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      setRecentEntries(refreshed || []);
      setForm({
        microgreenId: form.microgreenId,
        harvest_date: new Date().toISOString().slice(0, 10),
        fresh_yield_oz: "",
        dried_yield_oz: "",
        tray_identifier: "",
      });
    } catch (err: any) {
      setError(err.message || "Failed to save yield entry.");
    } finally {
      setSaving(false);
    }
  };

  const averagesByMicrogreen = useMemo(() => {
    const map: Record<
      string,
      {
        name: string;
        freshTotal: number;
        freshCount: number;
        driedTotal: number;
        driedCount: number;
      }
    > = {};
    for (const entry of recentEntries) {
      const mgId = entry.microgreen as string;
      const mg = microgreens.find((m: any) => m.id === mgId);
      const name = mg?.name ?? "Unknown";
      if (!map[mgId]) {
        map[mgId] = {
          name,
          freshTotal: 0,
          freshCount: 0,
          driedTotal: 0,
          driedCount: 0,
        };
      }
      map[mgId].freshTotal += entry.fresh_yield_g;
      map[mgId].freshCount += 1;
      if (entry.dried_yield_g != null) {
        map[mgId].driedTotal += entry.dried_yield_g;
        map[mgId].driedCount += 1;
      }
    }
    return Object.entries(map).map(([id, v]) => ({
      id,
      name: v.name,
      avgFresh: v.freshCount ? gramsToOz(v.freshTotal / v.freshCount) : 0,
      avgDried: v.driedCount ? gramsToOz(v.driedTotal / v.driedCount) : 0,
    }));
  }, [recentEntries, microgreens]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Yield Logging
          </h1>
          <p className="text-sm text-black">
            Log tray yields and monitor rolling averages by microgreen.
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">
              Log new yield
            </h2>

            <div className="mb-3 flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setMode("existing")}
                className={`rounded-md px-2 py-1 ${
                  mode === "existing"
                    ? "bg-emerald-600 text-white"
                    : "bg-zinc-100 text-zinc-700"
                }`}
              >
                Choose existing microgreen
              </button>
              <button
                type="button"
                onClick={() => setMode("quick")}
                className={`rounded-md px-2 py-1 ${
                  mode === "quick"
                    ? "bg-emerald-600 text-white"
                    : "bg-zinc-100 text-zinc-700"
                }`}
              >
                Quick-create microgreen
              </button>
            </div>

            {mode === "existing" && (
              <div className="mb-3">
                <label className="mb-1 block font-medium text-zinc-800">
                  Microgreen
                </label>
                <select
                  value={form.microgreenId}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      microgreenId: e.target.value,
                    }))
                  }
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                >
                  <option value="">Select…</option>
                  {microgreens.map((m: any) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {mode === "quick" && (
              <form
                onSubmit={handleQuickCreate}
                className="mb-3 space-y-2 rounded-md bg-zinc-50 p-2"
              >
                <label className="mb-1 block text-xs font-medium text-zinc-800">
                  New microgreen name
                </label>
                <input
                  type="text"
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                />
                {quickError && (
                  <p className="text-xs text-red-600" role="alert">
                    {quickError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={quickSaving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {quickSaving ? "Creating…" : "Create & select"}
                </button>
              </form>
            )}

            <form onSubmit={handleSubmit} className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Harvest date
                  </label>
                  <input
                    type="date"
                    value={form.harvest_date}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        harvest_date: e.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Tray identifier (optional)
                  </label>
                  <input
                    type="text"
                    value={form.tray_identifier}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        tray_identifier: e.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Fresh yield (oz)
                  </label>
                  <input
                    type="number"
                    value={form.fresh_yield_oz}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        fresh_yield_oz:
                          e.target.value === ""
                            ? ""
                            : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Dried yield (oz, optional)
                  </label>
                  <input
                    type="number"
                    value={form.dried_yield_oz}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        dried_yield_oz:
                          e.target.value === ""
                            ? ""
                            : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
              </div>
              {error && (
                <p className="text-xs text-red-600" role="alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={saving}
                className="mt-2 rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {saving ? "Saving…" : "Save yield entry"}
              </button>
            </form>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Recent entries
              </h2>
              {isLoading ? (
                <p className="text-xs text-black">Loading entries…</p>
              ) : recentEntries.length ? (
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {recentEntries.slice(0, 20).map((e: any) => {
                    const mg = microgreens.find((m: any) => m.id === e.microgreen);
                    return (
                      <div
                        key={e.id}
                        className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                      >
                        <div>
                          <div className="text-xs font-medium text-zinc-900">
                            {mg?.name ?? "Unknown"}
                          </div>
                          <div className="text-[11px] text-black">
                            {formatDate(e.harvest_date)} · Fresh:{" "}
                            {gramsToOz(e.fresh_yield_g).toFixed(1)} oz
                            {e.dried_yield_g != null &&
                              ` · Dried: ${gramsToOz(
                                e.dried_yield_g
                              ).toFixed(1)} oz`}
                            {e.tray_identifier &&
                              ` · Tray: ${e.tray_identifier}`}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-black">
                  No yield entries yet. Start by logging your first tray.
                </p>
              )}
            </div>

            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Rolling averages per microgreen
              </h2>
              {averagesByMicrogreen.length ? (
                <table className="min-w-full border-collapse text-left">
                  <thead className="bg-zinc-50 text-[11px] text-black">
                    <tr>
                      <th className="px-2 py-1 font-medium">Microgreen</th>
                      <th className="px-2 py-1 font-medium">
                        Avg fresh / tray (oz)
                      </th>
                      <th className="px-2 py-1 font-medium">
                        Avg dried / tray (oz)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {averagesByMicrogreen.map((row) => (
                      <tr key={row.id} className="border-b text-[11px] text-black">
                        <td className="px-2 py-1">{row.name}</td>
                        <td className="px-2 py-1">
                          {row.avgFresh.toFixed(1)}
                        </td>
                        <td className="px-2 py-1">
                          {row.avgDried ? row.avgDried.toFixed(1) : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-black">
                  Averages will appear once you have yield entries.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}

