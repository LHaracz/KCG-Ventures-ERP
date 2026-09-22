"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";

type FulfillmentListRow = {
  orderId: string;
  name: string;
  createdAt: string;
  customerName: string;
  itemCount: number;
  totalProductWeightOz: number;
};

type PresetForm = {
  id?: string;
  nickname: string;
  length_in: string;
  width_in: string;
  height_in: string;
  tare_weight_oz: string;
};

const emptyPresetForm: PresetForm = {
  nickname: "",
  length_in: "",
  width_in: "",
  height_in: "",
  tare_weight_oz: "",
};

export default function FulfillmentsPage() {
  const { user, supabase } = useSupabase();

  const [orders, setOrders] = useState<FulfillmentListRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const [presets, setPresets] = useState<any[]>([]);
  const [presetsPanelOpen, setPresetsPanelOpen] = useState(false);
  const [presetForm, setPresetForm] = useState<PresetForm>(emptyPresetForm);
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setOrdersLoading(true);
      setOrdersError(null);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error("Unable to verify your session.");
        const response = await fetch("/api/fulfillments", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = (await response.json()) as {
          orders?: FulfillmentListRow[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "Failed to load unfulfilled orders.");
        }
        if (!cancelled) setOrders(payload.orders || []);
      } catch (err: any) {
        if (!cancelled) setOrdersError(err.message || "Failed to load unfulfilled orders.");
      } finally {
        if (!cancelled) setOrdersLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const loadPresets = async () => {
      const { data } = await supabase
        .from("package_presets")
        .select("*")
        .eq("user_id", user.id)
        .order("nickname", { ascending: true });
      if (!cancelled) setPresets(data || []);
    };
    loadPresets();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  const handlePresetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setPresetError(null);

    const length_in = Number(presetForm.length_in);
    const width_in = Number(presetForm.width_in);
    const height_in = Number(presetForm.height_in);
    const tare_weight_oz = Number(presetForm.tare_weight_oz);
    if (!presetForm.nickname.trim()) {
      setPresetError("Nickname is required.");
      return;
    }
    if (
      ![length_in, width_in, height_in, tare_weight_oz].every(
        (n) => Number.isFinite(n) && n >= 0,
      )
    ) {
      setPresetError("Dimensions and tare weight must be non-negative numbers.");
      return;
    }

    setPresetSaving(true);
    try {
      const payload = {
        nickname: presetForm.nickname.trim(),
        length_in,
        width_in,
        height_in,
        tare_weight_oz,
        user_id: user.id,
      };
      if (presetForm.id) {
        const { error } = await supabase
          .from("package_presets")
          .update(payload)
          .eq("id", presetForm.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("package_presets").insert(payload);
        if (error) throw error;
      }
      const { data } = await supabase
        .from("package_presets")
        .select("*")
        .eq("user_id", user.id)
        .order("nickname", { ascending: true });
      setPresets(data || []);
      setPresetForm(emptyPresetForm);
    } catch (err: any) {
      setPresetError(err.message || "Failed to save package preset.");
    } finally {
      setPresetSaving(false);
    }
  };

  const handleEditPreset = (preset: any) => {
    setPresetError(null);
    setPresetForm({
      id: preset.id,
      nickname: preset.nickname ?? "",
      length_in: String(preset.length_in ?? ""),
      width_in: String(preset.width_in ?? ""),
      height_in: String(preset.height_in ?? ""),
      tare_weight_oz: String(preset.tare_weight_oz ?? ""),
    });
    setPresetsPanelOpen(true);
  };

  const handleDeletePreset = async (id: string) => {
    if (!user) return;
    setPresetError(null);
    try {
      const { error } = await supabase
        .from("package_presets")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id);
      if (error) throw error;
      setPresets((prev) => prev.filter((p) => p.id !== id));
      if (presetForm.id === id) setPresetForm(emptyPresetForm);
    } catch (err: any) {
      setPresetError(err.message || "Failed to delete package preset.");
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <section>
          <h1 className="mb-2 text-2xl font-semibold text-zinc-900">Fulfillments</h1>
          <p className="text-sm text-black">
            Unfulfilled Shopify orders, oldest first, with product weight for label
            planning.
          </p>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          {ordersLoading ? (
            <p className="text-xs text-black">Loading unfulfilled orders…</p>
          ) : ordersError ? (
            <p className="text-xs text-red-600" role="alert">
              {ordersError}
            </p>
          ) : orders.length === 0 ? (
            <p className="text-xs text-black">No unfulfilled orders right now.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Order</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium">Items</th>
                    <th className="px-3 py-2 font-medium">Product Weight</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.orderId} className="border-b border-zinc-100">
                      <td className="px-3 py-2 font-medium text-zinc-900">{o.name}</td>
                      <td className="px-3 py-2 text-zinc-700">{formatDate(o.createdAt)}</td>
                      <td className="px-3 py-2 text-zinc-700">{o.customerName}</td>
                      <td className="px-3 py-2 text-zinc-700">{o.itemCount}</td>
                      <td className="px-3 py-2 text-zinc-700">
                        {o.totalProductWeightOz.toFixed(1)} oz
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/fulfillments/${o.orderId}`}
                          className="text-[11px] font-medium text-emerald-700 underline"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <button
            type="button"
            onClick={() => setPresetsPanelOpen((v) => !v)}
            className="text-sm font-semibold text-zinc-900"
          >
            Package Presets {presetsPanelOpen ? "▾" : "▸"}
          </button>

          {presetsPanelOpen && (
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <form onSubmit={handlePresetSubmit} className="space-y-2 text-xs">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Nickname</label>
                  <input
                    required
                    value={presetForm.nickname}
                    onChange={(e) =>
                      setPresetForm((prev) => ({ ...prev, nickname: e.target.value }))
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="Small box"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">L (in)</label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="0"
                      value={presetForm.length_in}
                      onChange={(e) =>
                        setPresetForm((prev) => ({ ...prev, length_in: e.target.value }))
                      }
                      className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">W (in)</label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="0"
                      value={presetForm.width_in}
                      onChange={(e) =>
                        setPresetForm((prev) => ({ ...prev, width_in: e.target.value }))
                      }
                      className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">H (in)</label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="0"
                      value={presetForm.height_in}
                      onChange={(e) =>
                        setPresetForm((prev) => ({ ...prev, height_in: e.target.value }))
                      }
                      className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Tare weight (oz)
                  </label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={presetForm.tare_weight_oz}
                    onChange={(e) =>
                      setPresetForm((prev) => ({ ...prev, tare_weight_oz: e.target.value }))
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                {presetError && (
                  <p className="text-xs text-red-600" role="alert">
                    {presetError}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={presetSaving}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {presetSaving ? "Saving…" : presetForm.id ? "Update preset" : "Add preset"}
                  </button>
                  {presetForm.id && (
                    <button
                      type="button"
                      onClick={() => setPresetForm(emptyPresetForm)}
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>

              <div className="text-xs">
                {presets.length === 0 ? (
                  <p className="text-black">No package presets yet.</p>
                ) : (
                  <div className="space-y-2">
                    {presets.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                      >
                        <div>
                          <div className="font-medium text-zinc-900">{p.nickname}</div>
                          <div className="text-[11px] text-zinc-600">
                            {p.length_in}×{p.width_in}×{p.height_in} in ·{" "}
                            {p.tare_weight_oz} oz tare
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleEditPreset(p)}
                            className="text-[11px] font-medium text-emerald-700 underline"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeletePreset(p.id)}
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
          )}
        </section>
      </div>
    </AuthGuard>
  );
}
