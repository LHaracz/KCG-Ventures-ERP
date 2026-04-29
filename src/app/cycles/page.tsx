"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate } from "@/lib/date";
import { useSupabase } from "@/components/InstantProvider";
import { normalizeBusinessType } from "@/lib/businessType";

type BusinessType = "MiniLeaf" | "BotanIQals";

type CycleForm = {
  business_type: BusinessType;
  harvest_date: string;
  start_date: string;
  end_date: string;
  status: "draft" | "planned" | "completed";
};

type CompletionActualsDraft = {
  cycleId: string;
  cycleLabel: string;
  productActuals: Array<{
    productId: string;
    productName: string;
    plannedQty: number;
    actualQty: string;
  }>;
};

function filterScopedRows<T extends { user_id?: string | null }>(
  rows: T[],
  userId: string,
): T[] {
  return rows.filter((row) => row.user_id == null || row.user_id === userId);
}

export default function CyclesPage() {
  const { user, supabase } = useSupabase();
  const [cycles, setCycles] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [completingCycleId, setCompletingCycleId] = useState<string | null>(
    null,
  );
  const [completionDraft, setCompletionDraft] = useState<CompletionActualsDraft | null>(
    null,
  );

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
      const [c, t, b, p] = await Promise.all([
        supabase
          .from("production_cycles")
          .select("*")
          .eq("user_id", user.id)
          .order("start_date", { ascending: false }),
        supabase
          .from("production_targets")
          .select("*")
          .eq("user_id", user.id),
        supabase
          .from("botaniqals_production_batches")
          .select(
            "id, production_cycle_id, product_id, product_variant_id, batch_id, quantity_produced, production_start_at, production_end_at, completed_at, created_at, products(name)",
          )
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }),
        supabase.from("products").select("*"),
      ]);
      setCycles(c.data || []);
      setTargets(t.data || []);
      setBatches(b.data || []);
      setProducts(filterScopedRows(p.data || [], user.id));
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
    normalizeBusinessType(c, { defaultType: "BotanIQals" });

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

  const beginCompleteProduction = (cycle: any) => {
    const cycleTargets = targets.filter((t: any) => t.production_cycle === cycle.id);
    const grouped = new Map<string, { productName: string; plannedQty: number }>();
    for (const target of cycleTargets) {
      const productId = String(target.product ?? "").trim();
      if (!productId) continue;
      const plannedQty =
        Number(target.quantity_to_produce ?? target.target_units ?? 0) || 0;
      if (plannedQty <= 0) continue;
      const existing = grouped.get(productId) ?? {
        productName:
          products.find((productRow: any) => productRow.id === productId)?.name ??
          "Unknown product",
        plannedQty: 0,
      };
      existing.plannedQty += plannedQty;
      grouped.set(productId, existing);
    }
    const productActuals = Array.from(grouped.entries()).map(([productId, value]) => ({
      productId,
      productName: value.productName,
      plannedQty: value.plannedQty,
      actualQty: String(Math.trunc(value.plannedQty)),
    }));
    if (productActuals.length === 0) {
      setError("No production targets with quantity found for this cycle.");
      return;
    }
    const cycleLabel = cycle.harvest_date
      ? `Harvest: ${formatDate(cycle.harvest_date)}`
      : `${formatDate(cycle.start_date)} – ${formatDate(cycle.end_date)}`;
    setCompletionDraft({
      cycleId: cycle.id,
      cycleLabel,
      productActuals,
    });
  };

  const handleCompleteProduction = async (
    cycle: any,
    actualQtyByProductId: Record<string, number>,
  ) => {
    if (!user) return;
    setError(null);
    setCompletingCycleId(cycle.id);
    try {
      const completionMarker = `cycle:${cycle.id}:completion_usage`;
      const cycleTargets = targets.filter((t: any) => t.production_cycle === cycle.id);
      const totalQty = cycleTargets.reduce(
        (sum: number, t: any) =>
          sum +
          (Number(t.quantity_to_produce ?? t.target_units ?? 0) || 0),
        0,
      );

      if (!totalQty) {
        setError("No production targets with quantity found for this cycle.");
        return;
      }

      if (displayBusinessType(cycle) === "BotanIQals") {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          throw new Error("Unable to verify your session for BotanIQals inventory sync.");
        }
        const syncResponse = await fetch("/api/production/complete-botaniqals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ cycleId: cycle.id, actualQtyByProductId }),
        });
        const syncPayload = (await syncResponse.json()) as {
          error?: string;
          updated?: number;
          skipped?: number;
          missingProductIds?: string[];
          failedSyncProducts?: Array<{ productId: string; error: string }>;
        };
        if (!syncResponse.ok) {
          const syncFailurePreview = (syncPayload.failedSyncProducts ?? [])
            .slice(0, 3)
            .map((entry) => `${entry.productId}: ${entry.error}`)
            .join(" | ");
          throw new Error(
            syncFailurePreview
              ? `${syncPayload.error || "Failed to update finished product inventory."} ${syncFailurePreview}`
              : syncPayload.error || "Failed to update finished product inventory.",
          );
        }
        if ((syncPayload.skipped ?? 0) > 0) {
          throw new Error(
            `Finished product inventory update skipped ${syncPayload.skipped} product mapping(s). Populate inventory.product_id for all produced BotanIQals products and retry.`,
          );
        }
      }

      const { data: existingUsageRows, error: existingUsageErr } = await supabase
        .from("inventory_adjustments")
        .select("id")
        .eq("adjustment_type", "usage")
        .like("note", `%${completionMarker}%`)
        .limit(1);
      if (existingUsageErr) throw existingUsageErr;
      const alreadyDeducted = Boolean(existingUsageRows?.length);

      if (!alreadyDeducted) {
        const productIds = Array.from(
          new Set(cycleTargets.map((t: any) => t.product).filter(Boolean)),
        );
        if (productIds.length) {
          const [{ data: bomRows, error: bomErr }, { data: itemRows, error: itemsErr }] =
            await Promise.all([
              supabase
                .from("bom_lines")
                .select("id, product, line_type, inventory_item, qty_per_unit, unit_label")
                .in("product", productIds),
              supabase
                .from("inventory_items")
                .select("id, name, unit, quantity_on_hand"),
            ]);
          if (bomErr) throw bomErr;
          if (itemsErr) throw itemsErr;

          const bomByProduct = new Map<string, any[]>();
          for (const row of bomRows || []) {
            if (!row.inventory_item) continue;
            if (
              row.line_type !== "inventory_item" &&
              row.line_type !== "packaging"
            ) {
              continue;
            }
            const existing = bomByProduct.get(row.product) || [];
            existing.push(row);
            bomByProduct.set(row.product, existing);
          }

          const requiredByItem = new Map<string, number>();
          for (const target of cycleTargets) {
            const qty =
              Number(target.quantity_to_produce ?? target.target_units ?? 0) || 0;
            if (qty <= 0) continue;
            const lines = bomByProduct.get(target.product) || [];
            for (const line of lines) {
              const lineQty = qty * Number(line.qty_per_unit || 0);
              if (!Number.isFinite(lineQty) || lineQty <= 0) continue;
              requiredByItem.set(
                line.inventory_item,
                (requiredByItem.get(line.inventory_item) || 0) + lineQty,
              );
            }
          }

          if (requiredByItem.size) {
            const itemsById = new Map<string, any>(
              (itemRows || []).map((item: any) => [item.id, item]),
            );
            const shortages = Array.from(requiredByItem.entries())
              .map(([itemId, required]) => {
                const item = itemsById.get(itemId);
                if (!item) return null;
                const onHand = Number(item.quantity_on_hand || 0);
                return {
                  itemId,
                  name: item.name,
                  unit: item.unit,
                  required,
                  onHand,
                  shortage: required - onHand,
                };
              })
              .filter((row): row is NonNullable<typeof row> => Boolean(row))
              .filter((row) => row.shortage > 0);

            if (shortages.length && typeof window !== "undefined") {
              const preview = shortages
                .slice(0, 5)
                .map(
                  (s) =>
                    `- ${s.name}: short ${s.shortage.toFixed(2)} ${s.unit} (need ${s.required.toFixed(2)}, on hand ${s.onHand.toFixed(2)})`,
                )
                .join("\n");
              const extraCount =
                shortages.length > 5 ? `\n...and ${shortages.length - 5} more` : "";
              const confirmed = window.confirm(
                `Inventory shortages were detected for this completion:\n\n${preview}${extraCount}\n\nContinue anyway? This will allow negative inventory balances.`,
              );
              if (!confirmed) {
                return;
              }
            }

            const adjustmentInserts = Array.from(requiredByItem.entries())
              .map(([itemId, required]) => {
                const item = itemsById.get(itemId);
                if (!item) return null;
                return {
                  inventory_item: itemId,
                  adjustment_type: "usage",
                  quantity_delta: -required,
                  note: `Auto-deduct on completion (${completionMarker}) for cycle ${cycle.id}: ${required.toFixed(2)} ${item.unit}`,
                  created_at: new Date().toISOString(),
                  user_id: user.id,
                };
              })
              .filter(Boolean);

            if (adjustmentInserts.length) {
              const { error: adjInsertErr } = await supabase
                .from("inventory_adjustments")
                .insert(adjustmentInserts);
              if (adjInsertErr) throw adjInsertErr;
            }

            await Promise.all(
              Array.from(requiredByItem.entries()).map(async ([itemId, required]) => {
                const item = itemsById.get(itemId);
                if (!item) return;
                const nextOnHand = Number(item.quantity_on_hand || 0) - required;
                const { error: itemUpdateErr } = await supabase
                  .from("inventory_items")
                  .update({ quantity_on_hand: nextOnHand })
                  .eq("id", itemId);
                if (itemUpdateErr) throw itemUpdateErr;
              }),
            );
          }
        }
      }

      if (displayBusinessType(cycle) === "BotanIQals") {
        type BotaniqalsBatchRow = {
          user_id: string;
          production_cycle_id: string;
          product_id: string;
          quantity_produced: number;
          production_start_at: string | null;
          production_end_at: string;
          completed_at: string;
        };

        const batchRows = cycleTargets
          .map((target: any) => {
            const qty = Number(actualQtyByProductId[String(target.product ?? "")] ?? 0) || 0;
            if (!target.product || qty <= 0) return null;
            return {
              user_id: user.id,
              production_cycle_id: cycle.id,
              product_id: target.product,
              quantity_produced: qty,
              production_start_at: cycle.start_date ?? null,
              production_end_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
            };
          })
          .filter((row): row is BotaniqalsBatchRow => row !== null);

        if (batchRows.length > 0) {
          for (const batchRow of batchRows) {
            const { data: existingBatch, error: existingBatchErr } = await supabase
              .from("botaniqals_production_batches")
              .select("id")
              .eq("user_id", user.id)
              .eq("production_cycle_id", cycle.id)
              .eq("product_id", batchRow.product_id)
              .is("product_variant_id", null)
              .maybeSingle();
            if (existingBatchErr) throw existingBatchErr;

            if (existingBatch?.id) {
              const { error: updateBatchErr } = await supabase
                .from("botaniqals_production_batches")
                .update({
                  quantity_produced: batchRow.quantity_produced,
                  production_start_at: batchRow.production_start_at,
                  production_end_at: batchRow.production_end_at,
                  completed_at: batchRow.completed_at,
                })
                .eq("id", existingBatch.id);
              if (updateBatchErr) throw updateBatchErr;
            } else {
              const { error: insertBatchErr } = await supabase
                .from("botaniqals_production_batches")
                .insert(batchRow);
              if (insertBatchErr) throw insertBatchErr;
            }
          }
        }
      }

      const { error: cycleErr } = await supabase
        .from("production_cycles")
        // Some schemas may not include updated_at on production_cycles; status is enough.
        .update({ status: "completed" })
        .eq("id", cycle.id)
        .eq("user_id", user.id);
      if (cycleErr) throw cycleErr;

      const { data: refreshedBatches, error: batchesErr } = await supabase
        .from("botaniqals_production_batches")
        .select(
          "id, production_cycle_id, product_id, product_variant_id, batch_id, quantity_produced, production_start_at, production_end_at, completed_at, created_at, products(name)",
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (batchesErr) throw batchesErr;
      setBatches(refreshedBatches || []);

      setCycles((prev) =>
        prev.map((c) => (c.id === cycle.id ? { ...c, status: "completed" } : c)),
      );
    } catch (err: unknown) {
      const msg =
        (err as any)?.message ||
        (err as any)?.error_description ||
        (err as any)?.details ||
        "Failed to complete production.";
      setError(String(msg));
    } finally {
      setCompletingCycleId(null);
    }
  };

  const submitCompletionDraft = async () => {
    if (!completionDraft) return;
    const actualQtyByProductId: Record<string, number> = {};
    for (const line of completionDraft.productActuals) {
      const trimmed = line.actualQty.trim();
      if (!trimmed) {
        setError(`Actual quantity is required for ${line.productName}.`);
        return;
      }
      if (!/^\d+$/.test(trimmed)) {
        setError(`Actual quantity for ${line.productName} must be a non-negative integer.`);
        return;
      }
      actualQtyByProductId[line.productId] = Number(trimmed);
    }
    const cycle = cycles.find((row: any) => row.id === completionDraft.cycleId);
    if (!cycle) {
      setError("Production cycle not found.");
      return;
    }
    setCompletionDraft(null);
    await handleCompleteProduction(cycle, actualQtyByProductId);
  };

  const batchDetailRows = batches
    .filter((batch: any) => {
      const cycle = cycles.find((cycleRow: any) => cycleRow.id === batch.production_cycle_id);
      return cycle && displayBusinessType(cycle) === "BotanIQals";
    })
    .map((batch: any) => {
      const cycle = cycles.find((cycleRow: any) => cycleRow.id === batch.production_cycle_id);
      const product = products.find((productRow: any) => productRow.id === batch.product_id);
      return {
        cycleId: batch.production_cycle_id,
        cycleLabel: cycle?.harvest_date
          ? `Harvest: ${formatDate(cycle.harvest_date)}`
          : `${formatDate(cycle?.start_date)} – ${formatDate(cycle?.end_date)}`,
        productName:
          batch.products?.name ??
          product?.name ??
          "Unknown product",
        quantity: Number(batch.quantity_produced ?? 0) || 0,
        batchId: batch.batch_id ?? "—",
        start: batch.production_start_at ?? cycle?.start_date ?? null,
        end: batch.production_end_at ?? cycle?.end_date ?? null,
      };
    })
    .filter((row) => row.quantity > 0);

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
                  const cycleBatches = batches.filter(
                    (b: any) => b.production_cycle_id === c.id,
                  );
                  const businessLabel = displayBusinessType(c);
                  const isBotaniqals = businessLabel === "BotanIQals";
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
                        {isBotaniqals && cycleBatches.length > 0 && (
                          <div className="mt-1 text-[11px] text-zinc-700">
                            Batches:{" "}
                            {cycleBatches
                              .slice(0, 3)
                              .map((b: any) => b.batch_id)
                              .join(", ")}
                            {cycleBatches.length > 3 ? "…" : ""}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/cycles/${c.id}/plan`}
                          className="text-[11px] font-medium text-emerald-700 underline"
                        >
                          Open planner
                        </Link>
                        {isBotaniqals && cycleBatches.length === 0 && (
                          <button
                            type="button"
                            disabled={completingCycleId === c.id}
                            className="text-[11px] font-medium text-emerald-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => beginCompleteProduction(c)}
                          >
                            {completingCycleId === c.id
                              ? "Completing…"
                              : "Complete production"}
                          </button>
                        )}
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

        {batchDetailRows.length > 0 && (
          <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">
              BotanIQals batch details
            </h2>
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left">
                <thead className="bg-zinc-50 text-[11px] text-black">
                  <tr>
                    <th className="px-2 py-1 font-medium">Cycle</th>
                    <th className="px-2 py-1 font-medium">Product</th>
                    <th className="px-2 py-1 font-medium">Quantity</th>
                    <th className="px-2 py-1 font-medium">Batch ID</th>
                    <th className="px-2 py-1 font-medium">Start</th>
                    <th className="px-2 py-1 font-medium">End</th>
                  </tr>
                </thead>
                <tbody>
                  {batchDetailRows.map((row: any, idx: number) => (
                    <tr key={`${row.cycleId}-${idx}`} className="border-b text-[11px] text-black">
                      <td className="px-2 py-1">{row.cycleLabel}</td>
                      <td className="px-2 py-1">{row.productName}</td>
                      <td className="px-2 py-1">
                        {Number(row.quantity).toString()}
                      </td>
                      <td className="px-2 py-1 font-mono">{row.batchId}</td>
                      <td className="px-2 py-1">
                        {row.start ? formatDate(row.start) : "—"}
                      </td>
                      <td className="px-2 py-1">
                        {row.end ? formatDate(row.end) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {completionDraft && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-xl rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">
                Complete production with actual output
              </h2>
              <p className="mt-1 text-xs text-zinc-600">
                {completionDraft.cycleLabel}
              </p>
              <div className="mt-3 space-y-2">
                {completionDraft.productActuals.map((line) => (
                  <div key={line.productId} className="grid grid-cols-12 items-center gap-2 text-xs">
                    <div className="col-span-7">
                      <p className="font-medium text-zinc-900">{line.productName}</p>
                      <p className="text-zinc-600">Planned: {line.plannedQty}</p>
                    </div>
                    <label className="col-span-5">
                      <span className="mb-1 block text-zinc-700">Actual produced</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={line.actualQty}
                        onChange={(e) =>
                          setCompletionDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  productActuals: prev.productActuals.map((entry) =>
                                    entry.productId === line.productId
                                      ? { ...entry, actualQty: e.target.value }
                                      : entry,
                                  ),
                                }
                              : prev,
                          )
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </label>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCompletionDraft(null)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitCompletionDraft}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  Submit actuals and complete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
