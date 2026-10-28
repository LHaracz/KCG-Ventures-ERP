"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import {
  fetchPurchaseOrderWithLines,
  softDeletePurchaseOrder,
  restorePurchaseOrder,
  fetchPurchaseOrderPdfBlob,
  triggerBrowserDownload,
  formatMoney,
  type PurchaseOrderWithLines,
} from "@/lib/purchaseOrders";

// pdfjs-dist touches browser-only globals (canvas, worker) — client-side only.
const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => <p className="pt-8 text-center text-xs text-zinc-600">Loading viewer…</p>,
});

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-900">{value}</span>
    </div>
  );
}

export default function PurchaseOrderDetailPage() {
  const { user, supabase } = useSupabase();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [po, setPo] = useState<PurchaseOrderWithLines | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState<"preview" | "download" | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchPurchaseOrderWithLines(supabase, id);
      if (!data) setLoadError("Purchase order not found.");
      else setPo(data);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load this purchase order.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  const handleDelete = async () => {
    if (!po) return;
    setBusy(true);
    setActionError(null);
    try {
      await softDeletePurchaseOrder(supabase, po.id);
      setConfirmDelete(false);
      await load();
    } catch (err: any) {
      setActionError(err.message || "Failed to delete this purchase order.");
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!po) return;
    setBusy(true);
    setActionError(null);
    try {
      await restorePurchaseOrder(supabase, po.id);
      await load();
    } catch (err: any) {
      setActionError(err.message || "Failed to restore this purchase order.");
    } finally {
      setBusy(false);
    }
  };

  const getAuthToken = async (): Promise<string> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("Unable to verify your session.");
    return session.access_token;
  };

  const handlePreview = async () => {
    if (!po) return;
    setPdfError(null);
    setPdfBusy("preview");
    try {
      const token = await getAuthToken();
      const blob = await fetchPurchaseOrderPdfBlob(token, po.id, "inline");
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err: any) {
      setPdfError(err.message || "Failed to generate the preview.");
    } finally {
      setPdfBusy(null);
    }
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  };

  const handleDownload = async () => {
    if (!po) return;
    setPdfError(null);
    setPdfBusy("download");
    try {
      const token = await getAuthToken();
      const blob = await fetchPurchaseOrderPdfBlob(token, po.id, "attachment");
      triggerBrowserDownload(blob, `${po.po_number}.pdf`);
      await load(); // picks up the fresh last_downloaded_at
    } catch (err: any) {
      setPdfError(err.message || "Failed to download the PDF.");
    } finally {
      setPdfBusy(null);
    }
  };

  if (loading) {
    return (
      <AuthGuard>
        <p className="text-xs text-black">Loading…</p>
      </AuthGuard>
    );
  }

  if (loadError || !po) {
    return (
      <AuthGuard>
        <div className="mx-auto max-w-4xl space-y-3">
          <Link href="/inventory/purchase-orders" className="text-[11px] font-medium text-emerald-700 underline">
            ← Back to Purchase Orders
          </Link>
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700" role="alert">
            {loadError || "Purchase order not found."}
          </p>
        </div>
      </AuthGuard>
    );
  }

  const snapshot = po.company_snapshot;

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <Link href="/inventory/purchase-orders" className="mb-1 inline-block text-[11px] font-medium text-emerald-700 underline">
              ← Back to Purchase Orders
            </Link>
            <h1 className="text-2xl font-semibold text-zinc-900">
              {po.po_number}
              {po.deleted_at && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">Deleted</span>}
            </h1>
            <p className="text-sm text-black">
              {snapshot.display_name} → {po.vendor_name}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pdfBusy !== null}
              onClick={handlePreview}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pdfBusy === "preview" ? "Generating…" : "Preview PDF"}
            </button>
            <button
              type="button"
              disabled={pdfBusy !== null}
              onClick={handleDownload}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pdfBusy === "download" ? "Generating…" : "Download PDF"}
            </button>
            {!po.deleted_at && (
              <>
                <Link
                  href={`/inventory/purchase-orders/new?duplicateFrom=${po.id}`}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                >
                  Duplicate
                </Link>
                <Link
                  href={`/inventory/purchase-orders/${po.id}/edit`}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                >
                  Edit
                </Link>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 shadow-sm hover:bg-red-50"
                >
                  Delete
                </button>
              </>
            )}
            {po.deleted_at && (
              <button
                type="button"
                disabled={busy}
                onClick={handleRestore}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Restoring…" : "Restore"}
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700" role="alert">
            {actionError}
          </p>
        )}
        {pdfError && (
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700" role="alert">
            {pdfError}
          </p>
        )}
        {po.last_downloaded_at && (
          <p className="text-[11px] text-zinc-500">Last downloaded {formatDate(po.last_downloaded_at)}.</p>
        )}

        <section className="grid gap-4 rounded-md border border-zinc-200 bg-white p-4 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">From</p>
            <p className="text-sm font-medium text-zinc-900">{snapshot.legal_name}</p>
            {snapshot.address_line1 && <p className="text-xs text-zinc-700">{snapshot.address_line1}</p>}
            {snapshot.address_line2 && <p className="text-xs text-zinc-700">{snapshot.address_line2}</p>}
            <p className="text-xs text-zinc-700">
              {[snapshot.city, snapshot.state].filter(Boolean).join(", ")} {snapshot.zip}
            </p>
            {snapshot.phone && <p className="text-xs text-zinc-700">{snapshot.phone}</p>}
            {snapshot.email && <p className="text-xs text-zinc-700">{snapshot.email}</p>}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Vendor</p>
            <p className="text-sm font-medium text-zinc-900">{po.vendor_name}</p>
            {po.vendor_contact_name && <p className="text-xs text-zinc-700">{po.vendor_contact_name}</p>}
            <p className="text-xs text-zinc-700">{po.vendor_address_line1}</p>
            {po.vendor_address_line2 && <p className="text-xs text-zinc-700">{po.vendor_address_line2}</p>}
            <p className="text-xs text-zinc-700">
              {po.vendor_city}, {po.vendor_state} {po.vendor_zip}
            </p>
            {po.vendor_phone && <p className="text-xs text-zinc-700">{po.vendor_phone}</p>}
            {po.vendor_email && <p className="text-xs text-zinc-700">{po.vendor_email}</p>}
          </div>
        </section>

        <section className="grid gap-2 rounded-md border border-zinc-200 bg-white p-4 sm:grid-cols-2">
          <Row label="Order date" value={formatDate(po.order_date)} />
          <Row label="Needed by" value={formatDate(po.needed_by_date)} />
          <Row label="Payment terms" value={po.payment_terms} />
          <Row label="Shipping method" value={po.shipping_method} />
          <Row label="Freight terms" value={po.freight_terms} />
          <Row label="Reference #" value={po.reference_number} />
          <Row label="Prepared by" value={po.prepared_by_name} />
          <Row label="Authorized by" value={`${po.authorized_by_name} (${po.authorized_by_title})`} />
          <Row label="Buyer phone" value={po.buyer_phone} />
          <Row label="Buyer email" value={po.buyer_email} />
        </section>

        <section className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Ship to</p>
          <p className="text-xs text-zinc-900">{po.ship_to.name}</p>
          {po.ship_to.contact_name && <p className="text-xs text-zinc-700">{po.ship_to.contact_name}</p>}
          <p className="text-xs text-zinc-700">{po.ship_to.address_line1}</p>
          {po.ship_to.address_line2 && <p className="text-xs text-zinc-700">{po.ship_to.address_line2}</p>}
          <p className="text-xs text-zinc-700">
            {po.ship_to.city}, {po.ship_to.state} {po.ship_to.zip}
          </p>
          {po.ship_to.delivery_instructions && <p className="mt-1 text-[11px] text-zinc-500">{po.ship_to.delivery_instructions}</p>}
        </section>

        <section className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Line items</p>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-xs">
              <thead className="bg-zinc-50 text-[11px] text-zinc-500">
                <tr>
                  <th className="px-2 py-1 font-medium">Item #</th>
                  <th className="px-2 py-1 font-medium">Description</th>
                  <th className="px-2 py-1 font-medium">Qty</th>
                  <th className="px-2 py-1 font-medium">Unit</th>
                  <th className="px-2 py-1 font-medium">Unit price</th>
                  <th className="px-2 py-1 font-medium">Line total</th>
                </tr>
              </thead>
              <tbody>
                {po.po_lines.map((line) => (
                  <tr key={line.id} className="border-b border-zinc-100">
                    <td className="px-2 py-1 text-zinc-700">{line.item_number || "—"}</td>
                    <td className="px-2 py-1 text-zinc-900">{line.description}</td>
                    <td className="px-2 py-1 text-zinc-700">{line.quantity}</td>
                    <td className="px-2 py-1 text-zinc-700">{line.unit}</td>
                    <td className="px-2 py-1 text-zinc-700">{formatMoney(line.unit_price)}</td>
                    <td className="px-2 py-1 text-zinc-700">{formatMoney(line.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 ml-auto max-w-xs space-y-1 text-xs text-zinc-700">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span>{formatMoney(po.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Shipping</span>
              <span>{formatMoney(po.shipping_cost)}</span>
            </div>
            <div className="flex justify-between">
              <span>Tax{po.tax_exempt ? " (exempt)" : ` (${po.tax_rate_percent}%)`}</span>
              <span>{formatMoney(po.tax_amount)}</span>
            </div>
            <div className="flex justify-between border-t border-zinc-200 pt-1 text-sm font-semibold text-zinc-900">
              <span>Total</span>
              <span>{formatMoney(po.total)}</span>
            </div>
          </div>
        </section>

        {(po.special_instructions || po.terms_text || po.notes_to_vendor || po.internal_notes) && (
          <section className="space-y-3 rounded-md border border-zinc-200 bg-white p-4">
            {po.special_instructions && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Special instructions</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-700">{po.special_instructions}</p>
              </div>
            )}
            {po.notes_to_vendor && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Notes to vendor</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-700">{po.notes_to_vendor}</p>
              </div>
            )}
            {po.terms_text && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Terms &amp; conditions</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-700">{po.terms_text}</p>
              </div>
            )}
            {po.internal_notes && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Internal notes (not printed on the PO)</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-700">{po.internal_notes}</p>
              </div>
            )}
          </section>
        )}

        {previewUrl && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closePreview}>
            <div className="flex h-[90vh] w-full max-w-3xl flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">{po.po_number} — Preview</h2>
                <button
                  type="button"
                  onClick={closePreview}
                  className="rounded-md bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-100"
                >
                  Close
                </button>
              </div>
              <div className="flex-1">
                <PdfViewer fileUrl={previewUrl} />
              </div>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDelete(false)}>
            <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-sm font-semibold text-zinc-900">Delete {po.po_number}?</h2>
              <p className="mt-2 text-xs text-zinc-700">
                This PO will be hidden from the list and marked deleted. Its number ({po.po_number}) is never reused. You can restore it later from the
                "Show deleted" view.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Keep PO
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDelete}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {busy ? "Deleting…" : "Delete PO"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
