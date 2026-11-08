"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

// shipping_method_map: shopify shipping-line-title keyword -> EasyPost
// carrier/service. Read during the Generate Label popup (substring,
// case-insensitive match against the order's shipping_line.title) to
// suggest a pre-selected rate — never to buy automatically.

type ShippingMethodRow = {
  id: string;
  shopify_title: string;
  easypost_carrier: string;
  easypost_service: string;
};

type MethodForm = {
  id?: string;
  shopify_title: string;
  easypost_carrier: string;
  easypost_service: string;
};

const emptyMethodForm: MethodForm = {
  shopify_title: "",
  easypost_carrier: "",
  easypost_service: "",
};

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

export default function ShippingMethodsSettingsPage() {
  const { user, supabase } = useSupabase();

  const [methods, setMethods] = useState<ShippingMethodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<MethodForm>(emptyMethodForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMethods = async () => {
    const { data } = await supabase
      .from("shipping_method_map")
      .select("id, shopify_title, easypost_carrier, easypost_service")
      .order("shopify_title", { ascending: true });
    setMethods(data || []);
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      await loadMethods();
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

    const shopifyTitle = form.shopify_title.trim().toLowerCase();
    const carrier = form.easypost_carrier.trim();
    const service = form.easypost_service.trim();
    if (!shopifyTitle || !carrier || !service) {
      setError("All three fields are required.");
      return;
    }

    setSaving(true);
    try {
      if (form.id) {
        const { error: updateError } = await supabase
          .from("shipping_method_map")
          .update({
            shopify_title: shopifyTitle,
            easypost_carrier: carrier,
            easypost_service: service,
          })
          .eq("id", form.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase.from("shipping_method_map").insert({
          shopify_title: shopifyTitle,
          easypost_carrier: carrier,
          easypost_service: service,
        });
        if (insertError) throw insertError;
      }
      await loadMethods();
      setForm(emptyMethodForm);
    } catch (err: any) {
      setError(err.message || "Failed to save this shipping method mapping.");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (row: ShippingMethodRow) => {
    setError(null);
    setForm({
      id: row.id,
      shopify_title: row.shopify_title,
      easypost_carrier: row.easypost_carrier,
      easypost_service: row.easypost_service,
    });
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      const { error: deleteError } = await supabase.from("shipping_method_map").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setMethods((prev) => prev.filter((m) => m.id !== id));
      if (form.id === id) setForm(emptyMethodForm);
    } catch (err: any) {
      setError(err.message || "Failed to delete this shipping method mapping.");
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <Link
            href="/fulfillments"
            className="mb-2 inline-block text-[11px] font-medium text-emerald-700 underline"
          >
            ← Back to Fulfillments
          </Link>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">Shipping Methods</h1>
          <p className="text-sm text-zinc-600">
            Keyword-to-carrier mappings used to pre-select a rate in the Generate Label popup. A
            row matches when its keyword appears anywhere in the order&apos;s shipping method
            title (case-insensitive) — it never buys a label on its own.
          </p>
        </header>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <form onSubmit={handleSubmit} className="space-y-2 text-xs">
              <div>
                <label className="mb-1 block font-medium text-zinc-800">
                  Keyword (matched against the order&apos;s shipping method title)
                </label>
                <input
                  required
                  value={form.shopify_title}
                  onChange={(e) => setForm((prev) => ({ ...prev, shopify_title: e.target.value }))}
                  placeholder="ground advantage"
                  className={inputClassName}
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-zinc-800">EasyPost carrier</label>
                <input
                  required
                  value={form.easypost_carrier}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, easypost_carrier: e.target.value }))
                  }
                  placeholder="USPS"
                  className={inputClassName}
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-zinc-800">EasyPost service</label>
                <input
                  required
                  value={form.easypost_service}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, easypost_service: e.target.value }))
                  }
                  placeholder="GroundAdvantage"
                  className={inputClassName}
                />
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
                  {saving ? "Saving…" : form.id ? "Update mapping" : "Add mapping"}
                </button>
                {form.id && (
                  <button
                    type="button"
                    onClick={() => setForm(emptyMethodForm)}
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
              ) : methods.length === 0 ? (
                <p className="text-black">No shipping method mappings yet.</p>
              ) : (
                <div className="space-y-2">
                  {methods.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                    >
                      <div>
                        <div className="font-medium text-zinc-900">{m.shopify_title}</div>
                        <div className="text-[11px] text-zinc-600">
                          {m.easypost_carrier} · {m.easypost_service}
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
      </div>
    </AuthGuard>
  );
}
