"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import {
  buildBomSyncPlan,
  computeFormulaCost,
  computeMargin,
  diffFormulationLines,
  nextVersionNumber,
  type BomLineLite,
  type FormulationLineRow,
  type FormulationLineType,
  type FormulationProductRow,
  type FormulationRow,
  type InventoryItemLite,
  type TestBatchRow,
} from "@/lib/formulation";

type EditableLine = {
  id?: string;
  line_type: FormulationLineType;
  raw_material_id: string;
  qty_per_unit: number | "";
  reason: string;
};

type NewItemForm = {
  name: string;
  unit: string;
  cost_per_unit: number | "";
  quantity_on_hand: number | "";
  par_level: number | "";
};

export default function FormulationDetailPage() {
  const params = useParams<{ id: string }>();
  const { user, supabase } = useSupabase();
  const formulationProductId = params.id;

  const [fp, setFp] = useState<FormulationProductRow | null>(null);
  const [formulations, setFormulations] = useState<FormulationRow[]>([]);
  const [linesByFormulationId, setLinesByFormulationId] = useState<Record<string, FormulationLineRow[]>>({});
  const [testBatches, setTestBatches] = useState<TestBatchRow[]>([]);
  const [items, setItems] = useState<InventoryItemLite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedFormulationId, setSelectedFormulationId] = useState<string>("");
  const [editLines, setEditLines] = useState<EditableLine[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [newItemFor, setNewItemFor] = useState<number | null>(null);
  const [newItemForm, setNewItemForm] = useState<NewItemForm>({
    name: "",
    unit: "",
    cost_per_unit: "",
    quantity_on_hand: 0,
    par_level: "",
  });
  const [newItemError, setNewItemError] = useState<string | null>(null);
  const [newItemSaving, setNewItemSaving] = useState(false);

  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const [startingIteration, setStartingIteration] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);

  const [batchForm, setBatchForm] = useState({ batch_date: new Date().toISOString().slice(0, 10), batch_size: "", observations: "", outcome: "" as "" | "pass" | "needs_changes" | "fail" });
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setLoadError(null);
    const [fpRes, formulationsRes, itemsRes] = await Promise.all([
      supabase.from("formulation_products").select("*").eq("id", formulationProductId).maybeSingle(),
      supabase
        .from("formulations")
        .select("*")
        .eq("formulation_product_id", formulationProductId)
        .order("version_number", { ascending: false }),
      supabase.from("inventory_items").select("id, name, unit, cost_per_unit"),
    ]);
    if (fpRes.error || formulationsRes.error || itemsRes.error) {
      setLoadError([fpRes.error?.message, formulationsRes.error?.message, itemsRes.error?.message].filter(Boolean).join(" | "));
      setIsLoading(false);
      return;
    }
    const formulationRows = (formulationsRes.data || []) as FormulationRow[];
    setFp(fpRes.data as FormulationProductRow);
    setFormulations(formulationRows);
    setItems((itemsRes.data || []) as InventoryItemLite[]);

    const formulationIds = formulationRows.map((f) => f.id);
    if (formulationIds.length > 0) {
      const [linesRes, batchesRes] = await Promise.all([
        supabase.from("formulation_lines").select("*").in("formulation_id", formulationIds).order("sort_order", { ascending: true }),
        supabase.from("test_batches").select("*").in("formulation_id", formulationIds).order("batch_date", { ascending: false }),
      ]);
      const grouped: Record<string, FormulationLineRow[]> = {};
      for (const line of (linesRes.data || []) as FormulationLineRow[]) {
        (grouped[line.formulation_id] ??= []).push(line);
      }
      setLinesByFormulationId(grouped);
      setTestBatches((batchesRes.data || []) as TestBatchRow[]);
    } else {
      setLinesByFormulationId({});
      setTestBatches([]);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    if (!user || !formulationProductId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, formulationProductId]);

  useEffect(() => {
    if (formulations.length > 0 && !selectedFormulationId) {
      setSelectedFormulationId(formulations[0].id);
    }
  }, [formulations, selectedFormulationId]);

  const selected = formulations.find((f) => f.id === selectedFormulationId) || null;
  const selectedLines = selected ? linesByFormulationId[selected.id] || [] : [];
  const draft = formulations.find((f) => f.status === "draft") || null;
  const previousVersion = selected
    ? formulations.find((f) => f.version_number === selected.version_number - 1) || null
    : null;

  // Keep the editable-lines scratch state in sync whenever the selected
  // (draft) version's saved lines change underneath it.
  useEffect(() => {
    if (selected?.status === "draft") {
      setEditLines(
        selectedLines.map((l) => ({
          id: l.id,
          line_type: l.line_type,
          raw_material_id: l.raw_material_id,
          qty_per_unit: l.qty_per_unit,
          reason: l.reason || "",
        })),
      );
    }
  }, [selected?.id, selected?.status, JSON.stringify(selectedLines)]);

  const assumedSalePrice = fp?.product_id ? null : fp?.draft_sale_price_per_unit ?? null;
  const cost = useMemo(
    () => computeFormulaCost(selected?.status === "draft" ? editLines : selectedLines, items),
    [selected, editLines, selectedLines, items],
  );
  const margin = useMemo(() => computeMargin(cost, assumedSalePrice), [cost, assumedSalePrice]);

  const diffEntries = useMemo(() => {
    if (!selected || !previousVersion) return [];
    return diffFormulationLines(linesByFormulationId[previousVersion.id] || [], selectedLines, items);
  }, [selected, previousVersion, linesByFormulationId, selectedLines, items]);

  const updateEditLine = (idx: number, patch: Partial<EditableLine>) =>
    setEditLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const addEditLine = () => setEditLines((prev) => [...prev, { line_type: "inventory_item", raw_material_id: "", qty_per_unit: "", reason: "" }]);
  const removeEditLine = (idx: number) => setEditLines((prev) => prev.filter((_, i) => i !== idx));

  const handleSaveDraft = async () => {
    if (!draft) return;
    setSavingDraft(true);
    setActionError(null);
    try {
      const realLines = editLines.filter((l) => l.raw_material_id);
      for (const l of realLines) {
        const qty = Number(l.qty_per_unit);
        if (!l.qty_per_unit || !Number.isFinite(qty) || qty <= 0) {
          throw new Error("Every formula line needs a positive quantity.");
        }
      }
      // Replace-in-place for the draft's own lines table (nothing else in
      // the app reads formulation_lines, so a delete+reinsert here is
      // safe — this is not the bom_lines sync, which preserves rows).
      const { error: deleteError } = await supabase.from("formulation_lines").delete().eq("formulation_id", draft.id);
      if (deleteError) throw deleteError;
      if (realLines.length > 0) {
        const { error: insertError } = await supabase.from("formulation_lines").insert(
          realLines.map((l, idx) => ({
            formulation_id: draft.id,
            line_type: l.line_type,
            raw_material_id: l.raw_material_id,
            qty_per_unit: Number(l.qty_per_unit),
            reason: l.reason.trim() || null,
            sort_order: idx,
          })),
        );
        if (insertError) throw insertError;
      }
      await load();
    } catch (err: any) {
      setActionError(err.message || "Failed to save draft.");
    } finally {
      setSavingDraft(false);
    }
  };

  const openNewItemModal = (idx: number) => {
    setNewItemFor(idx);
    setNewItemError(null);
    setNewItemForm({ name: "", unit: "", cost_per_unit: "", quantity_on_hand: 0, par_level: "" });
  };

  const handleCreateItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || newItemFor == null) return;
    setNewItemSaving(true);
    setNewItemError(null);
    try {
      const duplicate = items.find((it) => it.name.trim().toLowerCase() === newItemForm.name.trim().toLowerCase());
      if (duplicate) {
        setNewItemError("An inventory item with this name already exists.");
        setNewItemSaving(false);
        return;
      }
      const { data, error } = await supabase
        .from("inventory_items")
        .insert({
          name: newItemForm.name.trim(),
          unit: newItemForm.unit.trim(),
          cost_per_unit: Number(newItemForm.cost_per_unit || 0),
          quantity_on_hand: Number(newItemForm.quantity_on_hand || 0),
          par_level: newItemForm.par_level === "" ? null : Number(newItemForm.par_level),
          last_count_date: null,
          user_id: user.id,
        })
        .select("id, name, unit, cost_per_unit")
        .single();
      if (error) throw error;
      setItems((prev) => [...prev, data as InventoryItemLite].sort((a, b) => a.name.localeCompare(b.name)));
      updateEditLine(newItemFor, { raw_material_id: data.id });
      setNewItemFor(null);
    } catch (err: any) {
      setNewItemError(err.message || "Failed to create inventory item.");
    } finally {
      setNewItemSaving(false);
    }
  };

  const handleStartNewIteration = async () => {
    if (!fp || draft) return;
    setStartingIteration(true);
    setActionError(null);
    try {
      const base = selected || formulations[0];
      const version_number = nextVersionNumber(formulations);
      const { data: newFormulation, error } = await supabase
        .from("formulations")
        .insert({
          formulation_product_id: fp.id,
          version_number,
          status: "draft",
          source: "new",
        })
        .select("id")
        .single();
      if (error) throw error;
      const baseLines = base ? linesByFormulationId[base.id] || [] : [];
      if (baseLines.length > 0) {
        const { error: linesError } = await supabase.from("formulation_lines").insert(
          baseLines.map((l, idx) => ({
            formulation_id: newFormulation.id,
            line_type: l.line_type,
            raw_material_id: l.raw_material_id,
            qty_per_unit: l.qty_per_unit,
            reason: l.reason,
            sort_order: idx,
          })),
        );
        if (linesError) throw linesError;
      }
      await load();
      setSelectedFormulationId(newFormulation.id);
    } catch (err: any) {
      setActionError(err.message || "Failed to start a new iteration.");
    } finally {
      setStartingIteration(false);
    }
  };

  const handleRestoreAsNewIteration = async (sourceVersion: FormulationRow) => {
    if (!fp || draft) return;
    setRestoringVersionId(sourceVersion.id);
    setActionError(null);
    try {
      const version_number = nextVersionNumber(formulations);
      const { data: newFormulation, error } = await supabase
        .from("formulations")
        .insert({
          formulation_product_id: fp.id,
          version_number,
          status: "draft",
          source: "restored_from_version",
          change_summary: `Restored from v${sourceVersion.version_number}.`,
        })
        .select("id")
        .single();
      if (error) throw error;
      const sourceLines = linesByFormulationId[sourceVersion.id] || [];
      if (sourceLines.length > 0) {
        const { error: linesError } = await supabase.from("formulation_lines").insert(
          sourceLines.map((l, idx) => ({
            formulation_id: newFormulation.id,
            line_type: l.line_type,
            raw_material_id: l.raw_material_id,
            qty_per_unit: l.qty_per_unit,
            reason: l.reason,
            sort_order: idx,
          })),
        );
        if (linesError) throw linesError;
      }
      await load();
      setSelectedFormulationId(newFormulation.id);
    } catch (err: any) {
      setActionError(err.message || "Failed to restore this version.");
    } finally {
      setRestoringVersionId(null);
    }
  };

  const handleDiscardDraft = async () => {
    if (!draft) return;
    setDiscarding(true);
    setActionError(null);
    try {
      const { error } = await supabase.from("formulations").delete().eq("id", draft.id);
      if (error) throw error;
      setDiscardConfirmOpen(false);
      setSelectedFormulationId("");
      await load();
    } catch (err: any) {
      setActionError(err.message || "Failed to discard this draft.");
    } finally {
      setDiscarding(false);
    }
  };

  const handleFinishIteration = async () => {
    if (!fp || !draft || !user) return;
    setFinishing(true);
    setFinishError(null);
    try {
      const realLines = editLines.filter((l) => l.raw_material_id);
      if (realLines.length === 0) throw new Error("Add at least one formula line before finishing.");
      for (const l of realLines) {
        const qty = Number(l.qty_per_unit);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error("Every formula line needs a positive quantity.");
      }

      let productId = fp.product_id;
      if (!productId) {
        const { data: newProduct, error: productError } = await supabase
          .from("products")
          .insert({
            name: fp.name,
            unit: fp.draft_unit || "unit",
            is_microgreen: false,
            microgreen: null,
            sale_price_per_unit: fp.draft_sale_price_per_unit ?? 0,
            shelf_life_days: fp.draft_shelf_life_days,
            notes: fp.draft_notes,
            target_batch_size: fp.draft_target_batch_size,
            target_batch_unit: fp.draft_target_batch_unit,
            user_id: user.id,
          })
          .select("id")
          .single();
        if (productError) throw productError;
        productId = newProduct.id;
      }
      if (!productId) throw new Error("Failed to resolve a product id.");

      const { data: existingBomLines, error: bomLoadError } = await supabase
        .from("bom_lines")
        .select("id, product, line_type, inventory_item, qty_per_unit, unit_label, sale_price, material_name_snapshot, notes")
        .eq("product", productId);
      if (bomLoadError) throw bomLoadError;

      const plan = buildBomSyncPlan(
        productId,
        (existingBomLines || []) as BomLineLite[],
        realLines.map((l) => ({ line_type: l.line_type, raw_material_id: l.raw_material_id, qty_per_unit: Number(l.qty_per_unit), reason: l.reason || null })),
        items,
        user.id,
      );

      if (plan.toInsert.length > 0) {
        const { error } = await supabase.from("bom_lines").insert(plan.toInsert);
        if (error) throw error;
      }
      for (const u of plan.toUpdate) {
        const { error } = await supabase.from("bom_lines").update(u.payload).eq("id", u.id);
        if (error) throw error;
      }
      if (plan.toDeleteIds.length > 0) {
        const { error } = await supabase.from("bom_lines").delete().in("id", plan.toDeleteIds);
        if (error) throw error;
      }

      const nowIso = new Date().toISOString();
      const { error: formulationUpdateError } = await supabase
        .from("formulations")
        .update({ status: "final", finalized_at: nowIso, finalized_by: user.id })
        .eq("id", draft.id);
      if (formulationUpdateError) throw formulationUpdateError;

      const { error: fpUpdateError } = await supabase
        .from("formulation_products")
        .update({ status: "active", product_id: productId })
        .eq("id", fp.id);
      if (fpUpdateError) throw fpUpdateError;

      setFinishConfirmOpen(false);
      await load();
    } catch (err: any) {
      setFinishError(
        (err.message || "Failed to finish this iteration.") +
          " Products & BOM may be partially updated for this product — check it there before retrying.",
      );
    } finally {
      setFinishing(false);
    }
  };

  const handleLogBatch = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBatchSaving(true);
    setBatchError(null);
    try {
      const { error } = await supabase.from("test_batches").insert({
        formulation_id: selected.id,
        batch_date: batchForm.batch_date,
        batch_size: batchForm.batch_size.trim() || null,
        observations: batchForm.observations.trim() || null,
        outcome: batchForm.outcome || null,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
      setBatchForm({ batch_date: new Date().toISOString().slice(0, 10), batch_size: "", observations: "", outcome: "" });
      await load();
    } catch (err: any) {
      setBatchError(err.message || "Failed to log test batch.");
    } finally {
      setBatchSaving(false);
    }
  };

  if (isLoading) {
    return (
      <AuthGuard>
        <p className="text-xs text-black">Loading…</p>
      </AuthGuard>
    );
  }

  if (loadError || !fp) {
    return (
      <AuthGuard>
        <p className="text-xs text-red-600" role="alert">
          {loadError || "Formulation product not found."}
        </p>
      </AuthGuard>
    );
  }

  const selectedTestBatches = selected ? testBatches.filter((b) => b.formulation_id === selected.id) : [];

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">{fp.name}</h1>
            <p className="text-xs text-black">
              {fp.status === "active" ? "Active in production" : "In development"}
              {fp.product_id && (
                <>
                  {" · "}
                  <Link href="/products" className="text-emerald-700 underline">
                    View in Products & BOM
                  </Link>
                </>
              )}
            </p>
          </div>
          <Link href="/formulation" className="text-xs text-black underline">
            ← All formulations
          </Link>
        </header>

        {actionError && (
          <p className="text-xs text-red-600" role="alert">
            {actionError}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <div className="rounded-md border border-zinc-200 bg-white p-3 text-xs">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">Versions</h2>
            <div className="space-y-1">
              {formulations.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedFormulationId(f.id)}
                  className={`block w-full rounded px-2 py-1.5 text-left ${
                    selectedFormulationId === f.id ? "border border-emerald-500 bg-emerald-50" : "border border-zinc-100 bg-zinc-50"
                  }`}
                >
                  <div className="font-medium text-zinc-900">v{f.version_number}</div>
                  <div className="text-[10px] text-black">
                    {f.status === "draft" ? "Draft" : "Final"} · {f.source.replace("_", " ")}
                  </div>
                </button>
              ))}
            </div>
            {!draft && (
              <button
                type="button"
                onClick={handleStartNewIteration}
                disabled={startingIteration}
                className="mt-3 w-full rounded-md bg-emerald-600 px-2 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
              >
                {startingIteration ? "Starting…" : "Start New Iteration"}
              </button>
            )}
          </div>

          <div className="space-y-4">
            {selected && (
              <>
                <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-zinc-900">
                      v{selected.version_number} — {selected.status === "draft" ? "Draft" : "Final"}
                    </h2>
                    {selected.status === "final" && selected.id !== formulations[0]?.id && !draft && (
                      <button
                        type="button"
                        onClick={() => handleRestoreAsNewIteration(selected)}
                        disabled={restoringVersionId === selected.id}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-black hover:bg-zinc-50 disabled:opacity-70"
                      >
                        {restoringVersionId === selected.id ? "Restoring…" : "Restore as new iteration"}
                      </button>
                    )}
                  </div>
                  {selected.goal_notes && <p className="mb-1 text-[11px] text-black">Goal: {selected.goal_notes}</p>}
                  {selected.change_summary && <p className="mb-2 text-[11px] text-black">{selected.change_summary}</p>}

                  {selected.status === "draft" ? (
                    <>
                      <div className="space-y-2">
                        {editLines.map((line, idx) => {
                          const item = items.find((i) => i.id === line.raw_material_id);
                          return (
                            <div key={idx} className="grid gap-2 rounded-md bg-zinc-50 p-2 sm:grid-cols-[110px_1fr_120px_1fr_auto]">
                              <select
                                value={line.line_type}
                                onChange={(e) => updateEditLine(idx, { line_type: e.target.value as FormulationLineType })}
                                className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                              >
                                <option value="inventory_item">Ingredient</option>
                                <option value="packaging">Packaging</option>
                              </select>
                              <select
                                value={line.raw_material_id}
                                onChange={(e) => {
                                  if (e.target.value === "__new__") {
                                    openNewItemModal(idx);
                                    return;
                                  }
                                  updateEditLine(idx, { raw_material_id: e.target.value });
                                }}
                                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                              >
                                <option value="">Select raw material…</option>
                                {items.map((i) => (
                                  <option key={i.id} value={i.id}>
                                    {i.name} ({i.unit})
                                  </option>
                                ))}
                                <option value="__new__">+ New raw material…</option>
                              </select>
                              <input
                                type="number"
                                step="0.0001"
                                placeholder={item ? `Qty per unit (${item.unit})` : "Qty per unit"}
                                value={line.qty_per_unit}
                                onChange={(e) => updateEditLine(idx, { qty_per_unit: e.target.value === "" ? "" : Number(e.target.value) })}
                                className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                              />
                              <input
                                type="text"
                                placeholder="Reason / notes (optional)"
                                value={line.reason}
                                onChange={(e) => updateEditLine(idx, { reason: e.target.value })}
                                className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                              />
                              <button
                                type="button"
                                onClick={() => removeEditLine(idx)}
                                className="rounded-md px-2 text-[11px] text-red-600 underline"
                              >
                                Remove
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={addEditLine}
                        className="mt-2 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-black hover:bg-zinc-50"
                      >
                        Add line
                      </button>

                      <div className="mt-3 flex items-center justify-between rounded-md bg-zinc-50 p-2 text-[11px] text-black">
                        <span>Cost per unit: ${cost.toFixed(4)}</span>
                        {margin.salePrice != null && (
                          <span>
                            Margin: ${margin.margin!.toFixed(2)} ({margin.marginPct!.toFixed(1)}%)
                          </span>
                        )}
                      </div>

                      {finishError && (
                        <p className="mt-2 text-[11px] text-red-600" role="alert">
                          {finishError}
                        </p>
                      )}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSaveDraft}
                          disabled={savingDraft}
                          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[11px] font-medium text-black hover:bg-zinc-50 disabled:opacity-70"
                        >
                          {savingDraft ? "Saving…" : "Save draft"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setFinishConfirmOpen(true)}
                          className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700"
                        >
                          Finish Iteration
                        </button>
                        <button
                          type="button"
                          onClick={() => setDiscardConfirmOpen(true)}
                          className="rounded-md px-3 py-1.5 text-[11px] font-medium text-red-600 underline"
                        >
                          Discard draft
                        </button>
                      </div>
                    </>
                  ) : (
                    <table className="min-w-full border-collapse text-left">
                      <thead className="bg-zinc-50 text-[11px] text-black">
                        <tr>
                          <th className="px-2 py-1 font-medium">Material</th>
                          <th className="px-2 py-1 font-medium">Type</th>
                          <th className="px-2 py-1 font-medium">Qty / unit</th>
                          <th className="px-2 py-1 font-medium">Unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedLines.map((l) => {
                          const item = items.find((i) => i.id === l.raw_material_id);
                          return (
                            <tr key={l.id} className="border-b text-[11px] text-black">
                              <td className="px-2 py-1">{item?.name ?? "Unknown material"}</td>
                              <td className="px-2 py-1">{l.line_type === "packaging" ? "Packaging" : "Ingredient"}</td>
                              <td className="px-2 py-1">{l.qty_per_unit}</td>
                              <td className="px-2 py-1">{item?.unit ?? "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </section>

                {previousVersion && diffEntries.some((d) => d.change !== "unchanged") && (
                  <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
                    <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                      Changes vs. v{previousVersion.version_number}
                    </h2>
                    <ul className="space-y-1">
                      {diffEntries
                        .filter((d) => d.change !== "unchanged")
                        .map((d) => (
                          <li key={d.key} className="text-[11px] text-black">
                            {d.change === "added" && (
                              <span className="text-emerald-700">+ Added {d.itemName}: {d.currentQty} {d.unit}</span>
                            )}
                            {d.change === "removed" && (
                              <span className="text-red-600">− Removed {d.itemName} (was {d.previousQty} {d.unit})</span>
                            )}
                            {d.change === "changed" && (
                              <span>
                                ~ {d.itemName}: {d.previousQty} → {d.currentQty} {d.unit}
                              </span>
                            )}
                          </li>
                        ))}
                    </ul>
                  </section>
                )}

                <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
                  <h2 className="mb-2 text-sm font-semibold text-zinc-900">Test batches for v{selected.version_number}</h2>
                  {selectedTestBatches.length > 0 ? (
                    <table className="mb-3 min-w-full border-collapse text-left">
                      <thead className="bg-zinc-50 text-[11px] text-black">
                        <tr>
                          <th className="px-2 py-1 font-medium">Date</th>
                          <th className="px-2 py-1 font-medium">Batch size</th>
                          <th className="px-2 py-1 font-medium">Outcome</th>
                          <th className="px-2 py-1 font-medium">Observations</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedTestBatches.map((b) => (
                          <tr key={b.id} className="border-b text-[11px] text-black">
                            <td className="px-2 py-1">{b.batch_date}</td>
                            <td className="px-2 py-1">{b.batch_size ?? "—"}</td>
                            <td className="px-2 py-1">{b.outcome ?? "—"}</td>
                            <td className="px-2 py-1">{b.observations ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="mb-3 text-[11px] text-black">No test batches logged for this version yet.</p>
                  )}
                  <form onSubmit={handleLogBatch} className="grid gap-2 rounded-md bg-zinc-50 p-3 sm:grid-cols-4">
                    <input
                      type="date"
                      required
                      value={batchForm.batch_date}
                      onChange={(e) => setBatchForm({ ...batchForm, batch_date: e.target.value })}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                    />
                    <input
                      type="text"
                      placeholder="Batch size"
                      value={batchForm.batch_size}
                      onChange={(e) => setBatchForm({ ...batchForm, batch_size: e.target.value })}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                    />
                    <select
                      value={batchForm.outcome}
                      onChange={(e) => setBatchForm({ ...batchForm, outcome: e.target.value as any })}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                    >
                      <option value="">Outcome (optional)</option>
                      <option value="pass">Pass</option>
                      <option value="needs_changes">Needs changes</option>
                      <option value="fail">Fail</option>
                    </select>
                    <button
                      type="submit"
                      disabled={batchSaving}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
                    >
                      {batchSaving ? "Logging…" : "Log batch"}
                    </button>
                    <textarea
                      placeholder="Observations (optional)"
                      value={batchForm.observations}
                      onChange={(e) => setBatchForm({ ...batchForm, observations: e.target.value })}
                      className="sm:col-span-4 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                      rows={2}
                    />
                  </form>
                  {batchError && (
                    <p className="mt-2 text-[11px] text-red-600" role="alert">
                      {batchError}
                    </p>
                  )}
                </section>
              </>
            )}
          </div>
        </div>

        {finishConfirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-md rounded-md bg-white p-4 shadow-lg">
              <h3 className="mb-2 text-sm font-semibold text-zinc-900">Finish this iteration?</h3>
              <p className="mb-2 text-xs text-black">
                {fp.product_id
                  ? "This updates the product's Bill of Materials in Products & BOM to match this formula exactly — ingredients and packaging."
                  : "This creates the product in Products & BOM for the first time, with this formula as its Bill of Materials."}
              </p>
              <p className="mb-3 text-xs text-black">
                Production cycles read the BOM live: any in-progress cycle will pick up this
                new formula from now on, not retroactively.
              </p>
              {finishError && (
                <p className="mb-2 text-xs text-red-600" role="alert">
                  {finishError}
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleFinishIteration}
                  disabled={finishing}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
                >
                  {finishing ? "Finishing…" : "Finish Iteration"}
                </button>
                <button type="button" onClick={() => setFinishConfirmOpen(false)} className="text-xs text-black underline">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {discardConfirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-sm rounded-md bg-white p-4 shadow-lg">
              <h3 className="mb-2 text-sm font-semibold text-zinc-900">Discard this draft?</h3>
              <p className="mb-3 text-xs text-black">
                This permanently deletes v{draft?.version_number} and its formula lines. Nothing
                in Products & BOM is affected.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleDiscardDraft}
                  disabled={discarding}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-700 disabled:opacity-70"
                >
                  {discarding ? "Discarding…" : "Discard draft"}
                </button>
                <button type="button" onClick={() => setDiscardConfirmOpen(false)} className="text-xs text-black underline">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {newItemFor != null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-sm rounded-md bg-white p-4 shadow-lg">
              <h3 className="mb-2 text-sm font-semibold text-zinc-900">New raw material</h3>
              <form onSubmit={handleCreateItem} className="space-y-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Name</label>
                  <input
                    type="text"
                    required
                    value={newItemForm.name}
                    onChange={(e) => setNewItemForm({ ...newItemForm, name: e.target.value })}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-800">Unit</label>
                    <input
                      type="text"
                      required
                      value={newItemForm.unit}
                      onChange={(e) => setNewItemForm({ ...newItemForm, unit: e.target.value })}
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-800">Cost per unit</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={newItemForm.cost_per_unit}
                      onChange={(e) => setNewItemForm({ ...newItemForm, cost_per_unit: e.target.value === "" ? "" : Number(e.target.value) })}
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-800">On hand</label>
                    <input
                      type="number"
                      value={newItemForm.quantity_on_hand}
                      onChange={(e) => setNewItemForm({ ...newItemForm, quantity_on_hand: e.target.value === "" ? "" : Number(e.target.value) })}
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-800">Par level (optional)</label>
                    <input
                      type="number"
                      value={newItemForm.par_level}
                      onChange={(e) => setNewItemForm({ ...newItemForm, par_level: e.target.value === "" ? "" : Number(e.target.value) })}
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black"
                    />
                  </div>
                </div>
                {newItemError && (
                  <p className="text-xs text-red-600" role="alert">
                    {newItemError}
                  </p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={newItemSaving}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
                  >
                    {newItemSaving ? "Saving…" : "Create & use"}
                  </button>
                  <button type="button" onClick={() => setNewItemFor(null)} className="text-xs text-black underline">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
