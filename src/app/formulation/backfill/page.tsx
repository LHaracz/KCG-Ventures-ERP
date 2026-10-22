"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { buildBaselinePreview, type BaselinePreviewRow, type BomLineLite, type InventoryItemLite } from "@/lib/formulation";

/**
 * One-time (but safely re-runnable) tool: import every existing
 * BotanIQals product's current BOM as its v1 "baseline" formulation.
 * Dry-run first — nothing is written until Lukas reviews this preview and
 * explicitly clicks "Write baseline formulations". Idempotent: a product
 * that already has a formulation_products row is shown as already
 * imported and can't be re-selected.
 */
export default function FormulationBackfillPage() {
  const { user, supabase } = useSupabase();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BaselinePreviewRow[]>([]);
  const [alreadyImportedProductIds, setAlreadyImportedProductIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writeResult, setWriteResult] = useState<{ imported: string[]; skipped: string[] } | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      setLoadError(null);
      const [productsRes, bomRes, itemsRes, formulationProductsRes] = await Promise.all([
        supabase
          .from("products")
          .select("id, name, is_microgreen, deleted_at")
          .is("deleted_at", null),
        supabase
          .from("bom_lines")
          .select("id, product, line_type, inventory_item, qty_per_unit, unit_label, sale_price, material_name_snapshot, notes"),
        supabase.from("inventory_items").select("id, name, unit, cost_per_unit"),
        supabase.from("formulation_products").select("product_id").not("product_id", "is", null),
      ]);
      const err = [productsRes.error, bomRes.error, itemsRes.error, formulationProductsRes.error]
        .filter(Boolean)
        .map((e) => e!.message)
        .join(" | ");
      if (err) {
        setLoadError(err);
        setIsLoading(false);
        return;
      }
      const alreadyImported = new Set(
        (formulationProductsRes.data || []).map((r: any) => r.product_id as string),
      );
      setAlreadyImportedProductIds(alreadyImported);

      const builtPreview = buildBaselinePreview(
        (productsRes.data || []) as any[],
        (bomRes.data || []) as BomLineLite[],
        (itemsRes.data || []) as InventoryItemLite[],
      ).filter((row) => !alreadyImported.has(row.productId));

      setPreview(builtPreview);
      // Default-select every clean row; leave flagged rows unchecked so a
      // product with a warning has to be opted into deliberately.
      setSelected(new Set(builtPreview.filter((r) => !r.warning && r.lineCount > 0).map((r) => r.productId)));
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const selectableRows = useMemo(() => preview.filter((r) => r.lineCount > 0), [preview]);

  const toggle = (productId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const handleWrite = async () => {
    if (!user || selected.size === 0) return;
    setWriting(true);
    setWriteError(null);
    setWriteResult(null);
    const importedProductIds: string[] = [];
    const importedNames: string[] = [];
    const skippedNames: string[] = [];
    try {
      for (const row of preview) {
        if (!selected.has(row.productId)) {
          skippedNames.push(row.productName);
          continue;
        }
        // formulation_products
        const { data: fp, error: fpError } = await supabase
          .from("formulation_products")
          .insert({ name: row.productName, product_id: row.productId, status: "active" })
          .select("id")
          .single();
        if (fpError) throw new Error(`${row.productName}: ${fpError.message}`);

        // formulations v1, already final (this *is* what's currently in production)
        const nowIso = new Date().toISOString();
        const { data: formulation, error: formulationError } = await supabase
          .from("formulations")
          .insert({
            formulation_product_id: fp.id,
            version_number: 1,
            status: "final",
            source: "baseline_import",
            change_summary: "Imported from the product's existing Products & BOM lines.",
            finalized_at: nowIso,
          })
          .select("id")
          .single();
        if (formulationError) throw new Error(`${row.productName}: ${formulationError.message}`);

        // formulation_lines, one per bom_line that was previewed
        const bomRowsForProduct = row.lines;
        if (bomRowsForProduct.length > 0) {
          // Re-fetch the actual bom_lines for this product to get inventory_item ids
          // (the preview only carries display fields).
          const { data: liveBomLines, error: liveBomError } = await supabase
            .from("bom_lines")
            .select("line_type, inventory_item, qty_per_unit")
            .eq("product", row.productId)
            .not("inventory_item", "is", null);
          if (liveBomError) throw new Error(`${row.productName}: ${liveBomError.message}`);

          const lineInserts = (liveBomLines || []).map((b: any, idx: number) => ({
            formulation_id: formulation.id,
            line_type: b.line_type === "packaging" ? "packaging" : "inventory_item",
            raw_material_id: b.inventory_item,
            qty_per_unit: Number(b.qty_per_unit) || 0,
            reason: null,
            sort_order: idx,
          }));
          if (lineInserts.length > 0) {
            const { error: linesError } = await supabase.from("formulation_lines").insert(lineInserts);
            if (linesError) throw new Error(`${row.productName}: ${linesError.message}`);
          }
        }
        importedProductIds.push(row.productId);
        importedNames.push(row.productName);
      }
      setWriteResult({ imported: importedNames, skipped: skippedNames });
      setSelected(new Set());
      setPreview((prev) => prev.filter((r) => !importedProductIds.includes(r.productId)));
    } catch (err: any) {
      setWriteError(err.message || "Failed to write baseline formulations.");
    } finally {
      setWriting(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Import existing products as baseline formulations
          </h1>
          <p className="text-sm text-black">
            Preview only — nothing below has been written yet. Review each product&apos;s
            current BOM, uncheck anything that looks wrong, then write the selected
            products as their v1 (final) formulation. Already-imported products are left
            out automatically, so this is safe to come back to later.
          </p>
        </header>

        {loadError && (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        )}

        {writeError && (
          <p className="text-xs text-red-600" role="alert">
            {writeError}
          </p>
        )}

        {writeResult && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            Imported {writeResult.imported.length} product(s)
            {writeResult.imported.length > 0 ? `: ${writeResult.imported.join(", ")}` : ""}.{" "}
            <Link href="/formulation" className="underline">
              Go to Formulation
            </Link>
          </div>
        )}

        <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
          {isLoading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : preview.length === 0 ? (
            <p className="text-xs text-black">
              Nothing left to import — every BotanIQals product already has a baseline
              formulation, or none have BOM lines yet.
            </p>
          ) : (
            <div className="space-y-3">
              {preview.map((row) => (
                <div
                  key={row.productId}
                  className={`rounded-md border p-3 ${row.warning ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-zinc-50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(row.productId)}
                        disabled={row.lineCount === 0}
                        onChange={() => toggle(row.productId)}
                        className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-emerald-600"
                      />
                      <span>
                        <span className="font-medium text-zinc-900">{row.productName}</span>
                        <span className="ml-2 text-[11px] text-black">
                          {row.lineCount} BOM line{row.lineCount === 1 ? "" : "s"}
                        </span>
                      </span>
                    </label>
                  </div>
                  {row.warning && (
                    <p className="mt-1 text-[11px] font-medium text-amber-800">⚠ {row.warning}</p>
                  )}
                  {row.lines.length > 0 && (
                    <table className="mt-2 min-w-full border-collapse text-left">
                      <thead className="text-[10px] text-black">
                        <tr>
                          <th className="px-2 py-0.5 font-medium">Material</th>
                          <th className="px-2 py-0.5 font-medium">Type</th>
                          <th className="px-2 py-0.5 font-medium">Qty / unit</th>
                          <th className="px-2 py-0.5 font-medium">Unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.lines.map((l, idx) => (
                          <tr key={idx} className="text-[11px] text-black">
                            <td className="px-2 py-0.5">{l.itemName}</td>
                            <td className="px-2 py-0.5">{l.line_type}</td>
                            <td className="px-2 py-0.5">{l.qty_per_unit}</td>
                            <td className="px-2 py-0.5">{l.unit_label}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  disabled={writing || selected.size === 0}
                  onClick={handleWrite}
                  className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {writing ? "Writing…" : `Write ${selected.size} baseline formulation(s)`}
                </button>
                <span className="text-[11px] text-black">
                  {selectableRows.length - selected.size} unchecked / skipped
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  );
}
