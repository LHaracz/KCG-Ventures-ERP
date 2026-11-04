"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { normalizeBusinessType } from "@/lib/businessType";
import { formatDate } from "@/lib/date";
import { formatNyDateTime } from "@/lib/nyTime";
import { buildProductionSummary } from "@/lib/productionSummary";

// View Production: a read-only summary of a completed production cycle. No
// action on this page changes data.

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));

export default function ViewProductionPage() {
  const { id } = useParams<{ id: string }>();
  const { user, supabase } = useSupabase();
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !id) return;
    (async () => {
      const [cycleRes, targetsRes, productsRes, fgRes, pbRes, snapRes, reviewRes, bomRes, itemsRes] = await Promise.all([
        supabase.from("production_cycles").select("*").eq("id", id).maybeSingle(),
        supabase.from("production_targets").select("product, quantity_to_produce, target_units").eq("production_cycle", id),
        supabase.from("products").select("id, name, sale_price_per_unit"),
        supabase.from("finished_goods_batches").select("batch_code, product_id, initial_qty, remaining_qty, status").eq("production_cycle_id", id),
        supabase.from("botaniqals_production_batches").select("batch_id, product_id, quantity_produced, completed_at").eq("production_cycle_id", id),
        supabase.from("cycle_completion_snapshots").select("*").eq("production_cycle_id", id).maybeSingle(),
        supabase.from("batch_compliance_reviews").select("*").eq("production_cycle_id", id).order("created_at", { ascending: false }).limit(1),
        supabase.from("bom_lines").select("product, inventory_item, qty_per_unit, unit_label"),
        supabase.from("inventory_items").select("id, name, unit, cost_per_unit"),
      ]);
      if (cycleRes.error || !cycleRes.data) {
        setError(cycleRes.error?.message || "Production cycle not found.");
        return;
      }
      setData({
        cycle: cycleRes.data,
        targets: targetsRes.data ?? [],
        products: productsRes.data ?? [],
        fgBatches: fgRes.data ?? [],
        productionBatches: pbRes.data ?? [],
        snapshot: snapRes.data ?? null,
        review: (reviewRes.data ?? [])[0] ?? null,
        bomLines: bomRes.data ?? [],
        items: itemsRes.data ?? [],
      });
    })();
  }, [user, supabase, id]);

  const summary = useMemo(() => {
    if (!data) return null;
    const actual = new Map<string, number>();
    for (const b of data.productionBatches) if (b.product_id) actual.set(b.product_id, (actual.get(b.product_id) ?? 0) + Number(b.quantity_produced || 0));
    return buildProductionSummary({
      targets: data.targets,
      products: data.products,
      actualByProductId: actual,
      snapshot: data.snapshot,
      bomLines: data.bomLines,
      items: data.items,
    });
  }, [data]);

  const nameById = useMemo(() => new Map(((data?.products ?? []) as any[]).map((p) => [p.id, p.name])), [data]);
  const batchCodes = useMemo(() => {
    if (!data) return [];
    const fg = data.fgBatches as any[];
    if (fg.length) return fg.map((b) => ({ code: b.batch_code, product: nameById.get(b.product_id) ?? "", qty: b.initial_qty }));
    return (data.productionBatches as any[]).map((b) => ({ code: b.batch_id, product: nameById.get(b.product_id) ?? "", qty: Number(b.quantity_produced || 0) }));
  }, [data, nameById]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-5 text-black">
        <Link href="/cycles" className="text-sm font-medium text-emerald-800 underline">
          ← Back to Production Cycles
        </Link>
        {error ? (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : !data || !summary ? (
          <p className="text-sm">Loading…</p>
        ) : (
          <>
            <p className="rounded-md bg-zinc-200 px-3 py-2 text-sm font-medium text-black ring-1 ring-zinc-400" data-testid="view-only-banner">
              {data.cycle.status === "completed" ? "Completed: view only" : "Not completed yet: view only"}
            </p>
            <header>
              <h1 className="text-2xl font-semibold">Production {String(data.cycle.id).slice(0, 8)}</h1>
              <p className="text-sm">
                {normalizeBusinessType(data.cycle, { defaultType: "BotanIQals" })} · {formatDate(data.cycle.start_date)} –{" "}
                {formatDate(data.cycle.end_date)} · Completed {data.cycle.completed_at ? formatNyDateTime(data.cycle.completed_at) : "—"}
              </p>
              <p className="text-xs">Cycle ID: {data.cycle.id}</p>
            </header>

            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <h2 className="mb-2 text-sm font-semibold">Products</h2>
                <table className="min-w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide">
                    <tr>
                      <th className="pr-4 font-medium">Product</th>
                      <th className="pr-4 font-medium">Target</th>
                      <th className="pr-4 font-medium">Actual</th>
                      <th className="font-medium">Sale price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.products.map((p) => (
                      <tr key={p.productId}>
                        <td className="pr-4">{p.name}</td>
                        <td className="pr-4">{p.targetQty}</td>
                        <td className="pr-4 font-semibold">{p.actualQty}</td>
                        <td>{money(p.salePricePerUnit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <h2 className="mb-2 text-sm font-semibold">Batches created</h2>
                {batchCodes.length === 0 ? (
                  <p className="text-sm">None.</p>
                ) : (
                  <ul className="space-y-1 text-sm" data-testid="summary-batches">
                    {batchCodes.map((b) => (
                      <li key={b.code}>
                        <span className="font-semibold">Batch {b.code}</span>: {b.qty} {b.product}
                      </li>
                    ))}
                  </ul>
                )}
                <h2 className="mb-1 mt-4 text-sm font-semibold">Compliance</h2>
                {!data.review ? (
                  <p className="text-sm">No compliance review on record.</p>
                ) : (data.review.warnings ?? []).length === 0 ? (
                  <p className="text-sm">Checked: no warnings.</p>
                ) : (
                  <p className="text-sm">
                    {(data.review.warnings ?? []).length} warning(s) acknowledged by {data.review.acknowledged_by_name ?? "—"}
                    {data.review.acknowledged_note ? `: ${data.review.acknowledged_note}` : ""}
                  </p>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">Ingredients</h2>
                {summary.basis === "current_prices" && (
                  <span className="rounded-md bg-amber-50 px-2 py-1 text-xs ring-1 ring-amber-300" data-testid="current-prices-note">
                    Based on current prices; no snapshot from completion.
                  </span>
                )}
              </div>
              {summary.ingredients.length === 0 ? (
                <p className="text-sm">No ingredients (this product has no BOM lines).</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-zinc-50 text-xs uppercase tracking-wide">
                      <tr>
                        <th className="px-2 py-1 font-medium">Ingredient</th>
                        {summary.products.length > 1 && <th className="px-2 py-1 font-medium">For</th>}
                        <th className="px-2 py-1 font-medium">Quantity used</th>
                        <th className="px-2 py-1 font-medium">Unit</th>
                        <th className="px-2 py-1 font-medium">Cost per unit</th>
                        <th className="px-2 py-1 font-medium">Line cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.ingredients.map((l, i) => (
                        <tr key={i} className="border-t border-zinc-100">
                          <td className="px-2 py-1">{l.ingredient}</td>
                          {summary.products.length > 1 && <td className="px-2 py-1">{l.product}</td>}
                          <td className="px-2 py-1">{qty(l.qtyUsed)}</td>
                          <td className="px-2 py-1">{l.unit}</td>
                          <td className="px-2 py-1">{money(l.costPerUnit)}</td>
                          <td className="px-2 py-1">{money(l.lineCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="summary-totals">
              {[
                ["Total ingredient cost", money(summary.totalIngredientCost)],
                ["Cost per unit", money(summary.costPerUnit)],
                ["Sale price per unit", summary.products.length === 1 ? money(summary.products[0].salePricePerUnit) : "See products"],
                ["Potential revenue", money(summary.potentialRevenue)],
                ["Potential gross profit", money(summary.grossProfit)],
                ["Margin", summary.marginPct == null ? "—" : `${summary.marginPct.toFixed(1)}%`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
                  <div className="text-xs">{label}</div>
                  <div className="text-lg font-semibold">{value}</div>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </AuthGuard>
  );
}
