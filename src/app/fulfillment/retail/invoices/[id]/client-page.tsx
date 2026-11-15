"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { Badge, BackToRetail, ConfirmDialog, btn, btnDanger, btnPrimary, card, errorBox, infoBox } from "@/components/retail/RetailUi";
import { deleteInvoiceApi, fetchInvoice, invoicePdfBlob, printBlob, restoreInvoiceApi, saveBlob } from "@/lib/retail/client";
import { formatLongDate, formatMoney, formatPercent } from "@/lib/retail/format";
import { editedSinceDownload, invoiceFilename } from "@/lib/retail/snapshots";
import { consignmentTermsText, termsLabel } from "@/lib/retail/terms";
import type { InvoiceWithLines } from "@/lib/retail/types";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => <p className="p-4 text-xs text-black">Loading PDF…</p>,
});

export default function InvoiceDetailPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <InvoiceDetailInner />
      </Suspense>
    </AuthGuard>
  );
}

const ny = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

function InvoiceDetailInner() {
  const { user } = useSupabase();
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get("created") === "1";
  const [invoice, setInvoice] = useState<InvoiceWithLines | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"download" | "print" | "delete" | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "restore" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchInvoice(id);
      setInvoice(res.invoice);
      const blob = await invoicePdfBlob(id, true);
      setPdfUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);
  useEffect(() => () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  }, [pdfUrl]);

  const download = async () => {
    if (!invoice) return;
    setBusy("download");
    setError(null);
    try {
      const blob = await invoicePdfBlob(invoice.id, false);
      saveBlob(blob, invoiceFilename(invoice.invoice_number, invoice.order_number, invoice.retailer_snapshot.name));
      const res = await fetchInvoice(invoice.id);
      setInvoice(res.invoice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const print = async () => {
    if (!invoice) return;
    setBusy("print");
    try {
      printBlob(await invoicePdfBlob(invoice.id, true));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runConfirm = async () => {
    if (!invoice || !confirm) return;
    setBusy("delete");
    setConfirmError(null);
    try {
      if (confirm === "delete") await deleteInvoiceApi(invoice.id);
      else await restoreInvoiceApi(invoice.id);
      setConfirm(null);
      await load();
    } catch (e) {
      setConfirmError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !invoice) {
    return (
      <div className="mx-auto max-w-7xl space-y-3 text-black">
        <BackToRetail tab="invoices" />
        <p className={errorBox} role="alert">
          {error}
        </p>
      </div>
    );
  }
  if (!invoice) return <p className="text-xs text-black">Loading…</p>;
  const inv = invoice;
  const deleted = !!inv.deleted_at;
  const consignment = inv.terms_type === "consignment";

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <BackToRetail tab="invoices" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">
            {inv.invoice_number} <span className="text-base font-normal">· Order {inv.order_number}</span>
          </h1>
          <p className="text-sm">
            {inv.company_snapshot.display_name} → {inv.retailer_snapshot.name}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {deleted && <Badge tone="red">Deleted (PDF shows VOID)</Badge>}
            {consignment && <Badge tone="blue">Consignment</Badge>}
            {!deleted && !inv.last_downloaded_at && <Badge>Not downloaded</Badge>}
            {!deleted && inv.last_downloaded_at && editedSinceDownload(inv) && <Badge tone="amber">Edited since last download</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} onClick={download} disabled={busy !== null}>
            {busy === "download" ? "Generating…" : "Download PDF"}
          </button>
          <button type="button" className={btn} onClick={print} disabled={busy !== null}>
            {busy === "print" ? "Opening…" : "Print"}
          </button>
          {!deleted && (
            <Link href={`/fulfillment/retail/invoices/${inv.id}/edit`} className={btn}>
              Edit
            </Link>
          )}
          <Link href={`/fulfillment/retail/invoices/new?from=${inv.id}`} className={btn}>
            Duplicate
          </Link>
          {deleted ? (
            <button type="button" className={btn} onClick={() => setConfirm("restore")}>
              Restore
            </button>
          ) : (
            <button type="button" className={btnDanger} onClick={() => setConfirm("delete")}>
              Delete
            </button>
          )}
        </div>
      </div>
      {created && <p className={infoBox}>Invoice {inv.invoice_number} saved. Download the PDF to send it to the retailer.</p>}
      {error && (
        <p className={errorBox} role="alert">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="h-[80vh] overflow-hidden rounded-md border border-zinc-200 bg-zinc-100">{pdfUrl ? <PdfViewer fileUrl={pdfUrl} /> : <p className="p-4 text-xs text-black">Loading PDF…</p>}</div>
        </div>
        <aside className={`${card} space-y-3 text-xs`}>
          <div>
            <h2 className="text-sm font-semibold">Summary</h2>
            <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
              <dt>Invoice date</dt>
              <dd>{formatLongDate(inv.invoice_date)}</dd>
              <dt>Delivery date</dt>
              <dd>{formatLongDate(inv.delivery_date)}</dd>
              <dt>Terms</dt>
              <dd>{termsLabel(inv)}</dd>
              <dt>Due</dt>
              <dd>{consignment ? "Not applicable" : inv.terms_type === "prepaid" ? `Before delivery (${formatLongDate(inv.due_date)})` : formatLongDate(inv.due_date)}</dd>
              {inv.retailer_po_number && (
                <>
                  <dt>Retailer PO</dt>
                  <dd>{inv.retailer_po_number}</dd>
                </>
              )}
              <dt>Lines</dt>
              <dd>{inv.lines.length}</dd>
              <dt>Subtotal</dt>
              <dd>{formatMoney(inv.subtotal)}</dd>
              {Number(inv.delivery_fee) > 0 && (
                <>
                  <dt>Delivery fee</dt>
                  <dd>{formatMoney(inv.delivery_fee)}</dd>
                </>
              )}
              <dt>Tax</dt>
              <dd>{inv.tax_exempt ? "Exempt" : `${formatMoney(inv.tax_amount)} (${formatPercent(inv.tax_rate_percent) || "0"}%)`}</dd>
              <dt className="font-semibold">{consignment ? "Consigned value" : "Total"}</dt>
              <dd className="font-semibold">{formatMoney(inv.total)}</dd>
            </dl>
          </div>
          {consignment && (
            <div>
              <h3 className="font-semibold">Consignment terms (printed)</h3>
              <ul className="mt-1 list-disc pl-4">
                {consignmentTermsText(inv, inv.company_snapshot.legal_name).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          {inv.internal_notes && (
            <div>
              <h3 className="font-semibold">Internal notes (not printed)</h3>
              <p className="whitespace-pre-line">{inv.internal_notes}</p>
            </div>
          )}
          <div className="space-y-0.5 border-t border-zinc-200 pt-2">
            <p>Created {ny(inv.created_at)}{inv.created_by_name ? ` by ${inv.created_by_name}` : ""}.</p>
            <p>Last changed {ny(inv.updated_at)}.</p>
            <p>{inv.last_downloaded_at ? `Last downloaded ${ny(inv.last_downloaded_at)}.` : "Never downloaded."}</p>
            {deleted && <p>Deleted {ny(inv.deleted_at!)}.</p>}
          </div>
          <p className={infoBox}>This invoice is a document only. It did not create a Shopify order or change inventory.</p>
          <p>
            <Link href={`/fulfillment/retail/retailers/${inv.retailer_id}`} className="text-black underline">
              Open {inv.retailer_snapshot.name}
            </Link>
          </p>
        </aside>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === "delete" ? `Delete ${inv.invoice_number}?` : `Restore ${inv.invoice_number}?`}
          confirmLabel={confirm === "delete" ? "Delete invoice" : "Restore invoice"}
          busy={busy === "delete"}
          error={confirmError}
          onConfirm={runConfirm}
          onClose={() => {
            setConfirm(null);
            setConfirmError(null);
          }}
        >
          {confirm === "delete" ? (
            <p>The invoice is kept and its PDF prints VOID. Its number is never reused, and order {inv.order_number} becomes free for a new invoice.</p>
          ) : (
            <p>The invoice comes back as it was. This is refused if order {inv.order_number} now has another invoice.</p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
