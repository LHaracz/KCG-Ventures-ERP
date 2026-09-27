"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { fetchAllRows } from "@/lib/supabasePagination";
import { matchMarketForOrder, type MarketRow } from "@/lib/marketMatching";

const NOTIFICATION_CONFIG_ID = "a0000000-0000-0000-0000-000000000001";
const DEFAULT_TIMEZONE = "America/New_York";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type MarketFormState = {
  id?: string;
  name: string;
  day_of_week: string;
  start_time: string;
  end_time: string;
  season_start_date: string;
  season_end_date: string;
  active: boolean;
};

type MarketRecord = {
  id: string;
  name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  season_start_date: string;
  season_end_date: string;
  active: boolean;
};

const emptyForm: MarketFormState = {
  name: "",
  day_of_week: "6",
  start_time: "09:00",
  end_time: "13:00",
  season_start_date: "",
  season_end_date: "",
  active: true,
};

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

type OrderForRecalc = { id: string; created_at: string; channel: string | null; market_id: string | null; pos_category: string | null };

export default function MarketsPage() {
  const { supabase } = useSupabase();

  const [markets, setMarkets] = useState<MarketRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<MarketFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [recalculating, setRecalculating] = useState(false);
  const [recalcProgress, setRecalcProgress] = useState<string | null>(null);
  const [recalcMessage, setRecalcMessage] = useState<string | null>(null);
  const [recalcError, setRecalcError] = useState<string | null>(null);

  const loadMarkets = async () => {
    const { data } = await supabase
      .from("markets")
      .select("*")
      .order("day_of_week", { ascending: true })
      .order("name", { ascending: true });
    setMarkets(data || []);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      await loadMarkets();
      if (!cancelled) setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) {
      setFormError("Name is required.");
      return;
    }
    if (!form.season_start_date || !form.season_end_date) {
      setFormError("Season start and end dates are required.");
      return;
    }
    if (form.season_start_date > form.season_end_date) {
      setFormError("Season start date must be on or before the season end date.");
      return;
    }
    if (!form.start_time || !form.end_time || form.start_time >= form.end_time) {
      setFormError("Start time must be before end time.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        day_of_week: Number(form.day_of_week),
        start_time: form.start_time,
        end_time: form.end_time,
        season_start_date: form.season_start_date,
        season_end_date: form.season_end_date,
        active: form.active,
      };
      if (form.id) {
        const { error } = await supabase.from("markets").update(payload).eq("id", form.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("markets").insert(payload);
        if (error) throw error;
      }
      await loadMarkets();
      setForm(emptyForm);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to save market.");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (market: MarketRecord) => {
    setFormError(null);
    setForm({
      id: market.id,
      name: market.name ?? "",
      day_of_week: String(market.day_of_week ?? 6),
      start_time: (market.start_time ?? "09:00:00").slice(0, 5),
      end_time: (market.end_time ?? "13:00:00").slice(0, 5),
      season_start_date: market.season_start_date ?? "",
      season_end_date: market.season_end_date ?? "",
      active: market.active ?? true,
    });
  };

  const handleDelete = async (id: string) => {
    setFormError(null);
    try {
      const { error } = await supabase.from("markets").delete().eq("id", id);
      if (error) throw error;
      setMarkets((prev) => prev.filter((m) => m.id !== id));
      if (form.id === id) setForm(emptyForm);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to delete market.");
    }
  };

  const handleRecalculate = async () => {
    setRecalcError(null);
    setRecalcMessage(null);
    setRecalculating(true);
    setRecalcProgress("Loading markets and orders…");
    try {
      const { data: marketRows, error: marketsError } = await supabase
        .from("markets")
        .select("id, day_of_week, start_time, end_time, season_start_date, season_end_date, active")
        .eq("active", true);
      if (marketsError) throw marketsError;
      const activeMarkets = (marketRows || []) as MarketRow[];

      const { data: configRow } = await supabase
        .from("notification_config")
        .select("timezone")
        .eq("id", NOTIFICATION_CONFIG_ID)
        .maybeSingle();
      const timezone = (configRow?.timezone as string) || DEFAULT_TIMEZONE;

      const { data: orders, error: ordersError } = await fetchAllRows<OrderForRecalc>((from, to) =>
        supabase
          .from("orders")
          .select("id, created_at, channel, market_id, pos_category")
          .order("created_at", { ascending: true })
          .range(from, to),
      );
      if (ordersError) throw ordersError;

      const toUpdate = orders
        .map((order) => ({
          order,
          match: matchMarketForOrder(order.created_at, order.channel, activeMarkets, timezone),
        }))
        .filter(
          ({ order, match }) =>
            order.market_id !== match.market_id || order.pos_category !== match.pos_category,
        );

      const BATCH_SIZE = 20;
      let done = 0;
      for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
        const batch = toUpdate.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(({ order, match }) =>
            supabase
              .from("orders")
              .update({ market_id: match.market_id, pos_category: match.pos_category })
              .eq("id", order.id),
          ),
        );
        done += batch.length;
        setRecalcProgress(`Recalculating… ${done}/${toUpdate.length} changed orders updated`);
      }

      setRecalcMessage(
        `Done. Checked ${orders.length} order(s); updated ${toUpdate.length} whose market tag changed.`,
      );
    } catch (err: unknown) {
      setRecalcError(err instanceof Error ? err.message : "Failed to recalculate market tags.");
    } finally {
      setRecalcProgress(null);
      setRecalculating(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <Link href="/stats" className="mb-2 inline-block text-[11px] font-medium text-emerald-700 underline">
            ← Back to Sales Stats
          </Link>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">Markets</h1>
          <p className="text-sm text-zinc-600">
            Recurring farmers markets, used to tag Shopify POS orders as a market sale vs. an
            informal/friend POS sale outside any scheduled window.
          </p>
        </header>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <form onSubmit={handleSubmit} className="space-y-2 text-xs">
              <div>
                <label className="mb-1 block font-medium text-zinc-800">Name</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  className={inputClassName}
                  placeholder="Downtown Farmers Market"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-zinc-800">Day of week</label>
                <select
                  value={form.day_of_week}
                  onChange={(e) => setForm((prev) => ({ ...prev, day_of_week: e.target.value }))}
                  className={inputClassName}
                >
                  {DAY_LABELS.map((label, idx) => (
                    <option key={idx} value={idx}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Start time</label>
                  <input
                    required
                    type="time"
                    value={form.start_time}
                    onChange={(e) => setForm((prev) => ({ ...prev, start_time: e.target.value }))}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">End time</label>
                  <input
                    required
                    type="time"
                    value={form.end_time}
                    onChange={(e) => setForm((prev) => ({ ...prev, end_time: e.target.value }))}
                    className={inputClassName}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Season start</label>
                  <input
                    required
                    type="date"
                    value={form.season_start_date}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, season_start_date: e.target.value }))
                    }
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Season end</label>
                  <input
                    required
                    type="date"
                    value={form.season_end_date}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, season_end_date: e.target.value }))
                    }
                    className={inputClassName}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 font-medium text-zinc-800">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm((prev) => ({ ...prev, active: e.target.checked }))}
                />
                Active
              </label>
              {formError && (
                <p className="text-xs text-red-600" role="alert">
                  {formError}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {saving ? "Saving…" : form.id ? "Update market" : "Add market"}
                </button>
                {form.id && (
                  <button
                    type="button"
                    onClick={() => setForm(emptyForm)}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>

            <div className="text-xs">
              {loading ? (
                <p className="text-black">Loading…</p>
              ) : markets.length === 0 ? (
                <p className="text-black">No markets yet.</p>
              ) : (
                <div className="space-y-2">
                  {markets.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                    >
                      <div>
                        <div className="font-medium text-zinc-900">
                          {m.name} {!m.active && <span className="text-zinc-400">(inactive)</span>}
                        </div>
                        <div className="text-[11px] text-zinc-600">
                          {DAY_LABELS[m.day_of_week]}s, {(m.start_time || "").slice(0, 5)}–
                          {(m.end_time || "").slice(0, 5)} · {m.season_start_date} to{" "}
                          {m.season_end_date}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleEdit(m)}
                          className="text-[11px] font-medium text-emerald-700 underline"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(m.id)}
                          className="text-[11px] font-medium text-red-600 underline"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 text-sm font-semibold text-zinc-900">Recalculate Market Tags</h2>
          <p className="mb-2 text-xs text-zinc-600">
            Re-checks every order against the markets above and updates its market tag. Only{" "}
            <strong>active</strong> markets are considered — marking a market inactive stops it
            matching both future imports and this recalculation, even for orders during its
            original season. If an older order is missing its channel (needed to detect a POS
            sale at all), re-import a CSV covering that date range first, then run this.
          </p>
          <button
            type="button"
            onClick={handleRecalculate}
            disabled={recalculating}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {recalculating ? "Recalculating…" : "Recalculate Market Tags"}
          </button>
          {recalcProgress && <p className="mt-2 text-xs text-zinc-600">{recalcProgress}</p>}
          {recalcMessage && <p className="mt-2 text-xs text-emerald-700">{recalcMessage}</p>}
          {recalcError && (
            <p className="mt-2 text-xs text-red-600" role="alert">
              {recalcError}
            </p>
          )}
        </section>
      </div>
    </AuthGuard>
  );
}
