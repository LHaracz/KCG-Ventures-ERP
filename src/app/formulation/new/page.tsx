"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import {
  computeFormulaCost,
  computeMargin,
  emptyLineDraft,
  type FormulationLineDraft,
  type InventoryItemLite,
} from "@/lib/formulation";

type ProductDetails = {
  name: string;
  unit: string;
  sale_price_per_unit: number | "";
  shelf_life_days: number | "";
  target_batch_size: number | "";
  target_batch_unit: string;
  notes: string;
};

type NewItemForm = {
  name: string;
  unit: string;
  cost_per_unit: number | "";
  quantity_on_hand: number | "";
  par_level: number | "";
};

let lineKeyCounter = 0;
function nextLineKey() {
  lineKeyCounter += 1;
  return `line-${lineKeyCounter}`;
}

export default function NewFormulationProductPage() {
  const { user, supabase } = useSupabase();

  const [items, setItems] = useState<InventoryItemLite[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [details, setDetails] = useState<ProductDetails>({
    name: "",
    unit: "",
    sale_price_per_unit: "",
    shelf_life_days: "",
    target_batch_size: "",
    target_batch_unit: "",
    notes: "",
  });
  const [goalNotes, setGoalNotes] = useState("");
  const [lines, setLines] = useState<FormulationLineDraft[]>([emptyLineDraft(nextLineKey())]);

  const [newItemFor, setNewItemFor] = useState<string | null>(null); // line.key this modal is for
  const [newItemForm, setNewItemForm] = useState<NewItemForm>({
    name: "",
    unit: "",
    cost_per_unit: "",
    quantity_on_hand: 0,
    par_level: "",
  });
  const [newItemError, setNewItemError] = useState<string | null>(null);
  const [newItemSaving, setNewItemSaving] = useState(false);

  const [step, setStep] = useState<"edit" | "review">("edit");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [successId, setSuccessId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const { data } = await supabase
        .from("inventory_items")
        .select("id, name, unit, cost_per_unit")
        .order("name", { ascending: true });
      setItems((data || []) as InventoryItemLite[]);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const cost = useMemo(() => computeFormulaCost(lines, items), [lines, items]);
  const margin = useMemo(
    () => computeMargin(cost, details.sale_price_per_unit === "" ? null : Number(details.sale_price_per_unit)),
    [cost, details.sale_price_per_unit],
  );

  const addLine = () => setLines((prev) => [...prev, emptyLineDraft(nextLineKey())]);
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));
  const updateLine = (key: string, patch: Partial<FormulationLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const openNewItemModal = (lineKey: string) => {
    setNewItemFor(lineKey);
    setNewItemError(null);
    setNewItemForm({ name: "", unit: "", cost_per_unit: "", quantity_on_hand: 0, par_level: "" });
  };

  const handleCreateItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !newItemFor) return;
    setNewItemSaving(true);
    setNewItemError(null);
    try {
      const duplicate = items.find(
        (it) => it.name.trim().toLowerCase() === newItemForm.name.trim().toLowerCase(),
      );
      if (duplicate) {
        setNewItemError("An inventory item with this name already exists.");
        setNewItemSaving(false);
        return;
      }
      const payload = {
        name: newItemForm.name.trim(),
        unit: newItemForm.unit.trim(),
        cost_per_unit: Number(newItemForm.cost_per_unit || 0),
        quantity_on_hand: Number(newItemForm.quantity_on_hand || 0),
        par_level: newItemForm.par_level === "" ? null : Number(newItemForm.par_level),
        last_count_date: null,
        user_id: user.id,
      };
      const { data, error } = await supabase
        .from("inventory_items")
        .insert(payload)
        .select("id, name, unit, cost_per_unit")
        .single();
      if (error) throw error;
      setItems((prev) => [...prev, data as InventoryItemLite].sort((a, b) => a.name.localeCompare(b.name)));
      updateLine(newItemFor, { raw_material_id: data.id });
      setNewItemFor(null);
    } catch (err: any) {
      setNewItemError(err.message || "Failed to create inventory item.");
    } finally {
      setNewItemSaving(false);
    }
  };

  const validate = (): string | null => {
    if (!details.name.trim()) return "Product name is required.";
    if (!details.unit.trim()) return "Unit (e.g. bottle, tube) is required.";
    const realLines = lines.filter((l) => l.raw_material_id);
    if (realLines.length === 0) return "Add at least one formula line.";
    for (const l of realLines) {
      const qty = Number(l.qty_per_unit);
      if (!l.qty_per_unit || !Number.isFinite(qty) || qty <= 0) {
        const item = items.find((i) => i.id === l.raw_material_id);
        return `Enter a positive quantity for ${item?.name ?? "a formula line"}.`;
      }
    }
    return null;
  };

  const goToReview = () => {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setStep("review");
  };

  const handleSubmit = async () => {
    if (!user) return;
    setSubmitting(true);
    setFormError(null);
    let createdFormulationProductId: string | null = null;
    try {
      const { data: fp, error: fpError } = await supabase
        .from("formulation_products")
        .insert({
          name: details.name.trim(),
          status: "in_development",
          draft_unit: details.unit.trim(),
          draft_sale_price_per_unit: details.sale_price_per_unit === "" ? null : Number(details.sale_price_per_unit),
          draft_shelf_life_days: details.shelf_life_days === "" ? null : Number(details.shelf_life_days),
          draft_target_batch_size: details.target_batch_size === "" ? null : Number(details.target_batch_size),
          draft_target_batch_unit: details.target_batch_unit.trim() || null,
          draft_notes: details.notes.trim() || null,
        })
        .select("id")
        .single();
      if (fpError) throw fpError;
      createdFormulationProductId = fp.id;

      const { data: formulation, error: formulationError } = await supabase
        .from("formulations")
        .insert({
          formulation_product_id: fp.id,
          version_number: 1,
          status: "draft",
          source: "new",
          goal_notes: goalNotes.trim() || null,
        })
        .select("id")
        .single();
      if (formulationError) throw formulationError;

      const realLines = lines.filter((l) => l.raw_material_id);
      const lineInserts = realLines.map((l, idx) => ({
        formulation_id: formulation.id,
        line_type: l.line_type,
        raw_material_id: l.raw_material_id,
        qty_per_unit: Number(l.qty_per_unit),
        reason: l.reason.trim() || null,
        sort_order: idx,
      }));
      const { error: linesError } = await supabase.from("formulation_lines").insert(lineInserts);
      if (linesError) throw linesError;

      setSuccessId(fp.id);
    } catch (err: any) {
      // Roll back: delete the formulation_product we created, if we got
      // that far — cascades remove the draft formulation/lines with it.
      if (createdFormulationProductId) {
        await supabase.from("formulation_products").delete().eq("id", createdFormulationProductId);
      }
      setFormError(err.message || "Failed to create the formulation. Nothing was saved.");
      setStep("edit");
    } finally {
      setSubmitting(false);
    }
  };

  if (successId) {
    return (
      <AuthGuard>
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            <h1 className="mb-1 text-lg font-semibold">
              &quot;{details.name}&quot; created as v1 (draft)
            </h1>
            <p className="text-xs">
              It&apos;s in development only — nothing has been added to Products & BOM yet.
            </p>
          </div>
          <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs text-black">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">Next steps</h2>
            <ul className="list-inside list-disc space-y-1">
              <li>
                <Link href={`/formulation/${successId}`} className="text-emerald-700 underline">
                  Open this product
                </Link>{" "}
                to log test batches against v1.
              </li>
              <li>
                When you&apos;re happy with the formula, use{" "}
                <span className="font-medium">Finish Iteration</span> there — that&apos;s what
                creates the real Products & BOM entry and makes it producible.
              </li>
            </ul>
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">New Formulation Product</h1>
          <p className="text-sm text-black">
            Build v1 of the formula. Packaging lines belong here too — they&apos;ll be part of
            the BOM Finish Iteration creates, so you won&apos;t need to add them separately in
            Products & BOM afterward.
          </p>
        </header>

        {formError && (
          <p className="text-xs text-red-600" role="alert">
            {formError}
          </p>
        )}

        {step === "edit" && (
          <div className="space-y-4">
            <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">Product details</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Name</label>
                  <input
                    type="text"
                    required
                    value={details.name}
                    onChange={(e) => setDetails({ ...details, name: e.target.value })}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Unit (e.g. tube, bottle)</label>
                  <input
                    type="text"
                    required
                    value={details.unit}
                    onChange={(e) => setDetails({ ...details, unit: e.target.value })}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Sale price per unit</label>
                  <input
                    type="number"
                    step="0.01"
                    value={details.sale_price_per_unit}
                    onChange={(e) =>
                      setDetails({ ...details, sale_price_per_unit: e.target.value === "" ? "" : Number(e.target.value) })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Shelf life (days, optional)</label>
                  <input
                    type="number"
                    value={details.shelf_life_days}
                    onChange={(e) =>
                      setDetails({ ...details, shelf_life_days: e.target.value === "" ? "" : Number(e.target.value) })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Target batch size (optional)</label>
                  <input
                    type="number"
                    value={details.target_batch_size}
                    onChange={(e) =>
                      setDetails({ ...details, target_batch_size: e.target.value === "" ? "" : Number(e.target.value) })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">Target batch unit (optional)</label>
                  <input
                    type="text"
                    value={details.target_batch_unit}
                    onChange={(e) => setDetails({ ...details, target_batch_unit: e.target.value })}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              </div>
              <div className="mt-2">
                <label className="mb-1 block font-medium text-zinc-800">Notes (optional)</label>
                <textarea
                  rows={2}
                  value={details.notes}
                  onChange={(e) => setDetails({ ...details, notes: e.target.value })}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div className="mt-2">
                <label className="mb-1 block font-medium text-zinc-800">
                  Goal for this iteration (optional)
                </label>
                <input
                  type="text"
                  value={goalNotes}
                  onChange={(e) => setGoalNotes(e.target.value)}
                  placeholder="e.g. first pass at a fluoride-free whitening formula"
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </section>

            <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">Formula lines</h2>
                <button
                  type="button"
                  onClick={addLine}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700"
                >
                  Add line
                </button>
              </div>
              <div className="space-y-2">
                {lines.map((line) => {
                  const item = items.find((i) => i.id === line.raw_material_id);
                  return (
                    <div key={line.key} className="grid gap-2 rounded-md bg-zinc-50 p-2 sm:grid-cols-[110px_1fr_120px_1fr_auto]">
                      <select
                        value={line.line_type}
                        onChange={(e) => updateLine(line.key, { line_type: e.target.value as any })}
                        className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                      >
                        <option value="inventory_item">Ingredient</option>
                        <option value="packaging">Packaging</option>
                      </select>
                      <div>
                        <select
                          value={line.raw_material_id}
                          onChange={(e) => {
                            if (e.target.value === "__new__") {
                              openNewItemModal(line.key);
                              return;
                            }
                            updateLine(line.key, { raw_material_id: e.target.value });
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
                      </div>
                      <input
                        type="number"
                        step="0.0001"
                        placeholder={item ? `Qty per unit (${item.unit})` : "Qty per unit"}
                        value={line.qty_per_unit}
                        onChange={(e) =>
                          updateLine(line.key, { qty_per_unit: e.target.value === "" ? "" : Number(e.target.value) })
                        }
                        className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                      />
                      <input
                        type="text"
                        placeholder="Reason / notes (optional)"
                        value={line.reason}
                        onChange={(e) => updateLine(line.key, { reason: e.target.value })}
                        className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black"
                      />
                      <button
                        type="button"
                        onClick={() => removeLine(line.key)}
                        disabled={lines.length === 1}
                        className="rounded-md px-2 text-[11px] text-red-600 underline disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-between rounded-md bg-zinc-50 p-2 text-[11px] text-black">
                <span>Ingredient + packaging cost per unit: ${cost.toFixed(4)}</span>
                {margin.salePrice != null && (
                  <span>
                    Margin: ${margin.margin!.toFixed(2)} ({margin.marginPct!.toFixed(1)}%)
                  </span>
                )}
              </div>
            </section>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goToReview}
                disabled={isLoading}
                className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
              >
                Review
              </button>
              <Link href="/formulation" className="text-xs text-black underline">
                Cancel
              </Link>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-4">
            <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">Review</h2>
              <p className="mb-2">
                <span className="font-medium text-zinc-900">{details.name}</span> · {details.unit} · $
                {details.sale_price_per_unit === "" ? "—" : Number(details.sale_price_per_unit).toFixed(2)} / unit
              </p>
              <table className="min-w-full border-collapse text-left">
                <thead className="bg-zinc-50 text-[11px] text-black">
                  <tr>
                    <th className="px-2 py-1 font-medium">Material</th>
                    <th className="px-2 py-1 font-medium">Type</th>
                    <th className="px-2 py-1 font-medium">Qty / unit</th>
                    <th className="px-2 py-1 font-medium">Unit</th>
                    <th className="px-2 py-1 font-medium">Line cost</th>
                  </tr>
                </thead>
                <tbody>
                  {lines
                    .filter((l) => l.raw_material_id)
                    .map((l) => {
                      const item = items.find((i) => i.id === l.raw_material_id);
                      const lineCost = (Number(l.qty_per_unit) || 0) * (item ? Number(item.cost_per_unit) || 0 : 0);
                      return (
                        <tr key={l.key} className="border-b text-[11px] text-black">
                          <td className="px-2 py-1">{item?.name ?? "—"}</td>
                          <td className="px-2 py-1">{l.line_type === "packaging" ? "Packaging" : "Ingredient"}</td>
                          <td className="px-2 py-1">{l.qty_per_unit}</td>
                          <td className="px-2 py-1">{item?.unit ?? "—"}</td>
                          <td className="px-2 py-1">${lineCost.toFixed(4)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              <div className="mt-2 text-[11px] text-black">
                Total cost per unit: ${cost.toFixed(4)}
                {margin.salePrice != null && (
                  <> · Margin: ${margin.margin!.toFixed(2)} ({margin.marginPct!.toFixed(1)}%)</>
                )}
              </div>
              <p className="mt-2 text-[11px] text-black">
                This creates a new formulation product and its v1 draft only — nothing is
                added to Products & BOM until you Finish Iteration.
              </p>
            </section>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
              >
                {submitting ? "Creating…" : "Create v1 draft"}
              </button>
              <button
                type="button"
                onClick={() => setStep("edit")}
                className="text-xs text-black underline"
              >
                Back to edit
              </button>
            </div>
          </div>
        )}

        {newItemFor && (
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
                      onChange={(e) =>
                        setNewItemForm({ ...newItemForm, cost_per_unit: e.target.value === "" ? "" : Number(e.target.value) })
                      }
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
                      onChange={(e) =>
                        setNewItemForm({ ...newItemForm, quantity_on_hand: e.target.value === "" ? "" : Number(e.target.value) })
                      }
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-800">Par level (optional)</label>
                    <input
                      type="number"
                      value={newItemForm.par_level}
                      onChange={(e) =>
                        setNewItemForm({ ...newItemForm, par_level: e.target.value === "" ? "" : Number(e.target.value) })
                      }
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
                  <button
                    type="button"
                    onClick={() => setNewItemFor(null)}
                    className="text-xs text-black underline"
                  >
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
