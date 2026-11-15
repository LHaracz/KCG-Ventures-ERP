"use client";

/**
 * The Invoices tab: newest invoice number first, 20 per page, with search
 * and filters. Deleted invoices are hidden unless "Show deleted" is on;
 * they can be restored. Download PDF counts as a download.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSupabase } from "@/components/InstantProvider";
import { deleteInvoiceApi, fetchInvoices, invoicePdfBlob, restoreInvoiceApi, saveBlob, type InvoiceListQuery } from "@/lib/retail/client";
import { formatMoney, formatShortDate } from "@/lib/retail/format";
import { invoiceFilename, editedSinceDownload } from "@/lib/retail/snapshots";
import { termsSummary, type Terms } from "@/lib/retail/terms";
import type { Business, InvoiceListRow, Retailer } from "@/lib/retail/types";
import { Badge, ConfirmDialog, btn, btnDanger, errorBox, input } from "./RetailUi";

type Confirm = { kind: "delete" | "restore"; row: InvoiceListRow };

const asTerms = (r: InvoiceListRow): Terms => ({
  terms_type: r.terms_type,
  net_days: r.net_days,
  terms_start: "invoice_date",
  consignment_our_share_percent: r.consignment_our_share_percent,
  consignment_schedule: r.consignment_schedule,
  consignment_days_to_pay: null,
  consignment_extra_terms: null,
});

export function InvoicesTab({ businesses, retailers }: { businesses: Business[]; retailers: Retailer[] }) {
  const { user } = useSupabase();
  const [query, setQuery] = useState<InvoiceListQuery>({ page: 1 });
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<{ rows: InvoiceListRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async (q: InvoiceListQuery) => {
    try {
      const next = await fetchInvoices(q);
      setResult(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    void load(query);
  }, [user, load, query]);

  // Search waits for typing to pause.
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.q === search ? q : { ...q, q: search, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const setFilter = (patch: Partial<InvoiceListQuery>) => setQuery((q) => ({ ...q, ...patch, page: 1 }));

  const download = async (row: InvoiceListRow) => {
    setBusyId(row.id);
    setError(null);
    try {
      const blob = await invoicePdfBlob(row.id, false);
      saveBlob(blob, invoiceFilename(row.invoice_number, row.order_number, row.retailer_name));
      await load(query);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusyId(confirm.row.id);
    setConfirmError(null);
    try {
      if (confirm.kind === "delete") await deleteInvoiceApi(confirm.row.id);
      else await restoreInvoiceApi(confirm.row.id);
      setConfirm(null);
      await load(query);
    } catch (e) {
      setConfirmError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const sortedRetailers = [...retailers].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="inv-search" className="mb-1 block text-xs font-medium text-black">
            Search
          </label>
          <input id="inv-search" placeholder="Invoice #, order #, retailer or PO" value={search} onChange={(e) => setSearch(e.target.value)} className={`${input} w-64`} />
        </div>
        <FilterSelect id="inv-business" label="Business" value={query.business ?? ""} onChange={(v) => setFilter({ business: v })} options={businesses.map((b) => ({ value: b.id, label: b.display_name }))} />
        <FilterSelect id="inv-retailer" label="Retailer" value={query.retailer ?? ""} onChange={(v) => setFilter({ retailer: v })} options={sortedRetailers.map((r) => ({ value: r.id, label: r.archived_at ? `${r.name} (archived)` : r.name }))} />
        <FilterSelect
          id="inv-terms"
          label="Terms"
          value={query.terms ?? ""}
          onChange={(v) => setFilter({ terms: v })}
          options={[
            { value: "net", label: "Net" },
            { value: "due_on_receipt", label: "Due on receipt" },
            { value: "due_on_delivery", label: "Due on delivery" },
            { value: "prepaid", label: "Prepaid" },
            { value: "consignment", label: "Consignment" },
          ]}
        />
        <div>
          <label htmlFor="inv-from" className="mb-1 block text-xs font-medium text-black">
            Invoice date from
          </label>
          <input id="inv-from" type="date" value={query.from ?? ""} onChange={(e) => setFilter({ from: e.target.value })} className={input} />
        </div>
        <div>
          <label htmlFor="inv-to" className="mb-1 block text-xs font-medium text-black">
            to
          </label>
          <input id="inv-to" type="date" value={query.to ?? ""} onChange={(e) => setFilter({ to: e.target.value })} className={input} />
        </div>
        <label className="inline-flex items-center gap-2 pb-1.5 text-xs text-black">
          <input type="checkbox" checked={!!query.deleted} onChange={(e) => setFilter({ deleted: e.target.checked })} />
          Show deleted
        </label>
      </div>

      {error && (
        <p className={errorBox} role="alert">
          {error}
        </p>
      )}
      {!result && !error && <p className="text-xs text-black">Loading…</p>}
      {result && result.rows.length === 0 && (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">
          {result.total === 0 && !query.q && !query.business && !query.retailer && !query.terms && !query.from && !query.to ? "No invoices yet." : "No invoices match."}
        </p>
      )}
      {result && result.rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs text-black">
            <thead className="bg-zinc-50">
              <tr>
                <th className="px-3 py-2 font-semibold">Invoice</th>
                <th className="px-3 py-2 font-semibold">Shopify order</th>
                <th className="px-3 py-2 font-semibold">Business</th>
                <th className="px-3 py-2 font-semibold">Retailer</th>
                <th className="px-3 py-2 font-semibold">Invoice date</th>
                <th className="px-3 py-2 font-semibold">Due</th>
                <th className="px-3 py-2 font-semibold">Terms</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2 font-semibold">Created by</th>
                <th className="px-3 py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => {
                const deleted = !!r.deleted_at;
                return (
                  <tr key={r.id} className={`border-t border-zinc-100 align-top ${deleted ? "bg-zinc-50" : ""}`}>
                    <td className="px-3 py-2">
                      <Link href={`/fulfillment/retail/invoices/${r.id}`} className={`font-medium text-black underline ${deleted ? "line-through" : ""}`}>
                        {r.invoice_number}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {deleted && <Badge tone="red">Deleted</Badge>}
                        {!deleted && !r.last_downloaded_at && <Badge>Not downloaded</Badge>}
                        {!deleted && r.last_downloaded_at && editedSinceDownload(r) && <Badge tone="amber">Edited since last download</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2">{r.order_number}</td>
                    <td className="px-3 py-2">{r.business_name}</td>
                    <td className="px-3 py-2">
                      {r.retailer_name}
                      {r.retailer_po_number ? <div>PO {r.retailer_po_number}</div> : null}
                    </td>
                    <td className="px-3 py-2">{formatShortDate(r.invoice_date)}</td>
                    <td className="px-3 py-2">{r.terms_type === "consignment" ? "—" : r.terms_type === "prepaid" ? "Before delivery" : formatShortDate(r.due_date)}</td>
                    <td className="px-3 py-2">{termsSummary(asTerms(r))}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatMoney(r.total)}</td>
                    <td className="px-3 py-2">{r.created_by_name ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button type="button" className={btn} onClick={() => download(r)} disabled={busyId === r.id}>
                          {busyId === r.id ? "Working…" : "Download PDF"}
                        </button>
                        <Link href={`/fulfillment/retail/invoices/${r.id}`} className={btn}>
                          View
                        </Link>
                        {!deleted && (
                          <Link href={`/fulfillment/retail/invoices/${r.id}/edit`} className={btn}>
                            Edit
                          </Link>
                        )}
                        <Link href={`/fulfillment/retail/invoices/new?from=${r.id}`} className={btn}>
                          Duplicate
                        </Link>
                        {deleted ? (
                          <button type="button" className={btn} onClick={() => setConfirm({ kind: "restore", row: r })}>
                            Restore
                          </button>
                        ) : (
                          <button type="button" className={btnDanger} onClick={() => setConfirm({ kind: "delete", row: r })}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {result && result.total > 0 && (
        <div className="flex items-center justify-between text-xs text-black">
          <span>
            {result.total} invoice{result.total === 1 ? "" : "s"} · page {result.page} of {pages}
          </span>
          <div className="flex gap-1">
            <button type="button" className={btn} disabled={result.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: (q.page ?? 1) - 1 }))}>
              Previous
            </button>
            <button type="button" className={btn} disabled={result.page >= pages} onClick={() => setQuery((q) => ({ ...q, page: (q.page ?? 1) + 1 }))}>
              Next
            </button>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "delete" ? `Delete ${confirm.row.invoice_number}?` : `Restore ${confirm.row.invoice_number}?`}
          confirmLabel={confirm.kind === "delete" ? "Delete invoice" : "Restore invoice"}
          busy={busyId === confirm.row.id}
          error={confirmError}
          onConfirm={runConfirm}
          onClose={() => {
            setConfirm(null);
            setConfirmError(null);
          }}
        >
          {confirm.kind === "delete" ? (
            <>
              <p>
                The invoice is kept and its PDF prints VOID. Its number ({confirm.row.invoice_number}) is never reused, and order {confirm.row.order_number} becomes free for a new invoice.
              </p>
              <p>You can restore it later with Show deleted.</p>
            </>
          ) : (
            <p>The invoice comes back as it was. This is refused if order {confirm.row.order_number} now has another invoice.</p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

function FilterSelect({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-black">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${input} w-44`}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
