"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import type { FormulationProductRow, FormulationRow } from "@/lib/formulation";

export default function FormulationListPage() {
  const { user, supabase } = useSupabase();
  const [products, setProducts] = useState<FormulationProductRow[]>([]);
  const [formulations, setFormulations] = useState<FormulationRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const [fp, f] = await Promise.all([
        supabase
          .from("formulation_products")
          .select("*")
          .is("deleted_at", null)
          .order("created_at", { ascending: false }),
        supabase
          .from("formulations")
          .select("*")
          .order("version_number", { ascending: false }),
      ]);
      if (fp.error || f.error) {
        setLoadError([fp.error?.message, f.error?.message].filter(Boolean).join(" | "));
      }
      setProducts((fp.data || []) as FormulationProductRow[]);
      setFormulations((f.data || []) as FormulationRow[]);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const latestFormulationFor = (formulationProductId: string) =>
    formulations.find((f) => f.formulation_product_id === formulationProductId);

  // A product that never made it into Products & BOM (product_id is still
  // null) has nothing else referencing it anywhere in the app, so it can
  // just be deleted outright — no impact review needed.
  const handleDeleteDraft = async (p: FormulationProductRow) => {
    if (!window.confirm(`Delete "${p.name}"? It was never finished, so nothing else references it.`)) return;
    const { error } = await supabase.from("formulation_products").delete().eq("id", p.id);
    if (error) {
      setLoadError(error.message);
      return;
    }
    setProducts((prev) => prev.filter((row) => row.id !== p.id));
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">Formulation</h1>
            <p className="text-sm text-black">
              Product development, formula iterations, and test batches for BotanIQals
              products. Products & BOM stays the source of truth for production — Finish
              Iteration here writes straight into it.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/formulation/backfill"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black shadow-sm hover:bg-zinc-50"
            >
              Import existing products
            </Link>
            <Link
              href="/formulation/new"
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
            >
              New Product
            </Link>
          </div>
        </header>

        {loadError && (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        )}

        <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
          {isLoading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : products.length ? (
            <table className="min-w-full border-collapse text-left">
              <thead className="bg-zinc-50 text-[11px] text-black">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Name</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium">Latest version</th>
                  <th className="px-2 py-1.5 font-medium">Created</th>
                  <th className="px-2 py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const latest = latestFormulationFor(p.id);
                  return (
                    <tr key={p.id} className="border-b text-[11px] text-black">
                      <td className="px-2 py-1.5 font-medium text-zinc-900">{p.name}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            p.status === "active"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {p.status === "active" ? "Active" : "In development"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        {latest ? (
                          <>
                            v{latest.version_number}
                            {latest.status === "draft" ? " (draft)" : " (final)"}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {new Date(p.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Link
                          href={`/formulation/${p.id}`}
                          className="text-emerald-700 underline"
                        >
                          Open
                        </Link>
                        {!p.product_id && (
                          <button
                            type="button"
                            onClick={() => handleDeleteDraft(p)}
                            className="ml-3 text-red-600 underline"
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-black">
              No formulation products yet. Start a new one, or import your existing
              BotanIQals products as their v1 baseline formulation.
            </p>
          )}
        </div>
      </div>
    </AuthGuard>
  );
}
