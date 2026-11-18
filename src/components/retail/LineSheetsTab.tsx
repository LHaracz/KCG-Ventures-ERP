"use client";

/** Retail → Line sheets tab (Admin only): the list with View, Download, Edit, Duplicate and Delete. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/components/InstantProvider";
import { Badge, ConfirmDialog, btn, btnPrimary, errorBox } from "./RetailUi";
import { saveBlob } from "@/lib/retail/client";
import { deleteLineSheetApi, duplicateLineSheetApi, fetchLineSheets, lineSheetPdfBlob } from "@/lib/retail/lineSheetClient";
import type { LineSheetListRow } from "@/lib/retail/lineSheetService";
import { formatPercent, formatShortDate } from "@/lib/retail/format";
import { lineSheetFilename } from "@/lib/retail/lineSheets";
import { nyDateOf } from "@/lib/growth/dates";

export function LineSheetsTab() {
  const { user } = useSupabase();
  const router = useRouter();
  const [rows, setRows] = useState<LineSheetListRow[] | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<LineSheetListRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRows((await fetchLineSheets(deleted)).rows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [deleted]);
  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);
  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="space-y-3 text-black">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-2 text-xs text-black">
          <input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} /> Show deleted
        </label>
        <Link href="/fulfillment/retail/line-sheets/new" className={btnPrimary}>New line sheet</Link>
      </div>
      {error && <p className={errorBox} role="alert">{error}</p>}
      {!rows && !error && <p className="text-xs">Loading…</p>}
      {rows && rows.length === 0 && <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">{deleted ? "No deleted line sheets." : "No line sheets yet. Make one to send to a store."}</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs text-black" data-testid="line-sheets-table">
            <thead className="bg-zinc-50">
              <tr>
                {["Name", "Business", "Prepared for", "Price basis", "Products", "Created"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 align-top">
                  <td className="px-3 py-2">
                    <Link href={`/fulfillment/retail/line-sheets/${r.id}`} className="font-medium underline">{r.name}</Link>
                    {r.deleted_at && <div><Badge>Deleted</Badge></div>}
                  </td>
                  <td className="px-3 py-2">{r.business_name}</td>
                  <td className="px-3 py-2">{r.prepared_for || r.retailer_name || "—"}</td>
                  <td className="px-3 py-2">{r.price_basis === "retailer" ? `${r.retailer_name ?? "Retailer"} price list` : `Standard (${formatPercent(r.standard_wholesale_percent)}% of MSRP)`}</td>
                  <td className="px-3 py-2">{r.product_count}</td>
                  <td className="px-3 py-2">{formatShortDate(nyDateOf(r.created_at))}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Link href={`/fulfillment/retail/line-sheets/${r.id}`} className={btn}>View</Link>
                      {!r.deleted_at && (
                        <>
                          <button type="button" className={btn} disabled={busy === r.id} onClick={() => run(r.id, async () => saveBlob(await lineSheetPdfBlob(r.id, false), lineSheetFilename(r.name)))}>Download</button>
                          <Link href={`/fulfillment/retail/line-sheets/${r.id}/edit`} className={btn}>Edit</Link>
                          <button type="button" className={btn} disabled={busy === r.id} onClick={() => run(r.id, async () => router.push(`/fulfillment/retail/line-sheets/${(await duplicateLineSheetApi(r.id)).id}/edit`))}>Duplicate</button>
                          <button type="button" className={btn} onClick={() => setConfirm(r)}>Delete</button>
                        </>
                      )}
                      {r.deleted_at && <button type="button" className={btn} onClick={() => run(r.id, async () => { await deleteLineSheetApi(r.id, true); await load(); })}>Restore</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title="Delete this line sheet?"
          confirmLabel="Delete"
          busy={busy === confirm.id}
          error={null}
          onConfirm={() => run(confirm.id, async () => { await deleteLineSheetApi(confirm.id); setConfirm(null); await load(); })}
          onClose={() => setConfirm(null)}
        >
          <p>&ldquo;{confirm.name}&rdquo; moves to deleted line sheets. You can restore it later.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
