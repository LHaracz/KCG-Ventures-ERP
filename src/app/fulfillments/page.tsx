"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate, toMidnight } from "@/lib/date";
import {
  FULFILLMENT_STATUSES,
  fulfillmentStatusBadge,
  fulfillmentStatusLabel,
  type FulfillmentStatus,
} from "@/lib/fulfillmentStatus";

type FulfillmentListRow = {
  orderId: string;
  name: string;
  createdAt: string;
  customerName: string;
  itemCount: number;
  totalProductWeightOz: number;
  totalPrice: number;
  currencyCode: string;
  status: FulfillmentStatus;
};

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function formatOrderTotal(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode || "USD",
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export default function FulfillmentsPage() {
  const { user, supabase } = useSupabase();

  const [orders, setOrders] = useState<FulfillmentListRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const [orderIdFilter, setOrderIdFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [statusFilter, setStatusFilter] = useState<FulfillmentStatus | "all">("all");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setOrdersLoading(true);
      setOrdersError(null);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error("Unable to verify your session.");
        const response = await fetch("/api/fulfillments", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = (await response.json()) as {
          orders?: FulfillmentListRow[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "Failed to load unfulfilled orders.");
        }
        if (!cancelled) setOrders(payload.orders || []);
      } catch (err: any) {
        if (!cancelled) setOrdersError(err.message || "Failed to load unfulfilled orders.");
      } finally {
        if (!cancelled) setOrdersLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  const visibleOrders = useMemo(() => {
    const orderIdNeedle = orderIdFilter.trim().toLowerCase();
    const customerNeedle = customerFilter.trim().toLowerCase();
    const afterMs = dateAfter ? toMidnight(dateAfter).getTime() : null;
    // Inclusive of the whole "before" day.
    const beforeMs = dateBefore ? toMidnight(dateBefore).getTime() + 24 * 60 * 60 * 1000 - 1 : null;

    const filtered = orders.filter((o) => {
      if (orderIdNeedle && !o.name.toLowerCase().includes(orderIdNeedle)) return false;
      if (customerNeedle && !o.customerName.toLowerCase().includes(customerNeedle)) return false;
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (afterMs != null || beforeMs != null) {
        const createdMs = new Date(o.createdAt).getTime();
        if (afterMs != null && createdMs < afterMs) return false;
        if (beforeMs != null && createdMs > beforeMs) return false;
      }
      return true;
    });

    return filtered.sort((a, b) => {
      // Fulfilled orders always sink to the bottom, regardless of direction.
      const aFulfilled = a.status === "fulfilled" ? 1 : 0;
      const bFulfilled = b.status === "fulfilled" ? 1 : 0;
      if (aFulfilled !== bFulfilled) return aFulfilled - bFulfilled;

      const aNum = Number(a.name.replace(/[^0-9]/g, "")) || 0;
      const bNum = Number(b.name.replace(/[^0-9]/g, "")) || 0;
      return sortDirection === "asc" ? aNum - bNum : bNum - aNum;
    });
  }, [orders, orderIdFilter, customerFilter, dateAfter, dateBefore, statusFilter, sortDirection]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <section>
          <h1 className="mb-2 text-2xl font-semibold text-zinc-900">Fulfillments</h1>
          <p className="text-sm text-black">
            Unfulfilled Shopify orders, oldest first, with product weight for label
            planning.
          </p>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Setup</h2>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/fulfillments/package-presets"
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
            >
              Package Presets
            </Link>
            <Link
              href="/fulfillments/settings"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Fulfillments Settings
            </Link>
            <Link
              href="/settings/shipping-methods"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Shipping Methods
            </Link>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Filter &amp; Sort</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Order #</label>
              <input
                value={orderIdFilter}
                onChange={(e) => setOrderIdFilter(e.target.value)}
                placeholder="#1082"
                className={inputClassName}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Customer</label>
              <input
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                placeholder="Name"
                className={inputClassName}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Created after</label>
              <input
                type="date"
                value={dateAfter}
                onChange={(e) => setDateAfter(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Created before</label>
              <input
                type="date"
                value={dateBefore}
                onChange={(e) => setDateBefore(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as FulfillmentStatus | "all")}
                className={inputClassName}
              >
                <option value="all">All</option>
                {FULFILLMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {fulfillmentStatusLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Sort by Order #</label>
              <select
                value={sortDirection}
                onChange={(e) => setSortDirection(e.target.value as "asc" | "desc")}
                className={inputClassName}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          {ordersLoading ? (
            <p className="text-xs text-black">Loading unfulfilled orders…</p>
          ) : ordersError ? (
            <p className="text-xs text-red-600" role="alert">
              {ordersError}
            </p>
          ) : orders.length === 0 ? (
            <p className="text-xs text-black">No unfulfilled orders right now.</p>
          ) : visibleOrders.length === 0 ? (
            <p className="text-xs text-black">No orders match the current filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Order</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium">Items</th>
                    <th className="px-3 py-2 font-medium">Product Weight</th>
                    <th className="px-3 py-2 font-medium">Order Total</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((o) => {
                    const badge = fulfillmentStatusBadge(o.status);
                    return (
                      <tr key={o.orderId} className="border-b border-zinc-100">
                        <td className="px-3 py-2 font-medium text-zinc-900">{o.name}</td>
                        <td className="px-3 py-2 text-zinc-700">{formatDate(o.createdAt)}</td>
                        <td className="px-3 py-2 text-zinc-700">{o.customerName}</td>
                        <td className="px-3 py-2 text-zinc-700">{o.itemCount}</td>
                        <td className="px-3 py-2 text-zinc-700">
                          {o.totalProductWeightOz.toFixed(1)} oz
                        </td>
                        <td className="px-3 py-2 text-zinc-700">
                          {formatOrderTotal(o.totalPrice, o.currencyCode)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={badge.className}>{badge.label}</span>
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/fulfillments/${o.orderId}`}
                            className="text-[11px] font-medium text-emerald-700 underline"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AuthGuard>
  );
}
