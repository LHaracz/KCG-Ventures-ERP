"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSupabase } from "@/components/InstantProvider";
import { useAuthedApi } from "@/lib/useWarehouse";
import { formatNyDate, formatNyDateTime } from "@/lib/nyTime";

type FlaggedRow = {
  orderId: string;
  orderName: string;
  orderDate: string | null;
  customerName: string;
  status: string;
  reason: string | null;
  flagSource: string;
  flagDetail: Array<{ product: string; short_by: number }> | null;
  flaggedAt: string | null;
};

/** Dashboard card: every flagged order (manual and out of stock), oldest first. */
export function FlaggedOrdersCard() {
  const { user } = useSupabase();
  const api = useAuthedApi();
  const [rows, setRows] = useState<FlaggedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeFulfilled, setIncludeFulfilled] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api<{ orders: FlaggedRow[] }>(`/api/fulfillments/flagged${includeFulfilled ? "?includeFulfilled=1" : ""}`)
      .then((r) => !cancelled && (setRows(r.orders), setError(null)))
      .catch((e) => !cancelled && setError(e.message || "Couldn't load flagged orders."));
    return () => {
      cancelled = true;
    };
  }, [user, api, includeFulfilled]);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 text-black shadow-sm" aria-label="Flagged Orders">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-black">Flagged Orders{rows ? ` (${rows.length})` : ""}</h2>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={includeFulfilled} onChange={(e) => setIncludeFulfilled(e.target.checked)} className="h-4 w-4" />
          Include fulfilled
        </label>
      </div>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : !rows ? (
        <p className="text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm">No flagged orders</p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border border-zinc-100" data-testid="flagged-orders-scroll">
          <table className="min-w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-zinc-50 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Order date</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Flag type</th>
                <th className="px-3 py-2 font-medium">Flagged at</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orderId} className="border-t border-zinc-100 align-top">
                  <td className="px-3 py-2 font-medium">{r.orderName}</td>
                  <td className="px-3 py-2">{formatNyDate(r.orderDate)}</td>
                  <td className="px-3 py-2">{r.customerName}</td>
                  <td className="px-3 py-2">
                    {r.reason}
                    {r.flagSource === "auto_out_of_stock" && r.flagDetail?.length ? (
                      <div className="text-xs">{r.flagDetail.map((d) => `${d.product} (short ${d.short_by})`).join(", ")}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        r.flagSource === "auto_out_of_stock" ? "bg-amber-200 text-black" : "bg-red-200 text-black"
                      }`}
                    >
                      {r.flagSource === "auto_out_of_stock" ? "Out of stock" : "Manual"}
                    </span>
                  </td>
                  <td className="px-3 py-2">{formatNyDateTime(r.flaggedAt)}</td>
                  <td className="px-3 py-2">
                    <Link href={`/fulfillments/${r.orderId}`} className="text-xs font-medium text-emerald-800 underline">
                      View
                    </Link>
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
