"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate } from "@/lib/date";
import { useSupabase } from "@/components/InstantProvider";

type BusinessType = "MiniLeaf" | "BotanIQals";

type CycleForm = {
  business_type: BusinessType;
  harvest_date: string;
  start_date: string;
  end_date: string;
  status: "draft" | "planned" | "completed";
};

export default function CyclesPage() {
  const { user, supabase } = useSupabase();
  const [cycles, setCycles] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<CycleForm>({
    business_type: "MiniLeaf",
    harvest_date: today,
    start_date: today,
    end_date: today,
    status: "draft",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const [c, t] = await Promise.all([
        supabase
          .from("production_cycles")
          .select("*")
          .eq("user_id", user.id)
          .order("start_date", { ascending: false }),
        supabase
          .from("production_targets")
          .select("*")
          .eq("user_id", user.id),
      ]);
      setCycles(c.data || []);
      setTargets(t.data || []);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);

    if (form.business_type === "MiniLeaf") {
      if (!form.harvest_date?.trim()) {
        setError("Harvest date is required for MiniLeaf cycles.");
        return;
      }
    } else {
      if (!form.start_date?.trim() || !form.end_date?.trim()) {
        setError("Start date and end date are required for BotanIQals cycles.");
        return;
      }
      if (new Date(form.start_date) > new Date(form.end_date)) {
        setError("End date must be on or after start date.");
        return;
      }
    }

    setSaving(true);
    try {
      const isMiniLeaf = form.business_type === "MiniLeaf";
      const harvestDate = isMiniLeaf ? form.harvest_date : null;
      const startDate = isMiniLeaf
        ? new Date(form.harvest_date)
        : new Date(form.start_date);
      const endDate = isMiniLeaf
        ? new Date(form.harvest_date)
        : new Date(form.end_date);
      if (isMiniLeaf) {
        startDate.setDate(startDate.getDate() - 21);
      }

      const payload: Record<string, unknown> = {
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        status: form.status,
        business_type: form.business_type,
        user_id: user.id,
      };
      if (harvestDate) {
        payload.harvest_date = harvestDate;
      }
      const { error: insertError } = await supabase
        .from("production_cycles")
        .insert(payload);
      if (insertError) throw insertError;
      const { data: refreshed } = await supabase
        .from("production_cycles")
        .select("*")
        .eq("user_id", user.id)
        .order("start_date", { ascending: false });
      setCycles(refreshed || []);
      setForm((prev) => ({
        ...prev,
        harvest_date: today,
        start_date: today,
        end_date: today,
      }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create cycle.");
    } finally {
      setSaving(false);
    }
  };

  const displayBusinessType = (c: { business_type?: string; brand?: string }) =>
    c.business_type === "MiniLeaf" || c.brand === "minileaf"
      ? "MiniLeaf"
      : "BotanIQals";

  const handleDeleteCycle = async (id: string) => {
    if (!user) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "Delete this production cycle and all associated targets, plan lines, and schedule events? This cannot be undone."
      );
      if (!confirmed) return;
    }
    setError(null);
    try {
      // Remove dependent data first to avoid orphaned records.
      await supabase
        .from("schedule_events")
        .delete()
        .eq("production_cycle_id", id)
        .eq("user_id", user.id);

      await supabase
        .from("production_plan_lines")
        .delete()
        .eq("production_cycle", id)
        .eq("user_id", user.id);

      await supabase
        .from("production_targets")
        .delete()
        .eq("production_cycle", id)
        .eq("user_id", user.id);

      const { error: deleteCycleError } = await supabase
        .from("production_cycles")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id);

      if (deleteCycleError) throw deleteCycleError;

      setCycles((prev) => prev.filter((c) => c.id !== id));
      setTargets((prev) => prev.filter((t) => t.production_cycle !== id));
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to delete production cycle."
      );
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Production Cycles & Planner
          </h1>
          <p className="text-sm text-zinc-600">
            Define production windows and navigate to detailed planners for
            feasibility, shortages, and tray plans.
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">
              Create cycle
            </h2>
            <form onSubmit={handleSubmit} className="space-y-2">
              <div>
                <label className="mb-1 block font-medium text-zinc-800">
                  Business type
                </label>
                <select
                  value={form.business_type}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      business_type: e.target.value as BusinessType,
                    }))
                  }
                  className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="MiniLeaf">MiniLeaf (fresh microgreens)</option>
                  <option value="BotanIQals">BotanIQals (dried products)</option>
                </select>
              </div>

              {form.business_type === "MiniLeaf" ? (
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Harvest date <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={form.harvest_date}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        harvest_date: e.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">
                      Start date <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="date"
                      required
                      value={form.start_date}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          start_date: e.target.value,
                        }))
                      }
                      className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">
                      End date <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="date"
                      required
                      value={form.end_date}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          end_date: e.target.value,
                        }))
                      }
                      className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block font-medium text-zinc-800">
                  Status
                </label>
                <select
                  value={form.status}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      status: e.target.value as CycleForm["status"],
                    }))
                  }
                  className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="draft">Draft</option>
                  <option value="planned">Planned</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              {error && (
                <p className="text-xs text-red-600" role="alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {saving ? "Creating…" : "Create cycle"}
              </button>
            </form>
          </div>

          <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">
              Existing cycles
            </h2>
            {isLoading ? (
              <p className="text-xs text-black">Loading cycles…</p>
            ) : cycles.length ? (
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {cycles.map((c: any) => {
                  const cycleTargets = targets.filter(
                    (t: any) => t.production_cycle === c.id
                  );
                  const businessLabel = displayBusinessType(c);
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                    >
                      <div>
                        <div className="text-xs font-medium text-zinc-900">
                          {c.harvest_date
                            ? `${businessLabel} · Harvest: ${formatDate(c.harvest_date)}`
                            : `${formatDate(c.start_date)} – ${formatDate(c.end_date)}`}
                        </div>
                        <div className="text-[11px] text-zinc-600">
                          {!c.harvest_date && `${businessLabel} · `}
                          Status: {c.status} · Targets: {cycleTargets.length}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/cycles/${c.id}/plan`}
                          className="text-[11px] font-medium text-emerald-700 underline"
                        >
                          Open planner
                        </Link>
                        <button
                          type="button"
                          className="text-[11px] font-medium text-red-600 underline"
                          onClick={() => handleDeleteCycle(c.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-black">
                No cycles yet. Create a cycle to begin planning feasibility and
                tray runs.
              </p>
            )}
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}
