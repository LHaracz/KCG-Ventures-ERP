"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

// finished_goods: the canonical, hand-managed list of sellable finished
// products used by the Sales Data / variant-component-mapping feature.
// Deliberately separate from `products` (Products & BOM) in this phase.

type FinishedGoodRow = {
  id: string;
  name: string;
  business: "minileaf" | "botaniqals";
};

type FinishedGoodForm = {
  id?: string;
  name: string;
  business: "minileaf" | "botaniqals";
};

const emptyForm: FinishedGoodForm = {
  name: "",
  business: "botaniqals",
};

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function businessLabel(business: string): string {
  return business === "minileaf" ? "MiniLeaf" : "BotanIQals";
}

export default function FinishedGoodsSettingsPage() {
  const { user, supabase } = useSupabase();

  const [rows, setRows] = useState<FinishedGoodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FinishedGoodForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRows = async () => {
    const { data } = await supabase
      .from("finished_goods")
      .select("id, name, business")
      .order("name", { ascending: true });
    setRows((data || []) as FinishedGoodRow[]);
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      await loadRows();
      if (!cancelled) setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, supabase]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);

    const name = form.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }

    setSaving(true);
    try {
      if (form.id) {
        const { error: updateError } = await supabase
          .from("finished_goods")
          .update({ name, business: form.business })
          .eq("id", form.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase
          .from("finished_goods")
          .insert({ name, business: form.business });
        if (insertError) throw insertError;
      }
      await loadRows();
      setForm(emptyForm);
    } catch (err: any) {
      setError(err.message || "Failed to save this finished good.");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (row: FinishedGoodRow) => {
    setError(null);
    setForm({ id: row.id, name: row.name, business: row.business });
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      const { error: deleteError } = await supabase.from("finished_goods").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setRows((prev) => prev.filter((r) => r.id !== id));
      if (form.id === id) setForm(emptyForm);
    } catch (err: any) {
      setError(err.message || "Failed to delete this finished good.");
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <Link
            href="/sales-data"
            className="mb-2 inline-block text-[11px] font-medium text-emerald-700 underline"
          >
            ← Back to Sales Data
          </Link>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">Finished Goods</h1>
          <p className="text-sm text-zinc-600">
            The canonical list of sellable finished products, used by Variant Component Mapping
            to decompose Shopify order line items. No inventory quantity here yet — that&apos;s a
            later phase.
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
                  placeholder="Mineral Mouth Rinse"
                  className={inputClassName}
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-zinc-800">Business</label>
                <select
                  value={form.business}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, business: e.target.value as FinishedGoodForm["business"] }))
                  }
                  className={inputClassName}
                >
                  <option value="botaniqals">BotanIQals</option>
                  <option value="minileaf">MiniLeaf</option>
                </select>
              </div>
              {error && (
                <p className="text-xs text-red-600" role="alert">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {saving ? "Saving…" : form.id ? "Update" : "Add finished good"}
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
              ) : rows.length === 0 ? (
                <p className="text-black">No finished goods yet.</p>
              ) : (
                <div className="space-y-2">
                  {rows.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                    >
                      <div>
                        <div className="font-medium text-zinc-900">{r.name}</div>
                        <div className="text-[11px] text-zinc-600">{businessLabel(r.business)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleEdit(r)}
                          className="text-[11px] font-medium text-emerald-700 underline"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(r.id)}
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
      </div>
    </AuthGuard>
  );
}
