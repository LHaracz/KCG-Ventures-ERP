"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

// variant_component_map: Shopify line-item-name (exact string match) ->
// the BotanIQals product(s) it represents, since Shopify order data here has
// no SKUs populated. A line item can decompose into more than one product
// (e.g. a bundle), each with its own qty_per_unit. Products are sourced
// directly from the Products & BOM page (`products` where
// `is_microgreen = false`) rather than a separate hand-typed list.

type ProductOption = {
  id: string;
  name: string;
};

type MappingComponent = { product_id: string; qty_per_unit: number };

type MappingRow = {
  id: string;
  lineitem_name: string;
  business: "minileaf" | "botaniqals";
  components: MappingComponent[];
};

type ComponentRowForm = { product_id: string; qty_per_unit: string };

type MappingForm = {
  id?: string;
  lineitem_name: string;
  components: ComponentRowForm[];
};

const emptyComponentRow: ComponentRowForm = { product_id: "", qty_per_unit: "1" };

function emptyForm(lineitemName = ""): MappingForm {
  return {
    lineitem_name: lineitemName,
    components: [{ ...emptyComponentRow }],
  };
}

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function formatComponents(components: MappingComponent[], products: ProductOption[]): string {
  if (components.length === 0) return "—";
  return components
    .map((c) => {
      const product = products.find((p) => p.id === c.product_id);
      return `${c.qty_per_unit}× ${product?.name ?? "Unknown product"}`;
    })
    .join(" + ");
}

