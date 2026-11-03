"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import {
  LastUpdatedNote,
  Modal,
  PackageBadge,
  StatusBadge,
  dangerButton,
  inputClassName,
  primaryButton,
  secondaryButton,
} from "@/components/fulfillment/WarehouseUi";
import { useAuthedApi, useWarehouseData } from "@/lib/useWarehouse";
import { fulfillmentStatusLabel, type FulfillmentStatus } from "@/lib/fulfillmentStatus";
import { formatNyDate } from "@/lib/nyTime";
import { NEEDS_REVIEW_KEY } from "@/lib/packagingEngine";
import type { WarehouseOrder } from "@/lib/warehouse";

const SHIP_STATUSES: FulfillmentStatus[] = ["picked", "label_generated", "label_printed"];
const STATION_KEY = "kcg.shippingAssignments.tab";

function formatOrderTotal(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode || "USD" }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export default function ShippingAssignmentsPage() {
  const { data, loading, error, refresh } = useWarehouseData();
  const api = useAuthedApi();

  const [activeTab, setActiveTab] = useState<string | null>(null);
  const userChoseTab = useRef(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FulfillmentStatus | "all" | "flagged">("all");

  const [moveOrder, setMoveOrder] = useState<WarehouseOrder | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [returnOrder, setReturnOrder] = useState<WarehouseOrder | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const shipOrders = useMemo(
    () => (data?.orders ?? []).filter((o) => SHIP_STATUSES.includes(o.status)),
    [data],
  );

  const tabs = useMemo(() => {
    const defs = [
      ...(data?.tabs ?? []).map((t) => ({ key: t.id, label: t.nickname })),
      { key: NEEDS_REVIEW_KEY, label: "Needs Review" },
    ];
    return defs.map((t) => ({ ...t, count: shipOrders.filter((o) => o.packaging.key === t.key).length }));
  }, [data, shipOrders]);

  // Default tab: the first one that has orders. Once a shipper picks a tab
  // (their station) it stays, and this device remembers it.
  useEffect(() => {
    if (!data) return;
    if (activeTab && tabs.some((t) => t.key === activeTab)) return;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(STATION_KEY);
    } catch {
      /* storage unavailable */
    }
    if (remembered && tabs.some((t) => t.key === remembered)) {
      userChoseTab.current = true;
      setActiveTab(remembered);
      return;
    }
    const first = tabs.find((t) => t.count > 0) ?? tabs[0];
    if (first) setActiveTab(first.key);
  }, [data, tabs, activeTab]);

  const chooseTab = (key: string) => {
    userChoseTab.current = true;
    setActiveTab(key);
    try {
      window.localStorage.setItem(STATION_KEY, key);
    } catch {
      /* storage unavailable */
    }
  };

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase().replace(/^#/, "");
    return shipOrders
      .filter((o) => o.packaging.key === activeTab)
      .filter((o) => {
        if (statusFilter === "all") return true;
        if (statusFilter === "flagged") return o.isFlagged;
        return o.status === statusFilter;
      })
      .filter((o) => {
        if (!needle) return true;
        const box = (o.boxLabel ?? "").toLowerCase();
        const boxNum = box.replace(/^stg-/, "");
        const stgNeedle = needle.replace(/^stg-?/, "");
        return (
          o.name.toLowerCase().replace(/^#/, "").includes(needle) ||
          box.includes(needle) ||
          (!!boxNum && boxNum === stgNeedle)
        );
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.name.localeCompare(b.name));
  }, [shipOrders, activeTab, statusFilter, search]);

  const openMove = (o: WarehouseOrder) => {
    setModalError(null);
    setMoveTarget(o.packaging.key);
    setMoveOrder(o);
  };

  const submitMove = async (clear = false) => {
    if (!moveOrder) return;
    setModalBusy(true);
    setModalError(null);
    try {
      if (clear) {
        await api(`/api/fulfillments/${moveOrder.orderId}/packaging`, { body: { action: "clear" } });
        setFlash(`${moveOrder.name} is back on its suggested package (${moveOrder.packaging.suggestionLabel}).`);
      } else {
        const body =
          moveTarget === NEEDS_REVIEW_KEY
            ? { action: "set", target: "needs_review" }
            : { action: "set", target: "preset", presetId: moveTarget };
        const res = await api<{ package: string }>(`/api/fulfillments/${moveOrder.orderId}/packaging`, { body });
        setFlash(`${moveOrder.name} moved to ${res.package}.`);
      }
      setMoveOrder(null);
      await refresh();
    } catch (err: any) {
      setModalError(err.message || "Couldn't change the package.");
    } finally {
      setModalBusy(false);
    }
  };

  const submitReturn = async () => {
    if (!returnOrder) return;
    setModalBusy(true);
    setModalError(null);
    try {
      await api(`/api/fulfillments/${returnOrder.orderId}/return-to-picking`, { body: {} });
      setFlash(`${returnOrder.name} is back on the Pick List.`);
      setReturnOrder(null);
      await refresh();
    } catch (err: any) {
      setModalError(err.message || "Couldn't return this order to picking.");
    } finally {
      setModalBusy(false);
    }
  };

  const labelExists = (o: WarehouseOrder) => o.status === "label_generated" || o.status === "label_printed";

  return (
    <AuthGuard>
      <div className="mx-auto max-w-7xl space-y-5 text-black">
        <section className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-black">Shipping Assignments</h1>
            <p className="text-sm text-black">Picked orders by package. Each shipper works one tab.</p>
          </div>
          <div className="flex gap-2">
            <Link href="/fulfillments/pick-list" className={secondaryButton}>
              Pick List
            </Link>
            <Link href="/fulfillments" className={secondaryButton}>
              Fulfillments
            </Link>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
            <div>
              <label htmlFor="ship-search" className="mb-1 block text-xs font-medium text-black">
                Search STG box or order #
              </label>
              <input
                id="ship-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="STG-7 or #2554"
                className={inputClassName}
              />
            </div>
            <div>
              <label htmlFor="ship-status" className="mb-1 block text-xs font-medium text-black">
                Status
              </label>
              <select
                id="ship-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as FulfillmentStatus | "all" | "flagged")}
                className={inputClassName}
              >
                <option value="all">All</option>
                <option value="flagged">Flagged</option>
                {SHIP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {fulfillmentStatusLabel(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <LastUpdatedNote meta={data?.meta} />
        </section>

        {flash && (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-black ring-1 ring-emerald-300" role="status">
            {flash}{" "}
            <button type="button" className="ml-2 underline" onClick={() => setFlash(null)}>
              Dismiss
            </button>
          </p>
        )}

        <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div role="tablist" aria-label="Package" className="flex flex-wrap gap-1 border-b border-zinc-200 p-2">
            {tabs.map((t) => {
              const active = t.key === activeTab;
              return (
                <button
                  key={t.key}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  data-testid={`tab-${t.label}`}
                  onClick={() => chooseTab(t.key)}
                  className={`rounded-md px-4 py-2 text-sm font-medium ${
                    active
                      ? t.key === NEEDS_REVIEW_KEY
                        ? "bg-amber-500 text-white"
                        : "bg-emerald-600 text-white"
                      : "bg-white text-black hover:bg-zinc-100"
                  }`}
                >
                  {t.label} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${active ? "bg-white/25" : "bg-zinc-200"}`}>{t.count}</span>
                </button>
              );
            })}
          </div>

          <div className="p-3">
            {loading && !data ? (
              <p className="text-sm text-black">Loading orders…</p>
            ) : error && !data ? (
              <p className="text-sm text-red-700" role="alert">
                {error}
              </p>
            ) : (data?.tabs.length ?? 0) === 0 && shipOrders.length > 0 ? (
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-black ring-1 ring-amber-300">
                No packages have max points set yet, so every order is in Needs Review.{" "}
                <Link href="/fulfillments/package-presets" className="underline">
                  Set them on Packaging Setup
                </Link>
                .
              </p>
            ) : null}
            {data && rows.length === 0 ? (
              <p className="p-2 text-sm text-black">No orders on this tab.</p>
            ) : data ? (
              <>
                {/* Wide screens: table. */}
                <div className="hidden overflow-x-auto lg:block">
                  <table className="min-w-full text-left text-sm text-black">
                    <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-black">
                      <tr>
                        <th className="px-3 py-2 font-medium">Staging box</th>
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
                      {rows.map((o) => (
                        <tr key={o.orderId} className="border-b border-zinc-100 align-top" data-testid={`ship-row-${o.orderId}`}>
                          <td className="whitespace-nowrap px-3 py-2 text-base font-semibold">{o.boxLabel ?? "—"}</td>
                          <td className="px-3 py-2 font-medium">
                            {o.name}
                            <PackageNote o={o} />
                          </td>
                          <td className="px-3 py-2">{formatNyDate(o.createdAt)}</td>
                          <td className="px-3 py-2">{o.customerName}</td>
                          <td className="px-3 py-2">
                            <ItemLines o={o} />
                          </td>
                          <td className="px-3 py-2">{o.totalProductWeightOz.toFixed(1)} oz</td>
                          <td className="px-3 py-2">{formatOrderTotal(o.totalPrice, o.currencyCode)}</td>
                          <td className="px-3 py-2">
                            <StatusBadge status={o.status} isFlagged={o.isFlagged} flaggedReason={o.flaggedReason} />
                          </td>
                          <td className="px-3 py-2">
                            <RowActions o={o} onMove={() => openMove(o)} onReturn={() => { setModalError(null); setReturnOrder(o); }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Tablets and phones: cards. */}
                <ul className="space-y-3 lg:hidden">
                  {rows.map((o) => (
                    <li key={o.orderId} className="rounded-md border border-zinc-200 p-3" data-testid={`ship-card-${o.orderId}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-lg font-semibold">{o.boxLabel ?? "—"}</p>
                          <p className="font-medium">
                            {o.name} · {formatNyDate(o.createdAt)}
                          </p>
                          <p>{o.customerName}</p>
                        </div>
                        <StatusBadge status={o.status} isFlagged={o.isFlagged} flaggedReason={o.flaggedReason} />
                      </div>
                      <div className="mt-2">
                        <ItemLines o={o} />
                      </div>
                      <p className="mt-1 text-sm">
                        {o.totalProductWeightOz.toFixed(1)} oz · {formatOrderTotal(o.totalPrice, o.currencyCode)}
                      </p>
                      <PackageNote o={o} />
                      <div className="mt-2">
                        <RowActions o={o} onMove={() => openMove(o)} onReturn={() => { setModalError(null); setReturnOrder(o); }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </section>

        {moveOrder && (
          <Modal title={`Move ${moveOrder.name} to another package`} onClose={() => setMoveOrder(null)}>
            <p className="text-sm text-black">
              Suggested: <strong>{moveOrder.packaging.suggestionLabel}</strong>
              {moveOrder.packaging.overridden ? ` · now: ${moveOrder.packaging.label}` : ""}
            </p>
            <fieldset className="mt-3 space-y-1">
              <legend className="sr-only">Package</legend>
              {[...(data?.tabs ?? []).map((t) => ({ key: t.id, label: `${t.nickname} (max ${t.maxPoints} points)` })), { key: NEEDS_REVIEW_KEY, label: "Needs Review" }].map(
                (opt) => (
                  <label key={opt.key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-black hover:bg-zinc-50">
                    <input
                      type="radio"
                      name="move-target"
                      value={opt.key}
                      checked={moveTarget === opt.key}
                      onChange={() => setMoveTarget(opt.key)}
                      className="h-4 w-4"
                    />
                    {opt.label}
                  </label>
                ),
              )}
            </fieldset>
            {modalError && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {modalError}
              </p>
            )}
            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <div>
                {moveOrder.packaging.overridden && (
                  <button type="button" className={secondaryButton} disabled={modalBusy} onClick={() => submitMove(true)}>
                    Clear override
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" className={secondaryButton} onClick={() => setMoveOrder(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={primaryButton}
                  disabled={modalBusy || !moveTarget || (moveTarget === moveOrder.packaging.key && moveOrder.packaging.overridden)}
                  onClick={() => submitMove(false)}
                >
                  {modalBusy ? "Saving…" : "Move"}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {returnOrder && (
          <Modal title="Return to picking" onClose={() => setReturnOrder(null)}>
            {labelExists(returnOrder) ? (
              <p className="text-sm text-black">
                {returnOrder.name} already has a shipping label. Void the label first (on the order page), then return it to
                picking.
              </p>
            ) : (
              <p className="text-sm text-black">
                Return order {returnOrder.name} to picking? The items need to go back on the shelves and{" "}
                {returnOrder.boxLabel ?? "its staging box"} will be freed.
              </p>
            )}
            {modalError && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {modalError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={secondaryButton} onClick={() => setReturnOrder(null)}>
                {labelExists(returnOrder) ? "Close" : "Cancel"}
              </button>
              {!labelExists(returnOrder) && (
                <button type="button" className={dangerButton} disabled={modalBusy} onClick={submitReturn}>
                  {modalBusy ? "Returning…" : "Return to picking"}
                </button>
              )}
            </div>
          </Modal>
        )}
      </div>
    </AuthGuard>
  );
}

function ItemLines({ o }: { o: WarehouseOrder }) {
  return (
    <ul className="space-y-0.5 text-sm text-black">
      {o.componentLines.map((l) => (
        <li key={l}>{l}</li>
      ))}
      {o.unmappedLineItems.map((n) => (
        <li key={`u-${n}`}>⚠ Unmapped: {n}</li>
      ))}
    </ul>
  );
}

function PackageNote({ o }: { o: WarehouseOrder }) {
  const showReason = o.packaging.key === NEEDS_REVIEW_KEY;
  if (!showReason && !o.packaging.overridden) return null;
  return (
    <div className="mt-1 space-y-1">
      {o.packaging.overridden && <PackageBadge pkg={o.packaging} />}
      {showReason && <p className="max-w-xs text-xs font-normal text-black">{o.packaging.reason}</p>}
    </div>
  );
}

function RowActions({ o, onMove, onReturn }: { o: WarehouseOrder; onMove: () => void; onReturn: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <Link href={`/fulfillments/${o.orderId}`} className={secondaryButton}>
        View
      </Link>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${o.name}`}
        onClick={() => setOpen((v) => !v)}
        className={secondaryButton}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-zinc-200 bg-white py-1 shadow-lg">
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-black hover:bg-zinc-50"
            onClick={() => {
              setOpen(false);
              onMove();
            }}
          >
            Move to another package
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-black hover:bg-zinc-50"
            onClick={() => {
              setOpen(false);
              onReturn();
            }}
          >
            Return to picking
          </button>
        </div>
      )}
    </div>
  );
}
