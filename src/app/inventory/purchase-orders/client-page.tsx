"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { fetchActiveCompanyProfiles, type CompanyProfile } from "@/lib/companyProfiles";
import {
  fetchPurchaseOrders,
  softDeletePurchaseOrder,
  restorePurchaseOrder,
  formatMoney,
  type PurchaseOrder,
} from "@/lib/purchaseOrders";

const PAGE_SIZE = 20;

function PaginationControls({
  page,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (totalItems <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-600">
      <span>
        Showing {start}-{end} of {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPageChange(p)}
            className={`rounded-md px-2 py-1 font-medium ${
              p === page ? "bg-emerald-600 text-white" : "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
            }`}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

export default function PurchaseOrdersListPage() {
  const { user, supabase } = useSupabase();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [profiles, setProfiles] = useState<CompanyProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [businessFilter, setBusinessFilter] = useState<string>("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [page, setPage] = useState(1);

  const [actionsFor, setActionsFor] = useState<PurchaseOrder | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PurchaseOrder | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [ordersData, profilesData] = await Promise.all([
        fetchPurchaseOrders(supabase, { includeDeleted: true }),
        fetchActiveCompanyProfiles(supabase),
      ]);
      setOrders(ordersData);
      setProfiles(profilesData);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load purchase orders.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!actionsFor && !confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActionsFor(null);
        setConfirmDelete(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actionsFor, confirmDelete]);

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((po) => {
      if (!showDeleted && po.deleted_at) return false;
      if (showDeleted && !po.deleted_at) return false;
      if (businessFilter !== "all" && po.company_profile_id !== businessFilter) return false;
      if (q && !po.po_number.toLowerCase().includes(q) && !po.vendor_name.toLowerCase().includes(q) && !(po.reference_number ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [orders, search, businessFilter, showDeleted]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredOrders.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setBusyId(confirmDelete.id);
    setActionError(null);
    try {
      await softDeletePurchaseOrder(supabase, confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (err: any) {
      setActionError(err.message || "Failed to delete this purchase order.");
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (po: PurchaseOrder) => {
    setBusyId(po.id);
    setActionError(null);
    try {
      await restorePurchaseOrder(supabase, po.id);
      await load();
    } catch (err: any) {
      setActionError(err.message || "Failed to restore this purchase order.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Purchase Orders</h1>
            <p className="text-sm text-black">Create, track, and reorder purchase orders for your vendors.</p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/inventory/purchase-orders/settings"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Business profiles
            </Link>
            <Link
              href="/inventory/purchase-orders/new"
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
            >
              New Purchase Order
            </Link>
          </div>
        </div>

        {loadError && (
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700" role="alert">
            {loadError}
          </p>
        )}
        {actionError && (
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700" role="alert">
            {actionError}
          </p>
        )}

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1">
              <label className="mb-1 block text-xs font-medium text-zinc-800">Search</label>
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="PO number, vendor, reference…"
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Business</label>
              <select
                value={businessFilter}
                onChange={(e) => {
                  setBusinessFilter(e.target.value);
                  setPage(1);
                }}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm"
              >
                <option value="all">All businesses</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-1.5 pb-1.5 text-xs text-black">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => {
                  setShowDeleted(e.target.checked);
                  setPage(1);
                }}
                className="h-3.5 w-3.5"
              />
              Show deleted
            </label>
          </div>

          {loading ? (
            <p className="text-xs text-black">Loading purchase orders…</p>
          ) : filteredOrders.length === 0 ? (
            <p className="text-xs text-black">
              {showDeleted ? "No deleted purchase orders." : "No purchase orders yet. Create one to get started."}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-xs">
                  <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Actions</th>
                      <th className="px-3 py-2 font-medium">PO #</th>
                      <th className="px-3 py-2 font-medium">Business</th>
                      <th className="px-3 py-2 font-medium">Vendor</th>
                      <th className="px-3 py-2 font-medium">Order date</th>
                      <th className="px-3 py-2 font-medium">Needed by</th>
                      <th className="px-3 py-2 font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((po) => (
                      <tr key={po.id} className="border-b border-zinc-100">
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => setActionsFor(po)}
                            className="inline-flex items-center rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-black shadow-sm hover:bg-zinc-50"
                          >
                            Actions
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/inventory/purchase-orders/${po.id}`}
                            className="inline-flex items-center rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-zinc-800"
                          >
                            {po.po_number}
                          </Link>
                          {po.deleted_at && (
                            <div className="mt-1">
                              <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">Deleted</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-zinc-700">{po.company_snapshot.display_name}</td>
                        <td className="px-3 py-2 text-zinc-700">{po.vendor_name}</td>
                        <td className="px-3 py-2 text-zinc-700">{formatDate(po.order_date)}</td>
                        <td className="px-3 py-2 text-zinc-700">{formatDate(po.needed_by_date)}</td>
                        <td className="px-3 py-2 text-zinc-700">{formatMoney(po.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <PaginationControls page={safePage} totalItems={filteredOrders.length} pageSize={PAGE_SIZE} onPageChange={setPage} />
            </>
          )}
        </section>

        {actionsFor && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setActionsFor(null)}>
            <div className="w-full max-w-xs rounded-md border border-zinc-200 bg-white p-3" onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-black">{actionsFor.po_number}</h2>
                <button type="button" onClick={() => setActionsFor(null)} aria-label="Close" className="text-zinc-500 hover:text-zinc-700">
                  ✕
                </button>
              </div>
              <div className="space-y-1">
                <Link
                  href={`/inventory/purchase-orders/${actionsFor.id}`}
                  onClick={() => setActionsFor(null)}
                  className="block rounded-md px-3 py-2 text-sm font-medium text-black hover:bg-zinc-50"
                >
                  View
                </Link>
                {!actionsFor.deleted_at && (
                  <>
                    <Link
                      href={`/inventory/purchase-orders/${actionsFor.id}/edit`}
                      onClick={() => setActionsFor(null)}
                      className="block rounded-md px-3 py-2 text-sm font-medium text-black hover:bg-zinc-50"
                    >
                      Edit
                    </Link>
                    <Link
                      href={`/inventory/purchase-orders/new?duplicateFrom=${actionsFor.id}`}
                      onClick={() => setActionsFor(null)}
                      className="block rounded-md px-3 py-2 text-sm font-medium text-black hover:bg-zinc-50"
                    >
                      Duplicate
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDelete(actionsFor);
                        setActionsFor(null);
                      }}
                      className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-red-600 hover:bg-zinc-50"
                    >
                      Delete
                    </button>
                  </>
                )}
                {actionsFor.deleted_at && (
                  <button
                    type="button"
                    disabled={busyId === actionsFor.id}
                    onClick={() => {
                      handleRestore(actionsFor);
                      setActionsFor(null);
                    }}
                    className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-black hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyId === actionsFor.id ? "Restoring…" : "Restore"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDelete(null)}>
            <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-sm font-semibold text-zinc-900">Delete {confirmDelete.po_number}?</h2>
              <p className="mt-2 text-xs text-zinc-700">
                This PO will be hidden from the active list and marked deleted. Its number is never reused, and you can restore it later with "Show
                deleted".
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Keep PO
                </button>
                <button
                  type="button"
                  disabled={busyId === confirmDelete.id}
                  onClick={handleDelete}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {busyId === confirmDelete.id ? "Deleting…" : "Delete PO"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
