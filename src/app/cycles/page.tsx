"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate } from "@/lib/date";
import { useSupabase } from "@/components/InstantProvider";
import { normalizeBusinessType } from "@/lib/businessType";
import {
  deductRawMaterialsForCycle,
  undoRawMaterialDeductionForCycle,
} from "@/lib/rawMaterialDeduction";
import {
  preloadInventoryCache,
  recordInventoryTransaction,
} from "@/lib/finishedGoodsInventory";
import {
  computeMinileafAggregate,
  computeFeasibility,
  computeShortages,
  feasibilityBadge,
  type Feasibility,
} from "@/lib/feasibility";
import { fetchActiveEmployees, type Employee } from "@/lib/employees";
import { computeReleaseWarnings, type ReleaseWarning } from "@/lib/releaseWarnings";

type BusinessType = "MiniLeaf" | "BotanIQals";

type CycleForm = {
  business_type: BusinessType;
  harvest_date: string;
  start_date: string;
  end_date: string;
  status: "draft" | "planned" | "completed";
};

type ComplianceCheckState = {
  cycle: any;
  draft: CompletionActualsDraft;
  loading: boolean;
  warnings: ReleaseWarning[] | null;
  loadError: string | null;
  acknowledgedByEmployeeId: string;
  acknowledgedNote: string;
  saving: boolean;
  saveError: string | null;
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

type TabKey = "in_progress" | "completed";

type ReopenWarning = {
  productId: string;
  productName: string;
  projectedQty: number;
};

type ReopenConfirmState = {
  cycle: any;
  isBotaniqals: boolean;
  batchRows: Array<{ product_id: string; quantity_produced: number }>;
  warnings: ReopenWarning[];
};

type DeleteConfirmState = {
  cycleId: string;
  cycleLabel: string;
};

type CycleRow = {
  cycle: any;
  isMiniLeaf: boolean;
  targetCount: number;
  feasibility: Feasibility | null;
  shortageCount: number;
};

const PAGE_SIZE = 20;

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
  const [microgreens, setMicrogreens] = useState<any[]>([]);
  const [bomLines, setBomLines] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [calibration, setCalibration] = useState<any | null>(null);
  const [yieldEntries, setYieldEntries] = useState<any[]>([]);
  const [variants, setVariants] = useState<any[]>([]);
  const [machine, setMachine] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<TabKey>("in_progress");
  const [inProgressPage, setInProgressPage] = useState(1);
  const [completedPage, setCompletedPage] = useState(1);

  const [completingCycleId, setCompletingCycleId] = useState<string | null>(
    null,
  );
  const [markingProducedCycleId, setMarkingProducedCycleId] = useState<
    string | null
  >(null);
  const [undoingProducedCycleId, setUndoingProducedCycleId] = useState<
    string | null
  >(null);
  const [completionDraft, setCompletionDraft] = useState<CompletionActualsDraft | null>(
    null,
  );
  const [complianceCheck, setComplianceCheck] = useState<ComplianceCheckState | null>(null);
  const [batchComplianceReviews, setBatchComplianceReviews] = useState<any[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);

  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [deletingCycleId, setDeletingCycleId] = useState<string | null>(null);

  const [reopenConfirm, setReopenConfirm] = useState<ReopenConfirmState | null>(null);
  const [loadingReopenCycleId, setLoadingReopenCycleId] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);

  const [actionsFor, setActionsFor] = useState<{ cycle: any; tab: TabKey } | null>(null);

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
      const [c, t, b, p, mg, bom, inv, cal, y, v, mach, reviews, emps] = await Promise.all([
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
        supabase.from("microgreens").select("*"),
        supabase.from("bom_lines").select("*"),
        supabase.from("inventory_items").select("*"),
        supabase.from("calibration").select("*").limit(1).maybeSingle(),
        supabase.from("yield_entries").select("*"),
        supabase.from("product_variants").select("*"),
        supabase.from("freeze_dryer_machine_settings").select("*").maybeSingle(),
        supabase.from("batch_compliance_reviews").select("*").order("created_at", { ascending: false }),
        fetchActiveEmployees(supabase).catch(() => [] as Employee[]),
      ]);
      setCycles(c.data || []);
      setTargets(t.data || []);
      setBatches(b.data || []);
      setProducts(filterScopedRows(p.data || [], user.id));
      setMicrogreens(mg.data || []);
      setBomLines(bom.data || []);
      setItems(inv.data || []);
      setCalibration(cal.data || null);
      setYieldEntries(y.data || []);
      setVariants(v.data || []);
      setMachine(mach.data || null);
      setBatchComplianceReviews(reviews.data || []);
      setEmployees(emps);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  // Close any open Actions/Delete/Reopen popup on Escape.
  useEffect(() => {
    if (!deleteConfirm && !reopenConfirm && !actionsFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDeleteConfirm(null);
        setReopenConfirm(null);
        setActionsFor(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [deleteConfirm, reopenConfirm, actionsFor]);

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

  const confirmDelete = async () => {
    if (!deleteConfirm || !user) return;
    const id = deleteConfirm.cycleId;
    setDeletingCycleId(id);
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
      setDeleteConfirm(null);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to delete production cycle."
      );
    } finally {
      setDeletingCycleId(null);
    }
  };

  const beginCompleteProduction = async (cycle: any) => {
    const cycleTargets = targets.filter((t: any) => t.production_cycle === cycle.id);
    // If this cycle has been completed before (and reopened), prefill from
    // the actuals already on record for it instead of the planned quantity,
    // so a correction starts from what was last entered rather than from
    // scratch. Only BotanIQals cycles ever get a batch row.
    const previousActualByProductId = new Map<string, number>();
    for (const batch of batches) {
      if (batch.production_cycle_id !== cycle.id) continue;
      const qty = Number(batch.quantity_produced ?? 0) || 0;
      if (!batch.product_id) continue;
      previousActualByProductId.set(batch.product_id, qty);
    }
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
    const productActuals = Array.from(grouped.entries()).map(([productId, value]) => {
      const previousActual = previousActualByProductId.get(productId);
      const defaultQty = previousActual != null ? previousActual : Math.trunc(value.plannedQty);
      return {
        productId,
        productName: value.productName,
        plannedQty: value.plannedQty,
        actualQty: String(defaultQty),
      };
    });
    if (productActuals.length === 0) {
      setError("No production targets with quantity found for this cycle.");
      return;
    }
    const cycleLabel = cycle.harvest_date
      ? `Harvest: ${formatDate(cycle.harvest_date)}`
      : `${formatDate(cycle.start_date)} – ${formatDate(cycle.end_date)}`;
    const draft: CompletionActualsDraft = {
      cycleId: cycle.id,
      cycleLabel,
      productActuals,
    };

    // The compliance check is a BotanIQals-only, warnings-only step shown
    // before this same actuals modal. MiniLeaf cycles skip straight to it,
    // unchanged.
    if (displayBusinessType(cycle) !== "BotanIQals") {
      setCompletionDraft(draft);
      return;
    }

    setComplianceCheck({
      cycle,
      draft,
      loading: true,
      warnings: null,
      loadError: null,
      acknowledgedByEmployeeId: "",
      acknowledgedNote: "",
      saving: false,
      saveError: null,
    });
    try {
      const warnings = await computeReleaseWarnings(supabase, {
        id: cycle.id,
        start_date: cycle.start_date,
        end_date: cycle.end_date,
      });
      setComplianceCheck((prev) => (prev && prev.cycle.id === cycle.id ? { ...prev, loading: false, warnings } : prev));
    } catch (err: unknown) {
      setComplianceCheck((prev) =>
        prev && prev.cycle.id === cycle.id
          ? {
              ...prev,
              loading: false,
              loadError: err instanceof Error ? err.message : "Failed to run the compliance check.",
            }
          : prev,
      );
    }
  };

  const handleContinueFromComplianceCheck = async () => {
    if (!complianceCheck || complianceCheck.warnings === null) return;
    const hasWarnings = complianceCheck.warnings.length > 0;

    let acknowledgedByName: string | null = null;
    if (hasWarnings) {
      if (!complianceCheck.acknowledgedByEmployeeId) {
        setComplianceCheck((prev) => (prev ? { ...prev, saveError: "Choose who is acknowledging these warnings." } : prev));
        return;
      }
      if (!complianceCheck.acknowledgedNote.trim()) {
        setComplianceCheck((prev) => (prev ? { ...prev, saveError: "A short note is required." } : prev));
        return;
      }
      const employee = employees.find((e) => e.id === complianceCheck.acknowledgedByEmployeeId);
      if (!employee) {
        setComplianceCheck((prev) => (prev ? { ...prev, saveError: "Selected employee not found." } : prev));
        return;
      }
      acknowledgedByName = employee.full_name;
    }

    setComplianceCheck((prev) => (prev ? { ...prev, saving: true, saveError: null } : prev));
    try {
      const { error: insertError } = await supabase.from("batch_compliance_reviews").insert({
        production_cycle_id: complianceCheck.cycle.id,
        warnings: complianceCheck.warnings,
        acknowledged_by_name: acknowledgedByName,
        acknowledged_note: hasWarnings ? complianceCheck.acknowledgedNote.trim() : null,
        acknowledged_at: hasWarnings ? new Date().toISOString() : null,
      });
      if (insertError) throw new Error(insertError.message);

      const { data: refreshedReviews } = await supabase
        .from("batch_compliance_reviews")
        .select("*")
        .order("created_at", { ascending: false });
      setBatchComplianceReviews(refreshedReviews || []);

      const draft = complianceCheck.draft;
      setComplianceCheck(null);
      setCompletionDraft(draft);
    } catch (err: unknown) {
      setComplianceCheck((prev) =>
        prev
          ? { ...prev, saving: false, saveError: err instanceof Error ? err.message : "Failed to save the compliance review." }
          : prev,
      );
    }
  };

  const handleCompleteProduction = async (
    cycle: any,
    actualQtyByProductId: Record<string, number>,
  ) => {
    if (!user) return;
    setError(null);
    setCompletingCycleId(cycle.id);
    try {
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
          throw new Error("Unable to verify your session for Sheets production notify.");
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
          sent?: number;
          missingProductIds?: string[];
        };
        if (!syncResponse.ok) {
          throw new Error(
            syncPayload.error || "Failed to notify Google Sheets of production.",
          );
        }
      }

      if (!cycle.raw_materials_deducted_at) {
        const deductResult = await deductRawMaterialsForCycle({
          supabase,
          user,
          cycle,
          cycleTargets,
          noteLabel: "completion",
        });
        if (!deductResult.ok) {
          return;
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

        const nowIso = new Date().toISOString();
        const batchByProductId = new Map<string, BotaniqalsBatchRow>();
        for (const target of cycleTargets) {
          const productId = target.product ? String(target.product) : "";
          if (!productId) continue;
          const qty =
            Number(actualQtyByProductId[productId] ?? 0) || 0;
          if (qty <= 0) continue;
          const existing = batchByProductId.get(productId);
          if (existing) {
            existing.quantity_produced += qty;
          } else {
            batchByProductId.set(productId, {
              user_id: user.id,
              production_cycle_id: cycle.id,
              product_id: productId,
              quantity_produced: qty,
              production_start_at: cycle.start_date ?? null,
              production_end_at: nowIso,
              completed_at: nowIso,
            });
          }
        }

        const batchRows = Array.from(batchByProductId.values());
        if (batchRows.length > 0) {
          // Conflict target matches uq_botaniqals_batches_cycle_product_null_variant
          // (product_variant_id omitted / NULL). On a re-completion after a
          // reopen, this updates the existing row's quantity_produced in
          // place instead of inserting a second one.
          const { error: upsertBatchErr } = await supabase
            .from("botaniqals_production_batches")
            .upsert(batchRows, {
              onConflict: "production_cycle_id,product_id",
              ignoreDuplicates: false,
            });
          if (upsertBatchErr) throw upsertBatchErr;
        }

        // Finished-goods inventory increment — claimed the same way raw
        // material deduction is (a conditional update on a nullable
        // timestamp column), so a retried completion never double-credits
        // on-hand quantity. Reopen Production clears this column back to
        // NULL so a corrected re-completion can claim and apply again.
        const { data: claimedFinishedGoodsRows, error: claimFinishedGoodsErr } = await supabase
          .from("production_cycles")
          .update({ finished_goods_applied_at: nowIso })
          .eq("id", cycle.id)
          .is("finished_goods_applied_at", null)
          .select("id");
        if (claimFinishedGoodsErr) throw claimFinishedGoodsErr;

        if (claimedFinishedGoodsRows && claimedFinishedGoodsRows.length > 0 && batchRows.length > 0) {
          const inventoryCache = await preloadInventoryCache(supabase);
          for (const batchRow of batchRows) {
            if (batchRow.quantity_produced <= 0) continue;
            await recordInventoryTransaction(supabase, {
              productId: batchRow.product_id,
              type: "production_increase",
              quantityDelta: batchRow.quantity_produced,
              referenceType: "production_cycle",
              referenceId: cycle.id,
              createdBy: user.id,
              cache: inventoryCache,
            });
          }
        }
      }

      const nowIso = new Date().toISOString();
      const { error: cycleErr } = await supabase
        .from("production_cycles")
        .update({ status: "completed", completed_at: nowIso })
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
        prev.map((c) =>
          c.id === cycle.id ? { ...c, status: "completed", completed_at: nowIso } : c,
        ),
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

  const handleMarkAsProduced = async (cycle: any) => {
    if (!user) return;
    setError(null);
    setMarkingProducedCycleId(cycle.id);
    try {
      const cycleTargets = targets.filter((t: any) => t.production_cycle === cycle.id);
      if (!cycleTargets.length) {
        setError("No production targets found for this cycle.");
        return;
      }
      const result = await deductRawMaterialsForCycle({
        supabase,
        user,
        cycle,
        cycleTargets,
        noteLabel: "production",
      });
      if (!result.ok) return;
      setCycles((prev) =>
        prev.map((c) =>
          c.id === cycle.id
            ? { ...c, raw_materials_deducted_at: new Date().toISOString() }
            : c,
        ),
      );
    } catch (err: unknown) {
      const msg =
        (err as any)?.message ||
        (err as any)?.error_description ||
        (err as any)?.details ||
        "Failed to mark production as produced.";
      setError(String(msg));
    } finally {
      setMarkingProducedCycleId(null);
    }
  };

  // Deliberately no confirmation dialog here — "Undo Mark as Produced" is
  // itself the safety net for an accidental "Mark as Produced" click, so
  // gating it behind a second confirmation would defeat the point.
  const handleUndoMarkAsProduced = async (cycle: any) => {
    if (!user) return;
    setError(null);
    setUndoingProducedCycleId(cycle.id);
    try {
      const result = await undoRawMaterialDeductionForCycle({ supabase, user, cycle });
      if (!result.ok) return;
      setCycles((prev) =>
        prev.map((c) => (c.id === cycle.id ? { ...c, raw_materials_deducted_at: null } : c)),
      );
    } catch (err: unknown) {
      const msg =
        (err as any)?.message ||
        (err as any)?.error_description ||
        (err as any)?.details ||
        "Failed to undo raw material deduction.";
      setError(String(msg));
    } finally {
      setUndoingProducedCycleId(null);
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

  const openDeleteConfirm = (cycle: any) => {
    const label = cycle.harvest_date
      ? formatDate(cycle.harvest_date)
      : `${formatDate(cycle.start_date)} – ${formatDate(cycle.end_date)}`;
    setDeleteConfirm({ cycleId: cycle.id, cycleLabel: label });
  };

  const openReopenConfirm = async (cycle: any) => {
    setError(null);
    setLoadingReopenCycleId(cycle.id);
    try {
      const isBotaniqals = displayBusinessType(cycle) === "BotanIQals";
      const batchRows = isBotaniqals
        ? batches
            .filter(
              (b: any) =>
                b.production_cycle_id === cycle.id && (Number(b.quantity_produced) || 0) > 0,
            )
            .map((b: any) => ({
              product_id: b.product_id as string,
              quantity_produced: Number(b.quantity_produced) || 0,
            }))
        : [];

      let warnings: ReopenWarning[] = [];
      if (batchRows.length > 0) {
        const productIds = batchRows.map((b) => b.product_id);
        const { data: invRows, error: invErr } = await supabase
          .from("finished_products_inventory")
          .select("product_id, on_hand_qty")
          .in("product_id", productIds);
        if (invErr) throw invErr;
        const onHandByProduct = new Map<string, number>(
          (invRows || []).map((r: any) => [r.product_id, Number(r.on_hand_qty) || 0]),
        );
        warnings = batchRows
          .map((b) => {
            const current = onHandByProduct.get(b.product_id) ?? 0;
            const projectedQty = current - b.quantity_produced;
            if (projectedQty >= 0) return null;
            const productName =
              products.find((p: any) => p.id === b.product_id)?.name ?? "Unknown product";
            return { productId: b.product_id, productName, projectedQty };
          })
          .filter((row): row is ReopenWarning => row !== null);
      }

      setReopenConfirm({ cycle, isBotaniqals, batchRows, warnings });
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to prepare reopen for this cycle.",
      );
    } finally {
      setLoadingReopenCycleId(null);
    }
  };

  const confirmReopen = async () => {
    if (!reopenConfirm || !user) return;
    const { cycle, isBotaniqals, batchRows } = reopenConfirm;
    setReopening(true);
    setError(null);
    try {
      if (isBotaniqals && batchRows.length > 0) {
        const cache = await preloadInventoryCache(supabase);
        for (const batchRow of batchRows) {
          await recordInventoryTransaction(supabase, {
            productId: batchRow.product_id,
            type: "production_reversal",
            quantityDelta: -batchRow.quantity_produced,
            referenceType: "production_cycle",
            referenceId: cycle.id,
            note: "Cycle reopened, reversal of completion",
            createdBy: user.id,
            cache,
          });
        }
      }

      const { error: updateErr } = await supabase
        .from("production_cycles")
        .update({ status: "planned", completed_at: null, finished_goods_applied_at: null })
        .eq("id", cycle.id)
        .eq("user_id", user.id);
      if (updateErr) throw updateErr;

      setCycles((prev) =>
        prev.map((c) =>
          c.id === cycle.id
            ? { ...c, status: "planned", completed_at: null, finished_goods_applied_at: null }
            : c,
        ),
      );
      setReopenConfirm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reopen production cycle.");
    } finally {
      setReopening(false);
    }
  };

  const cycleRows: CycleRow[] = useMemo(() => {
    return cycles.map((cycle: any) => {
      const isMiniLeaf = normalizeBusinessType(cycle, { defaultType: "BotanIQals" }) === "MiniLeaf";
      const cycleTargets = targets.filter((t: any) => t.production_cycle === cycle.id);

      const minileafAggregate = computeMinileafAggregate({
        isMiniLeaf,
        targets: cycleTargets,
        products,
        variants,
        microgreens,
        yieldEntries,
      });
      const feasibility = computeFeasibility({
        cycle,
        isMiniLeaf,
        targets: cycleTargets,
        products,
        bomLines,
        calibration,
        machine,
        minileafAggregate,
      });
      const shortages = computeShortages({
        targets: cycleTargets,
        products,
        bomLines,
        items,
      });
      const shortageCount = shortages.filter((s) => s.shortage > 0).length;

      return {
        cycle,
        isMiniLeaf,
        targetCount: cycleTargets.length,
        feasibility,
        shortageCount,
      };
    });
  }, [cycles, targets, products, variants, microgreens, yieldEntries, bomLines, calibration, machine, items]);

  const inProgressCycleRows = useMemo(() => {
    return cycleRows
      .filter((row) => row.cycle.status !== "completed")
      .sort((a, b) => {
        const at = new Date(a.cycle.created_at ?? 0).getTime();
        const bt = new Date(b.cycle.created_at ?? 0).getTime();
        return bt - at;
      });
  }, [cycleRows]);

  const completedCycleRows = useMemo(() => {
    return cycleRows
      .filter((row) => row.cycle.status === "completed")
      .sort((a, b) => {
        const at = new Date(a.cycle.completed_at ?? a.cycle.created_at ?? 0).getTime();
        const bt = new Date(b.cycle.completed_at ?? b.cycle.created_at ?? 0).getTime();
        return bt - at;
      });
  }, [cycleRows]);

  const inProgressTotalPages = Math.max(1, Math.ceil(inProgressCycleRows.length / PAGE_SIZE));
  const completedTotalPages = Math.max(1, Math.ceil(completedCycleRows.length / PAGE_SIZE));
  const safeInProgressPage = Math.min(inProgressPage, inProgressTotalPages);
  const safeCompletedPage = Math.min(completedPage, completedTotalPages);

  const inProgressPageRows = inProgressCycleRows.slice(
    (safeInProgressPage - 1) * PAGE_SIZE,
    safeInProgressPage * PAGE_SIZE,
  );
  const completedPageRows = completedCycleRows.slice(
    (safeCompletedPage - 1) * PAGE_SIZE,
    safeCompletedPage * PAGE_SIZE,
  );

  // Latest batch_compliance_reviews row per cycle — rows are append-only
  // (a new one per completion/re-completion attempt), so the first match
  // in this desc-by-created_at list is the latest.
  const latestReviewByCycleId = new Map<string, any>();
  for (const review of batchComplianceReviews) {
    if (!latestReviewByCycleId.has(review.production_cycle_id)) {
      latestReviewByCycleId.set(review.production_cycle_id, review);
    }
  }

  const batchDetailRows = batches
    .filter((batch: any) => {
      const cycle = cycles.find((cycleRow: any) => cycleRow.id === batch.production_cycle_id);
      return cycle && displayBusinessType(cycle) === "BotanIQals";
    })
    .map((batch: any) => {
      const cycle = cycles.find((cycleRow: any) => cycleRow.id === batch.production_cycle_id);
      const product = products.find((productRow: any) => productRow.id === batch.product_id);
      const review = latestReviewByCycleId.get(batch.production_cycle_id);
      const warningCount = Array.isArray(review?.warnings) ? review.warnings.length : 0;
      const complianceLabel = !review ? "—" : warningCount === 0 ? "Clear" : `Acknowledged (${warningCount})`;
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
        complianceLabel,
      };
    })
    .filter((row) => row.quantity > 0);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
              Production Cycles & Planner
            </h1>
            <p className="text-sm text-zinc-600">
              Define production windows and navigate to detailed planners for
              feasibility, shortages, and tray plans.
            </p>
          </div>
          <Link
            href="/production-optimization"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            Run BotanIQals Optimization
          </Link>
        </header>

        <section className="max-w-xl rounded-md border border-zinc-200 bg-white p-4 text-xs">
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
                <option value="MiniLeaf">MiniLeaf</option>
                <option value="BotanIQals">BotanIQals</option>
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
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">
            Existing Cycles
          </h2>

          <div className="mb-3 flex gap-1 border-b border-zinc-200">
            <button
              type="button"
              onClick={() => setActiveTab("in_progress")}
              className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium ${
                activeTab === "in_progress"
                  ? "border-emerald-600 text-emerald-700"
                  : "border-transparent text-zinc-600 hover:text-zinc-900"
              }`}
            >
              In Progress ({inProgressCycleRows.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("completed")}
              className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium ${
                activeTab === "completed"
                  ? "border-emerald-600 text-emerald-700"
                  : "border-transparent text-zinc-600 hover:text-zinc-900"
              }`}
            >
              Completed ({completedCycleRows.length})
            </button>
          </div>

          {isLoading ? (
            <p className="text-xs text-black">Loading cycles…</p>
          ) : activeTab === "in_progress" ? (
            inProgressCycleRows.length === 0 ? (
              <p className="text-xs text-black">
                No cycles in progress. Create a cycle to begin planning
                feasibility and tray runs.
              </p>
            ) : (
              <>
                <CyclesTable
                  rows={inProgressPageRows}
                  tab="in_progress"
                  onOpenActions={(cycle) => setActionsFor({ cycle, tab: "in_progress" })}
                />
                <PaginationControls
                  page={safeInProgressPage}
                  totalItems={inProgressCycleRows.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={setInProgressPage}
                />
              </>
            )
          ) : completedCycleRows.length === 0 ? (
            <p className="text-xs text-black">No completed cycles yet.</p>
          ) : (
            <>
              <CyclesTable
                rows={completedPageRows}
                tab="completed"
                onOpenActions={(cycle) => setActionsFor({ cycle, tab: "completed" })}
              />
              <PaginationControls
                page={safeCompletedPage}
                totalItems={completedCycleRows.length}
                pageSize={PAGE_SIZE}
                onPageChange={setCompletedPage}
              />
            </>
          )}
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
                    <th className="px-2 py-1 font-medium">Compliance</th>
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
                      <td className="px-2 py-1">
                        <span
                          className={
                            row.complianceLabel === "Clear"
                              ? "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800"
                              : row.complianceLabel === "—"
                                ? "text-zinc-400"
                                : "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                          }
                        >
                          {row.complianceLabel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {complianceCheck && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Compliance Check</h2>
              <p className="mt-1 text-xs text-zinc-600">{complianceCheck.draft.cycleLabel}</p>

              <div className="mt-3 space-y-3">
                {complianceCheck.loading ? (
                  <p className="text-xs text-black">Checking compliance logs…</p>
                ) : complianceCheck.loadError ? (
                  <p className="text-xs text-red-600" role="alert">
                    {complianceCheck.loadError}
                  </p>
                ) : complianceCheck.warnings && complianceCheck.warnings.length === 0 ? (
                  <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
                    Clear — no compliance warnings for this cycle.
                  </p>
                ) : complianceCheck.warnings ? (
                  <>
                    <p className="text-sm font-semibold text-amber-800">
                      Warnings ({complianceCheck.warnings.length})
                    </p>
                    <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                      {complianceCheck.warnings.map((w) => (
                        <li key={w.key}>• {w.message}</li>
                      ))}
                    </ul>
                    <p className="text-xs text-zinc-600">
                      This doesn&rsquo;t block completion — acknowledge it to continue.
                    </p>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-800">Acknowledged by</label>
                      <select
                        value={complianceCheck.acknowledgedByEmployeeId}
                        onChange={(e) =>
                          setComplianceCheck((prev) => (prev ? { ...prev, acknowledgedByEmployeeId: e.target.value } : prev))
                        }
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm"
                      >
                        <option value="">Select…</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.full_name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-800">Note</label>
                      <textarea
                        value={complianceCheck.acknowledgedNote}
                        onChange={(e) =>
                          setComplianceCheck((prev) => (prev ? { ...prev, acknowledgedNote: e.target.value } : prev))
                        }
                        rows={2}
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm"
                      />
                    </div>
                  </>
                ) : null}

                {complianceCheck.saveError && (
                  <p className="text-xs text-red-600" role="alert">
                    {complianceCheck.saveError}
                  </p>
                )}
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setComplianceCheck(null)}
                  disabled={complianceCheck.saving}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleContinueFromComplianceCheck}
                  disabled={complianceCheck.loading || !!complianceCheck.loadError || complianceCheck.saving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {complianceCheck.saving ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
          </div>
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

        {actionsFor && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setActionsFor(null)}
          >
            <div
              className="w-full max-w-xs rounded-md border border-zinc-200 bg-white p-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-black">
                  Cycle {String(actionsFor.cycle.id).slice(0, 8)}
                </h2>
                <button
                  type="button"
                  onClick={() => setActionsFor(null)}
                  aria-label="Close"
                  className="text-zinc-500 hover:text-zinc-700"
                >
                  ✕
                </button>
              </div>
              <div className="space-y-1">
                <Link
                  href={`/cycles/${actionsFor.cycle.id}/plan`}
                  onClick={() => setActionsFor(null)}
                  className="block rounded-md px-3 py-2 text-sm font-medium text-black hover:bg-zinc-50"
                >
                  Open Planner
                </Link>
                {actionsFor.tab === "in_progress" && (
                  <>
                    {actionsFor.cycle.raw_materials_deducted_at ? (
                      <button
                        type="button"
                        disabled={undoingProducedCycleId === actionsFor.cycle.id}
                        onClick={() => {
                          handleUndoMarkAsProduced(actionsFor.cycle);
                          setActionsFor(null);
                        }}
                        className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-black hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {undoingProducedCycleId === actionsFor.cycle.id
                          ? "Undoing…"
                          : "Undo Mark as Produced"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={markingProducedCycleId === actionsFor.cycle.id}
                        onClick={() => {
                          handleMarkAsProduced(actionsFor.cycle);
                          setActionsFor(null);
                        }}
                        className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-black hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {markingProducedCycleId === actionsFor.cycle.id
                          ? "Marking…"
                          : "Mark as Produced"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={completingCycleId === actionsFor.cycle.id}
                      onClick={() => {
                        beginCompleteProduction(actionsFor.cycle);
                        setActionsFor(null);
                      }}
                      className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-black hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {completingCycleId === actionsFor.cycle.id
                        ? "Completing…"
                        : "Complete Production"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        openDeleteConfirm(actionsFor.cycle);
                        setActionsFor(null);
                      }}
                      className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-red-600 hover:bg-zinc-50"
                    >
                      Delete
                    </button>
                  </>
                )}
                {actionsFor.tab === "completed" && (
                  <button
                    type="button"
                    disabled={loadingReopenCycleId === actionsFor.cycle.id}
                    onClick={() => {
                      openReopenConfirm(actionsFor.cycle);
                      setActionsFor(null);
                    }}
                    className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-black hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingReopenCycleId === actionsFor.cycle.id ? "Loading…" : "Reopen Production"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {deleteConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setDeleteConfirm(null)}
          >
            <div
              className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-sm font-semibold text-zinc-900">
                Delete this production cycle?
              </h2>
              <p className="mt-2 text-xs text-zinc-700">
                You&apos;re about to permanently delete cycle {deleteConfirm.cycleLabel},
                including its targets and planner data. This can&apos;t be undone.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(null)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Keep Cycle
                </button>
                <button
                  type="button"
                  disabled={deletingCycleId === deleteConfirm.cycleId}
                  onClick={confirmDelete}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {deletingCycleId === deleteConfirm.cycleId ? "Deleting…" : "Delete Cycle"}
                </button>
              </div>
            </div>
          </div>
        )}

        {reopenConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setReopenConfirm(null)}
          >
            <div
              className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-sm font-semibold text-zinc-900">
                Reopen this production cycle?
              </h2>
              <p className="mt-2 text-xs text-zinc-700">
                Cycle {String(reopenConfirm.cycle.id).slice(0, 8)} will move back to In
                Progress. Any finished products it added to inventory will be reversed,
                and you&apos;ll enter actuals again when you complete it.
              </p>
              {reopenConfirm.isBotaniqals && (
                <p className="mt-2 text-[11px] text-zinc-600">
                  The Google Sheet row from the original completion will not be removed
                  automatically.
                </p>
              )}
              {reopenConfirm.warnings.length > 0 && (
                <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
                  <p className="font-medium">
                    This will take on-hand inventory negative for:
                  </p>
                  <ul className="mt-1 list-disc pl-4">
                    {reopenConfirm.warnings.map((w) => (
                      <li key={w.productId}>
                        {w.productName}: projected {w.projectedQty}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">Fix the count with a cycle count afterward.</p>
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReopenConfirm(null)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Keep Completed
                </button>
                <button
                  type="button"
                  disabled={reopening}
                  onClick={confirmReopen}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {reopening ? "Reopening…" : "Reopen Cycle"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}

function PaginationControls({
  page,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (totalItems <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-600">
      <span>
        Showing {start}-{end} of {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPageChange(p)}
            className={`rounded-md px-2 py-1 font-medium ${
              p === page
                ? "bg-emerald-600 text-white"
                : "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
            }`}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function CyclesTable({
  rows,
  tab,
  onOpenActions,
}: {
  rows: CycleRow[];
  tab: TabKey;
  onOpenActions: (cycle: any) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Actions</th>
            <th className="px-3 py-2 font-medium">Production Cycle</th>
            <th className="px-3 py-2 font-medium">Start Date</th>
            <th className="px-3 py-2 font-medium">End Date</th>
            <th className="px-3 py-2 font-medium">Feasibility Status</th>
            <th className="px-3 py-2 font-medium">Business</th>
            <th className="px-3 py-2 font-medium">Targets / Shortages</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ cycle, isMiniLeaf, targetCount, feasibility, shortageCount }) => {
            const badge = feasibilityBadge(feasibility);
            const isProduced = Boolean(cycle.raw_materials_deducted_at);
            return (
              <tr key={cycle.id} className="border-b border-zinc-100">
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onOpenActions(cycle)}
                    className="inline-flex items-center rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-black shadow-sm hover:bg-zinc-50"
                  >
                    Actions
                  </button>
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/cycles/${cycle.id}/plan`}
                    title={cycle.id}
                    className="inline-flex items-center rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-zinc-800"
                  >
                    {String(cycle.id).slice(0, 8)}
                  </Link>
                  {tab === "in_progress" && isProduced && (
                    <div className="mt-1">
                      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                        Produced
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-700">{formatDate(cycle.start_date)}</td>
                <td className="px-3 py-2 text-zinc-700">{formatDate(cycle.end_date)}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-700">
                  {isMiniLeaf ? "MiniLeaf" : "BotanIQals"}
                </td>
                <td className="px-3 py-2 text-zinc-700">
                  {targetCount} target{targetCount === 1 ? "" : "s"}
                  {shortageCount > 0 && (
                    <span className="ml-2 inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800">
                      {shortageCount} shortage{shortageCount === 1 ? "" : "s"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
