"use client";

import { useEffect, useMemo } from "react";
import { buildFormulaTable, type FormulaInputRow } from "@/lib/formulaTable";
import { useSopRender } from "@/components/sop/SopRenderContext";

/** The table itself, given rows. Used by the editor (live) and viewer (frozen snapshot). */
export function FormulaTableGrid({
  rows,
  productName,
  versionNumber,
  showSource,
}: {
  rows: FormulaInputRow[];
  productName: string;
  versionNumber: number | null;
  showSource: boolean;
}) {
  const table = useMemo(() => buildFormulaTable(rows), [rows]);
  return (
    <div>
      <div className="sop-formula-scroll">
        <table>
          <thead>
            <tr>
              <th className="sop-ing" scope="col">Ingredient (g)</th>
              {table.columns.map((c) => (
                <th key={c.count} scope="col">{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td className="sop-ing">
                  {r.label}
                  {!r.valid && <span className="ml-1 text-red-600">(invalid amount)</span>}
                </td>
                {r.cells.map((c) => (
                  <td key={c.count} className="sop-num">{c.display}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showSource && (
        <p className="sop-formula-caption">
          Generated from {productName} formula{versionNumber != null ? ` v${versionNumber}` : ""}.
        </p>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="sop-formula-empty">{children}</div>;
}

/** A formula table block, resolving data from the render context by mode. */
export function FormulaTableBlock({ nodeId, productId, showSource }: { nodeId: string; productId: string | null; showSource: boolean }) {
  const ctx = useSopRender();

  useEffect(() => {
    if (ctx.mode === "live" && productId) ctx.requestLive(productId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.mode, productId]);

  if (ctx.mode === "snapshot") {
    const snap = ctx.snapshot?.[nodeId];
    if (!snap) return <Empty>Formula table (no saved values for this version).</Empty>;
    if (snap.status === "no_product") return <Empty>Formula table: no product selected.</Empty>;
    if (snap.status === "product_removed") return <Empty>Formula table: the product {snap.productName ? `“${snap.productName}” ` : ""}was removed.</Empty>;
    if (snap.status === "no_formula") return <Empty>No finalized formula for {snap.productName ?? "this product"} yet.</Empty>;
    return <FormulaTableGrid rows={snap.rows} productName={snap.productName ?? "product"} versionNumber={snap.versionNumber} showSource={showSource} />;
  }

  if (!productId) return <Empty>Formula table: choose a product in the table settings.</Empty>;
  const state = ctx.getLive(productId);
  if (state.error) return <Empty>Could not load the formula: {state.error}</Empty>;
  if (state.loading && !state.data) return <Empty>Loading formula…</Empty>;
  const data = state.data;
  if (!data) return <Empty>Loading formula…</Empty>;
  if (data.status === "product_removed") return <Empty>Formula table: this product was removed.</Empty>;
  if (data.status === "no_formula") return <Empty>No finalized formula for this product yet.</Empty>;
  return (
    <div>
      <span className="sop-formula-badge">Live: formula v{data.versionNumber}</span>
      <FormulaTableGrid rows={data.rows} productName={data.productName} versionNumber={data.versionNumber} showSource={showSource} />
    </div>
  );
}
