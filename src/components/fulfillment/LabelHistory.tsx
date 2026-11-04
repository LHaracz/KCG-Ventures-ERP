"use client";

import { useState } from "react";
import { Modal } from "@/components/fulfillment/WarehouseUi";
import { formatNyDateTime } from "@/lib/nyTime";

/** One row of fulfillment_log: every label ever bought for an order. */
export type LabelRow = {
  id: string;
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
  label_url: string | null;
  rate_amount: number | string | null;
  rate_currency: string | null;
  created_at: string;
  printed_at: string | null;
  voided_at: string | null;
  fulfilled_at: string | null;
  refund_status: string | null;
  refund_message: string | null;
  void_note: string | null;
  is_replacement: boolean | null;
  shopify_tracking_synced_at: string | null;
  shopify_sync_error: string | null;
};

export const REFUND_LABELS: Record<string, string> = {
  not_requested: "Not requested",
  submitted: "Refund requested",
  refunded: "Refunded",
  rejected: "Refund rejected",
  not_applicable: "No refund needed",
  error: "Refund request failed",
};

/** "message." without doubling the message's own final punctuation. */
export function sentence(message: string | null | undefined, fallback: string): string {
  const m = (message ?? "").trim() || fallback;
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** Plain-words outcome shown after a void (and on the history). */
export function voidOutcomeText(refund: { status: string | null; message: string | null }): string {
  switch (refund.status) {
    case "submitted":
      return "Label voided. Refund requested.";
    case "refunded":
      return "Label voided. Postage refunded.";
    case "not_applicable":
      return "Label voided. No refund was needed.";
    case "rejected":
      return `Label voided. EasyPost rejected the refund: ${sentence(refund.message, "no reason given")} You may not get this postage back.`;
    default:
      return `Label voided. The refund request failed: ${sentence(refund.message, "unknown error")} You can retry the refund from Label history.`;
  }
}

function money(amount: number | string | null, currency: string | null) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export function VoidLabelModal({
  fulfilled,
  trackingNumber,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  fulfilled: boolean;
  trackingNumber: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  return (
    <Modal title="Void this label?" onClose={onCancel}>
      <div className="space-y-3 text-sm text-black">
        <p>
          We&apos;ll ask EasyPost for a refund and void the label here so you can create a new one. If the carrier refuses the
          refund (for example because the label was already scanned), the label is still voided here, but you may not get the
          postage back and the old label must not be used.
        </p>
        {fulfilled && (
          <p className="rounded-md bg-amber-50 px-2 py-1.5 ring-1 ring-amber-300" data-testid="void-fulfilled-note">
            Shopify still shows tracking number {trackingNumber ?? "—"} until you generate a replacement label.
          </p>
        )}
        <div>
          <label htmlFor="void-note" className="mb-1 block text-xs font-medium">
            Note (optional)
          </label>
          <input
            id="void-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example: wrong address"
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-black"
          />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="h-4 w-4" />
          I won&apos;t use the old label
        </label>
        {error && (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-50"
          >
            Keep Label
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note)}
            disabled={!ack || busy}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Voiding…" : "Void Label"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function LabelHistory({
  labels,
  busyId,
  onRetryRefund,
  onCheckRefund,
}: {
  labels: LabelRow[];
  busyId: string | null;
  onRetryRefund: (label: LabelRow) => void;
  onCheckRefund: (label: LabelRow) => void;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 text-black shadow-sm" aria-label="Label history" data-testid="label-history">
      <h2 className="mb-2 text-sm font-semibold text-black">Label history</h2>
      {labels.length === 0 ? (
        <p className="text-xs text-black">No labels yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs text-black">
            <thead className="text-[11px] uppercase tracking-wide">
              <tr>
                <th className="py-1 pr-3 font-medium">Tracking</th>
                <th className="py-1 pr-3 font-medium">Carrier and service</th>
                <th className="py-1 pr-3 font-medium">Cost</th>
                <th className="py-1 pr-3 font-medium">Created</th>
                <th className="py-1 pr-3 font-medium">Printed</th>
                <th className="py-1 pr-3 font-medium">Voided</th>
                <th className="py-1 pr-3 font-medium">Refund</th>
                <th className="py-1 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {labels.map((l) => (
                <tr key={l.id} className="border-t border-zinc-100 align-top" data-testid={`label-row-${l.tracking_number}`}>
                  <td className="py-1.5 pr-3 font-medium">
                    {l.tracking_number ?? "—"}
                    {!l.voided_at && <span className="ml-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px]">Active</span>}
                    {l.is_replacement && <span className="ml-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px]">Replacement</span>}
                  </td>
                  <td className="py-1.5 pr-3">{[l.carrier, l.service].filter(Boolean).join(" ") || "—"}</td>
                  <td className="py-1.5 pr-3">{money(l.rate_amount, l.rate_currency)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{formatNyDateTime(l.created_at)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{l.printed_at ? formatNyDateTime(l.printed_at) : "—"}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {l.voided_at ? formatNyDateTime(l.voided_at) : "—"}
                    {l.void_note && <div className="text-[11px]">Note: {l.void_note}</div>}
                  </td>
                  <td className="py-1.5 pr-3">
                    {l.voided_at ? REFUND_LABELS[l.refund_status ?? ""] ?? "Unknown" : "—"}
                    {l.voided_at && l.refund_message && <div className="max-w-xs text-[11px]">{l.refund_message}</div>}
                  </td>
                  <td className="py-1.5 whitespace-nowrap">
                    {l.voided_at && (l.refund_status === "rejected" || l.refund_status === "error") && (
                      <button
                        type="button"
                        disabled={busyId === l.id}
                        onClick={() => onRetryRefund(l)}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-black hover:bg-zinc-50 disabled:opacity-50"
                      >
                        Retry refund
                      </button>
                    )}
                    {l.voided_at && l.refund_status === "submitted" && (
                      <button
                        type="button"
                        disabled={busyId === l.id}
                        onClick={() => onCheckRefund(l)}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-black hover:bg-zinc-50 disabled:opacity-50"
                      >
                        Check status
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
