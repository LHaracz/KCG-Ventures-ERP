"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate } from "@/lib/date";
import { useSupabase } from "@/components/InstantProvider";

type CycleForm = {
  start_date: string;
  end_date: string;
  status: "draft" | "planned" | "completed";
};

export default function CyclesPage() {
  const { user, supabase } = useSupabase();
  const [cycles, setCycles] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [form, setForm] = useState<CycleForm>({
    start_date: new Date().toISOString().slice(0, 10),
    end_date: new Date().toISOString().slice(0, 10),
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
    if (new Date(form.start_date) > new Date(form.end_date)) {
      setError("Start date must be on or before end date.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error } = await supabase.from("production_cycles").insert({
        start_date: new Date(form.start_date).toISOString(),
        end_date: new Date(form.end_date).toISOString(),
        status: form.status,
        user_id: user.id,
      });
      if (error) throw error;
      const { data: refreshed } = await supabase
        .from("production_cycles")
        .select("*")
        .eq("user_id", user.id)
        .order("start_date", { ascending: false });
      setCycles(refreshed || []);
    } catch (err: any) {
      setError(err.message || "Failed to create cycle.");
    } finally {
      setSaving(false);
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
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Start date
                  </label>
                  <input
                    type="date"
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
                    End date
                  </label>
                  <input
                    type="date"
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
              <p className="text-xs text-zinc-500">Loading cycles…</p>
            ) : cycles.length ? (
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {cycles.map((c: any) => {
                  const cycleTargets = targets.filter(
                    (t: any) => t.production_cycle === c.id
                  );
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                    >
                      <div>
                        <div className="text-xs font-medium text-zinc-900">
                          {formatDate(c.start_date)} – {formatDate(c.end_date)}
                        </div>
                        <div className="text-[11px] text-zinc-600">
                          Status: {c.status} · Targets: {cycleTargets.length}
                        </div>
                      </div>
                      <Link
                        href={`/cycles/${c.id}/plan`}
                        className="text-[11px] font-medium text-emerald-700 underline"
                      >
                        Open planner
                      </Link>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-zinc-500">
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