function VariantMappingPageInner() {
  const { user, supabase } = useSupabase();
  const searchParams = useSearchParams();
  const prefillLineitem = searchParams.get("lineitem") || "";

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<MappingForm>(emptyForm(prefillLineitem));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [appliedPrefill, setAppliedPrefill] = useState(false);

  const loadAll = async () => {
    const [productsResult, mapResult] = await Promise.all([
      supabase
        .from("products")
        .select("id, name")
        .eq("is_microgreen", false)
        .order("name", { ascending: true }),
      supabase
        .from("variant_component_map")
        .select("id, lineitem_name, business, components")
        .order("lineitem_name", { ascending: true }),
    ]);
    setProducts((productsResult.data || []) as ProductOption[]);
    setMappings((mapResult.data || []) as MappingRow[]);
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      await loadAll();
      if (!cancelled) setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, supabase]);

  // Apply the ?lineitem= prefill once, after the initial load, without
  // clobbering anything the user starts typing afterward.
  useEffect(() => {
    if (appliedPrefill || loading || !prefillLineitem) return;
    setForm((prev) => (prev.id ? prev : emptyForm(prefillLineitem)));
    setAppliedPrefill(true);
  }, [appliedPrefill, loading, prefillLineitem]);

  const addComponentRow = () => {
    setForm((prev) => ({ ...prev, components: [...prev.components, { ...emptyComponentRow }] }));
  };

  const removeComponentRow = (index: number) => {
    setForm((prev) => ({
      ...prev,
      components: prev.components.length > 1 ? prev.components.filter((_, i) => i !== index) : prev.components,
    }));
  };

  const updateComponentRow = (index: number, field: keyof ComponentRowForm, value: string) => {
    setForm((prev) => ({
      ...prev,
      components: prev.components.map((c, i) => (i === index ? { ...c, [field]: value } : c)),
    }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);
    setMessage(null);

    const lineitemName = form.lineitem_name.trim();
    if (!lineitemName) {
      setError("Line item name is required.");
      return;
    }

    const validComponents = form.components
      .filter((c) => c.product_id && c.qty_per_unit.trim() !== "")
      .map((c) => ({ product_id: c.product_id, qty_per_unit: Number(c.qty_per_unit) }));

    if (validComponents.length === 0) {
      setError("Add at least one component with a product and quantity.");
      return;
    }
    if (validComponents.some((c) => !Number.isFinite(c.qty_per_unit) || c.qty_per_unit <= 0)) {
      setError("Quantity per unit must be a positive number.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        lineitem_name: lineitemName,
        business: "botaniqals" as const,
        components: validComponents,
      };

      if (form.id) {
        const { error: updateError } = await supabase
          .from("variant_component_map")
          .update(payload)
          .eq("id", form.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase.from("variant_component_map").insert(payload);
        if (insertError) throw insertError;
      }

      // Clear this line item from the unmapped queue, if it's there.
      await supabase.from("unmapped_line_items").delete().eq("lineitem_name", lineitemName);

      await loadAll();
      setForm(emptyForm());
      setMessage(`Saved mapping for "${lineitemName}".`);
    } catch (err: any) {
      setError(err.message || "Failed to save this mapping.");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (row: MappingRow) => {
    setError(null);
    setMessage(null);
    setForm({
      id: row.id,
      lineitem_name: row.lineitem_name,
      components:
        row.components.length > 0
          ? row.components.map((c) => ({
              product_id: c.product_id,
              qty_per_unit: String(c.qty_per_unit),
            }))
          : [{ ...emptyComponentRow }],
    });
  };

  const handleDelete = async (id: string) => {
    setError(null);
    setMessage(null);
    try {
      const { error: deleteError } = await supabase.from("variant_component_map").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setMappings((prev) => prev.filter((m) => m.id !== id));
      if (form.id === id) setForm(emptyForm());
    } catch (err: any) {
      setError(err.message || "Failed to delete this mapping.");
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <Link
            href="/sales-data"
            className="mb-2 inline-block text-[11px] font-medium text-emerald-700 underline"
          >
            ← Back to Sales Data
          </Link>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">Variant Component Mapping</h1>
          <p className="text-sm text-zinc-600">
            Maps each exact Shopify line item name to the BotanIQals product(s) it represents, from
            the Products &amp; BOM page. Matching is by exact name string only — never guessed or
            auto-parsed.
          </p>
        </header>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">
            {form.id ? "Edit mapping" : "Add mapping"}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-3 text-xs">
            <div>
              <label className="mb-1 block font-medium text-zinc-800">
                Line item name (exact match)
              </label>
              <input
                required
                value={form.lineitem_name}
                onChange={(e) => setForm((prev) => ({ ...prev, lineitem_name: e.target.value }))}
                placeholder="Starter Kit - Bundle"
                className={inputClassName}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block font-medium text-zinc-800">Products</label>
                <button
                  type="button"
                  onClick={addComponentRow}
                  className="text-[11px] font-medium text-emerald-700 underline"
                >
                  + Add product
                </button>
              </div>
              <div className="space-y-2">
                {form.components.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <select
                      value={row.product_id}
                      onChange={(e) => updateComponentRow(index, "product_id", e.target.value)}
                      className={`${inputClassName} flex-1`}
                    >
                      <option value="">Select product…</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={row.qty_per_unit}
                      onChange={(e) => updateComponentRow(index, "qty_per_unit", e.target.value)}
                      placeholder="Qty"
                      className={`${inputClassName} w-20`}
                    />
                    <button
                      type="button"
                      onClick={() => removeComponentRow(index)}
                      disabled={form.components.length <= 1}
                      className="text-[11px] font-medium text-red-600 underline disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              {products.length === 0 && (
                <p className="mt-1 text-[11px] text-zinc-600">
                  No products yet.{" "}
                  <Link href="/products" className="font-medium text-emerald-700 underline">
                    Add one on the Products &amp; BOM page
                  </Link>{" "}
                  first.
                </p>
              )}
            </div>

            {error && (
              <p className="text-xs text-red-600" role="alert">
                {error}
              </p>
            )}
            {message && <p className="text-xs text-emerald-700">{message}</p>}

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
                  onClick={() => setForm(emptyForm())}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Existing mappings</h2>
          {loading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : mappings.length === 0 ? (
            <p className="text-xs text-black">No mappings yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Line item name</th>
                    <th className="px-3 py-2 font-medium">Products</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m) => (
                    <tr key={m.id} className="border-b border-zinc-100">
                      <td className="px-3 py-2 font-medium text-zinc-900">{m.lineitem_name}</td>
                      <td className="px-3 py-2 text-zinc-700">
                        {formatComponents(m.components, products)}
                      </td>
                      <td className="px-3 py-2">
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AuthGuard>
  );
}

export default function VariantMappingPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl p-4 text-xs text-black">Loading…</div>}>
      <VariantMappingPageInner />
    </Suspense>
  );
}
