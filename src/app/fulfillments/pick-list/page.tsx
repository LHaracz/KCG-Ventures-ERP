"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import {
  BoxPicker,
  LastUpdatedNote,
  Modal,
  PackageBadge,
  StatusBadge,
  dangerButton,
  inputClassName,
  primaryButton,
  secondaryButton,
} from "@/components/fulfillment/WarehouseUi";
import { ApiError, useAuthedApi, useWarehouseData } from "@/lib/useWarehouse";
import { formatNyDate, formatNyDateTime, formatNyTime } from "@/lib/nyTime";
import type { StagingBox, WarehouseOrder } from "@/lib/warehouse";
import { planAllocations, type AllocLine } from "@/lib/batchAllocation";

type Override = { reason: string; note: string; byProduct: Record<string, Record<string, string>> };
type RowMessage = { tone: "error" | "notice"; text: string; link?: { href: string; label: string } };

const COUNT_BOXES_HREF = "/finished-products-inventory?view=batches&count=1";
const OVERRIDE_REASONS = ["Mislabeled box", "Grabbed wrong box", "Other"] as const;

const BOX_ERROR_CODES = new Set(["box_in_use", "box_retired", "box_not_found"]);

export default function PickListPage() {
  const { data, loading, error, refresh } = useWarehouseData();
  const api = useAuthedApi();

  const [search, setSearch] = useState("");
  const [fromBottom, setFromBottom] = useState(false);
  const [includeFlagged, setIncludeFlagged] = useState(false);

  // Per-row state survives refreshes (keyed by order id).
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [rowMessages, setRowMessages] = useState<Record<string, RowMessage>>({});
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [overrideEditor, setOverrideEditor] = useState<{ order: WarehouseOrder; line: AllocLine } | null>(null);
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [pickedLocally, setPickedLocally] = useState<Set<string>>(new Set());
  const [returnTarget, setReturnTarget] = useState<{ orderId: string; orderName: string; boxLabel: string } | null>(null);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);

  const boxes = useMemo(() => data?.boxes ?? [], [data]);
  const boxesById = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);

  // After every refresh: if a box someone selected was just taken (or
  // retired), clear only that selection and say so on the row.
  const lastBoxesRef = useRef<StagingBox[] | null>(null);
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;
  useEffect(() => {
    if (!data || lastBoxesRef.current === data.boxes) return;
    lastBoxesRef.current = data.boxes;
    const current = selectionsRef.current;
    const next = { ...current };
    const notices: Record<string, { tone: "notice"; text: string }> = {};
    for (const [orderId, boxId] of Object.entries(current)) {
      const box = boxesById.get(boxId);
      const takenByOther = box?.inUseByOrderId && box.inUseByOrderId !== orderId;
      if (!box || box.archived || takenByOther) {
        delete next[orderId];
        notices[orderId] = {
          tone: "notice",
          text: !box
            ? "That staging box no longer exists. Choose another box."
            : box.archived
              ? `${box.label} was retired. Choose another box.`
              : `${box.label} was just taken (now holding ${box.inUseByOrderName}). Choose another box.`,
        };
      }
    }
    if (Object.keys(notices).length) {
      setSelections(next);
      setRowMessages((m) => ({ ...m, ...notices }));
    }
  }, [data, boxesById]);

  // Drop the local "just picked" hide once the server agrees.
  useEffect(() => {
    if (!data || pickedLocally.size === 0) return;
    const stillWaiting = new Set(
      [...pickedLocally].filter((id) => data.orders.some((o) => o.orderId === id && o.status === "preparing_shipment")),
    );
    if (stillWaiting.size !== pickedLocally.size) setPickedLocally(stillWaiting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase().replace(/^#/, "");
    const list = data.orders
      .filter((o) => o.status === "preparing_shipment" && !pickedLocally.has(o.orderId))
      .filter((o) => includeFlagged || !o.isFlagged)
      .filter(
        (o) =>
          !needle ||
          o.name.toLowerCase().replace(/^#/, "").includes(needle) ||
          o.customerName.toLowerCase().includes(needle),
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.name.localeCompare(b.name));
    return fromBottom ? list.reverse() : list;
  }, [data, search, includeFlagged, fromBottom, pickedLocally]);

  const flaggedHiddenCount = useMemo(
    () => (data ? data.orders.filter((o) => o.status === "preparing_shipment" && o.isFlagged).length : 0),
    [data],
  );

  const setRowMessage = (orderId: string, msg: RowMessage | null) =>
    setRowMessages((m) => {
      const next = { ...m };
      if (msg) next[orderId] = msg;
      else delete next[orderId];
      return next;
    });

  const handlePick = async (order: WarehouseOrder) => {
    const boxId = selections[order.orderId];
    if (!boxId) return;
    setSubmitting((s) => ({ ...s, [order.orderId]: true }));
    setRowMessage(order.orderId, null);
    // The batch instructions shown on the row (or the picker's override).
    const planned = order.batchPlan && order.batchPlan.state === "covered" ? planAllocations(order.batchPlan) : [];
    const ov = overrides[order.orderId];
    let allocations = planned;
    let override: { reason: string } | null = null;
    if (ov) {
      const overridden = new Set(Object.keys(ov.byProduct));
      allocations = [
        ...planned.filter((a) => !overridden.has(a.product_id)),
        ...Object.entries(ov.byProduct).flatMap(([productId, parts]) =>
          Object.entries(parts)
            .filter(([, q]) => Number(q) > 0)
            .map(([batchId, q]) => ({ product_id: productId, batch_id: batchId, qty: Number(q) })),
        ),
      ];
      override = { reason: ov.reason === "Other" ? `Other: ${ov.note.trim()}` : [ov.reason, ov.note.trim()].filter(Boolean).join(": ") };
    }
    try {
      await api(`/api/fulfillments/${order.orderId}/pick`, { body: { boxId, allocations, override } });
      setOverrides((m) => {
        const next = { ...m };
        delete next[order.orderId];
        return next;
      });
      setPickedLocally((s) => new Set(s).add(order.orderId));
      setSelections((s) => {
        const next = { ...s };
        delete next[order.orderId];
        return next;
      });
      refresh();
    } catch (err) {
      const e = err as ApiError;
      setRowMessage(order.orderId, {
        tone: "error",
        text: e.message || "Couldn't mark this order picked.",
        link: e.code === "batch_short" ? { href: COUNT_BOXES_HREF, label: "Count boxes" } : undefined,
      });
      if (e.code === "plan_changed") {
        // New instructions are on the refreshed row; the box choice stays.
        refresh();
        return;
      }
      if (!e.code || BOX_ERROR_CODES.has(e.code)) {
        setSelections((s) => {
          const next = { ...s };
          delete next[order.orderId];
          return next;
        });
      }
      refresh();
    } finally {
      setSubmitting((s) => ({ ...s, [order.orderId]: false }));
    }
  };

  const handleReturn = async () => {
    if (!returnTarget) return;
    setReturning(true);
    setReturnError(null);
    try {
      await api(`/api/fulfillments/${returnTarget.orderId}/return-to-picking`, { body: {} });
      setReturnTarget(null);
      refresh();
    } catch (err: any) {
      setReturnError(err.message || "Couldn't return this order to picking.");
    } finally {
      setReturning(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-5 text-black">
        <section className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-black">Pick List</h1>
            <p className="text-sm text-black">
              Orders waiting to be picked. Pull the items, put them in a staging box, choose that box, and mark the order picked.
            </p>
          </div>
          <Link href="/fulfillments/shipping-assignments" className={secondaryButton}>
            Shipping Assignments
          </Link>
        </section>

        <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div>
              <label htmlFor="pick-search" className="mb-1 block text-xs font-medium text-black">
                Search order # or customer
              </label>
              <input
                id="pick-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="#2554 or name"
                className={inputClassName}
              />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-black">Start from</span>
              <div className="inline-flex overflow-hidden rounded-md border border-zinc-300" role="group" aria-label="Start from">
                {(["Top", "Bottom"] as const).map((label) => {
                  const active = (label === "Bottom") === fromBottom;
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFromBottom(label === "Bottom")}
                      className={`px-4 py-2 text-sm font-medium ${active ? "bg-emerald-600 text-white" : "bg-white text-black hover:bg-zinc-50"}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm text-black">
              <input
                type="checkbox"
                checked={includeFlagged}
                onChange={(e) => setIncludeFlagged(e.target.checked)}
                className="h-4 w-4"
              />
              Include flagged orders{flaggedHiddenCount > 0 ? ` (${flaggedHiddenCount})` : ""}
            </label>
          </div>
          <LastUpdatedNote meta={data?.meta} />
        </section>

        <section className="space-y-3">
          {loading && !data ? (
            <p className="text-sm text-black">Loading orders…</p>
          ) : error && !data ? (
            <p className="text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : rows.length === 0 ? (
            <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-black">Nothing waiting to be picked.</p>
          ) : (
            <ul className="space-y-3" aria-label="Orders to pick">
              {rows.map((o) => {
                const msg = rowMessages[o.orderId];
                const unmapped = o.unmappedLineItems.length > 0;
                const selectedBox = selections[o.orderId] ?? null;
                const busy = !!submitting[o.orderId];
                return (
                  <li
                    key={o.orderId}
                    data-testid={`pick-row-${o.orderId}`}
                    className={`rounded-lg border bg-white p-4 shadow-sm ${o.isFlagged ? "border-red-300" : "border-zinc-200"}`}
                  >
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/fulfillments/${o.orderId}`} className="text-base font-semibold text-black underline">
                            {o.name}
                          </Link>
                          {o.isFlagged && <StatusBadge status={o.status} isFlagged flaggedReason={o.flaggedReason} />}
                        </div>
                        <p className="text-sm text-black">{formatNyDate(o.createdAt)}</p>
                        <p className="text-sm text-black">{o.customerName}</p>
                        <p className="text-sm text-black">Product weight: {o.totalProductWeightOz.toFixed(1)} oz</p>
                        <div className="pt-1">
                          <PackageBadge pkg={o.packaging} />
                          {o.packaging.key === "needs_review" && (
                            <p className="mt-1 text-xs text-black">{o.packaging.reason}</p>
                          )}
                        </div>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-black">Pull from shelves</p>
                        {o.batchPlan?.emptiesBatchIds.length ? (
                          <span className="mb-1 inline-flex rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-medium text-black" data-testid="box-empties">
                            Box empties with this order
                          </span>
                        ) : null}
                        <ul className="space-y-1 text-sm text-black">
                          {o.components.map((c) => {
                            const line = o.batchPlan?.lines.find((l) => l.productId === c.productId);
                            const ov = overrides[o.orderId]?.byProduct[c.productId];
                            const short = o.flagDetail?.find((d) => d.product_id === c.productId);
                            const qtyText = Number.isInteger(c.qty) ? c.qty : c.qty.toFixed(2);
                            if (line && o.batchPlan?.state === "covered") {
                              const parts = ov
                                ? Object.entries(ov)
                                    .filter(([, q]) => Number(q) > 0)
                                    .map(([batchId, q]) => ({ batchCode: data?.batchesByProduct[c.productId]?.find((b) => b.id === batchId)?.batchCode ?? "?", qty: Number(q) }))
                                : line.parts;
                              return (
                                <li key={c.productId} data-testid={`pick-line-${c.productName}`}>
                                  <span className="font-medium">
                                    {qtyText}x {c.productName}:
                                  </span>{" "}
                                  {parts.length === 1 ? `pull from Batch ${parts[0].batchCode}` : parts.map((p) => `Batch ${p.batchCode} x${p.qty}`).join(", ")}
                                  {ov && <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-black">Different batch</span>}
                                  <button
                                    type="button"
                                    className="ml-2 text-xs text-emerald-800 underline"
                                    onClick={() => setOverrideEditor({ order: o, line })}
                                  >
                                    Picked from a different batch
                                  </button>
                                </li>
                              );
                            }
                            if (short) {
                              return (
                                <li key={c.productId} className="rounded bg-red-50 px-1">
                                  {qtyText}x {c.productName}: short by {short.short_by} (needs {short.needed}, available {short.available})
                                </li>
                              );
                            }
                            return (
                              <li key={c.productId}>
                                {qtyText}x {c.productName}
                              </li>
                            );
                          })}
                          {o.unmappedLineItems.map((name) => (
                            <li key={`u-${name}`} className="rounded bg-amber-50 px-1 text-black">
                              ⚠ Unmapped: {name}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="min-w-0 space-y-2 sm:col-span-2 lg:col-span-1">
                        <BoxPicker
                          boxes={boxes}
                          value={selectedBox}
                          ownOrderId={o.orderId}
                          disabled={busy || unmapped || o.isFlagged}
                          label={`Staging box for ${o.name}`}
                          onChange={(boxId) => {
                            setSelections((s) => {
                              const next = { ...s };
                              if (boxId) next[o.orderId] = boxId;
                              else delete next[o.orderId];
                              return next;
                            });
                            setRowMessage(o.orderId, null);
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => handlePick(o)}
                          disabled={!selectedBox || busy || unmapped || o.isFlagged}
                          className={`${primaryButton} w-full`}
                        >
                          {busy ? "Marking…" : "Mark as Picked"}
                        </button>
                        {unmapped ? (
                          <p className="text-xs text-black">
                            Map the line item before picking.{" "}
                            <Link
                              href={`/settings/variant-mapping?lineitem=${encodeURIComponent(o.unmappedLineItems[0])}`}
                              className="font-medium text-emerald-800 underline"
                            >
                              Variant Mapping
                            </Link>
                          </p>
                        ) : o.isFlagged && o.flagSource === "auto_out_of_stock" ? (
                          <p className="text-xs text-black">
                            Item(s) out of stock. Picking unlocks once stock is counted or added.{" "}
                            <Link href={COUNT_BOXES_HREF} className="font-medium text-emerald-800 underline">
                              Count boxes
                            </Link>
                          </p>
                        ) : o.isFlagged ? (
                          <p className="text-xs text-black">Unflag this order before picking.</p>
                        ) : !selectedBox ? (
                          <p className="text-xs text-black">Choose a staging box first.</p>
                        ) : null}
                        {msg && (
                          <p
                            className={`rounded-md px-2 py-1 text-xs text-black ${msg.tone === "error" ? "bg-red-50 ring-1 ring-red-300" : "bg-amber-50 ring-1 ring-amber-300"}`}
                            role={msg.tone === "error" ? "alert" : "status"}
                          >
                            {msg.text}
                            {msg.link && (
                              <>
                                {" "}
                                <Link href={msg.link.href} className="font-medium text-emerald-800 underline">
                                  {msg.link.label}
                                </Link>
                              </>
                            )}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {overrideEditor && (
          <OverrideEditor
            order={overrideEditor.order}
            line={overrideEditor.line}
            batches={data?.batchesByProduct[overrideEditor.line.productId] ?? []}
            existing={overrides[overrideEditor.order.orderId]}
            onClose={() => setOverrideEditor(null)}
            onClear={() => {
              setOverrides((m) => {
                const cur = m[overrideEditor.order.orderId];
                if (!cur) return m;
                const byProduct = { ...cur.byProduct };
                delete byProduct[overrideEditor.line.productId];
                const next = { ...m };
                if (Object.keys(byProduct).length === 0) delete next[overrideEditor.order.orderId];
                else next[overrideEditor.order.orderId] = { ...cur, byProduct };
                return next;
              });
              setOverrideEditor(null);
            }}
            onApply={(parts, reason, note) => {
              setOverrides((m) => {
                const cur = m[overrideEditor.order.orderId] ?? { reason, note, byProduct: {} };
                return {
                  ...m,
                  [overrideEditor.order.orderId]: { reason, note, byProduct: { ...cur.byProduct, [overrideEditor.line.productId]: parts } },
                };
              });
              setOverrideEditor(null);
            }}
          />
        )}

        <RecentlyPicked
          picks={data?.recentPicks ?? []}
          onReturn={(p) => {
            setReturnError(null);
            setReturnTarget(p);
          }}
        />

        <ManageBoxes boxes={boxes} onChanged={refresh} />

        {returnTarget && (
          <Modal title="Return to picking" onClose={() => setReturnTarget(null)}>
            <p className="text-sm text-black">
              Return order {returnTarget.orderName} to picking? The items need to go back on the shelves and{" "}
              {returnTarget.boxLabel} will be freed.
            </p>
            {returnError && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {returnError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={secondaryButton} onClick={() => setReturnTarget(null)}>
                Cancel
              </button>
              <button type="button" className={dangerButton} disabled={returning} onClick={handleReturn}>
                {returning ? "Returning…" : "Return to picking"}
              </button>
            </div>
          </Modal>
        )}
      </div>
    </AuthGuard>
  );
}

function RecentlyPicked({
  picks,
  onReturn,
}: {
  picks: Array<{ orderId: string; orderName: string; boxLabel: string; assignedAt: string; open: boolean; status: string | null }>;
  onReturn: (p: { orderId: string; orderName: string; boxLabel: string }) => void;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-black">Recently picked</h2>
      {picks.length === 0 ? (
        <p className="text-sm text-black">No picks yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm text-black">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-black">
              <tr>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Box</th>
                <th className="px-3 py-2 font-medium">Picked at</th>
                <th className="px-3 py-2 font-medium">Now</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p) => {
                const canReturn = p.open && (p.status === "picked" || p.status === null);
                return (
                  <tr key={`${p.orderId}-${p.assignedAt}`} className="border-b border-zinc-100">
                    <td className="px-3 py-2">
                      <Link href={`/fulfillments/${p.orderId}`} className="underline">
                        {p.orderName}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{p.boxLabel}</td>
                    <td className="whitespace-nowrap px-3 py-2" title={formatNyDateTime(p.assignedAt)}>
                      {formatNyTime(p.assignedAt)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{p.open ? (p.status === "picked" || !p.status ? "In box" : "Label made") : "Box freed"}</td>
                    <td className="px-3 py-2 text-right">
                      {canReturn && (
                        <button type="button" className={`${secondaryButton} whitespace-nowrap`} onClick={() => onReturn(p)}>
                          Return to Picking
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ManageBoxes({ boxes, onChanged }: { boxes: StagingBox[]; onChanged: () => void }) {
  const api = useAuthedApi();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState("10");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [releaseBox, setReleaseBox] = useState<StagingBox | null>(null);
  const [releaseReason, setReleaseReason] = useState("");
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const counts = useMemo(
    () => ({
      available: boxes.filter((b) => !b.archived && !b.inUseByOrderId).length,
      inUse: boxes.filter((b) => !!b.inUseByOrderId).length,
      retired: boxes.filter((b) => b.archived).length,
    }),
    [boxes],
  );

  const create = async () => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      setMessage({ tone: "error", text: "Enter a number of boxes from 1 to 50." });
      return;
    }
    setCreating(true);
    setMessage(null);
    try {
      const res = await api<{ created: string[] }>("/api/staging-boxes", { body: { count: n } });
      const created = res.created ?? [];
      setMessage({
        tone: "ok",
        text: created.length === 1 ? `Created ${created[0]}.` : `Created ${created[0]} to ${created[created.length - 1]}.`,
      });
      onChanged();
    } catch (err: any) {
      setMessage({ tone: "error", text: err.message || "Couldn't create boxes." });
    } finally {
      setCreating(false);
    }
  };

  const retire = async (b: StagingBox) => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/staging-boxes/${b.id}/retire`, { body: {} });
      setMessage({ tone: "ok", text: `${b.label} retired.` });
      onChanged();
    } catch (err: any) {
      setMessage({ tone: "error", text: err.message || "Couldn't retire this box." });
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    if (!releaseBox) return;
    if (!releaseReason.trim()) {
      setReleaseError("A reason is required to release a staging box.");
      return;
    }
    setBusy(true);
    setReleaseError(null);
    try {
      const res = await api<{ box_label: string; order_label: string; returned_to_picking: boolean }>(
        `/api/staging-boxes/${releaseBox.id}/release`,
        { body: { reason: releaseReason.trim() } },
      );
      setMessage({
        tone: "ok",
        text: `${res.box_label} released.${res.returned_to_picking ? ` Order ${res.order_label} is back on the Pick List.` : ""}`,
      });
      setReleaseBox(null);
      setReleaseReason("");
      onChanged();
    } catch (err: any) {
      setReleaseError(err.message || "Couldn't release this box.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-sm font-semibold text-black">Manage staging boxes</span>
        <span className="text-sm text-black">
          {counts.available} available · {counts.inUse} in use · {counts.retired} retired {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="box-count" className="mb-1 block text-xs font-medium text-black">
                Create boxes (1 to 50)
              </label>
              <input
                id="box-count"
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className={`${inputClassName} w-28`}
              />
            </div>
            <button type="button" className={primaryButton} disabled={creating} onClick={create}>
              {creating ? "Creating…" : "Create boxes"}
            </button>
            <p className="text-xs text-black">Numbering continues from the highest box. Numbers are never reused.</p>
          </div>
          {message && (
            <p
              className={`rounded-md px-2 py-1 text-sm text-black ${message.tone === "ok" ? "bg-emerald-50 ring-1 ring-emerald-300" : "bg-red-50 ring-1 ring-red-300"}`}
              role={message.tone === "error" ? "alert" : "status"}
            >
              {message.text}
            </p>
          )}
          {boxes.length === 0 ? (
            <p className="text-sm text-black">No staging boxes yet. Create some above, then label them by hand.</p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="min-w-full text-left text-sm text-black">
                <thead className="sticky top-0 bg-zinc-50 text-xs uppercase tracking-wide text-black">
                  <tr>
                    <th className="px-3 py-2 font-medium">Box</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((b) => (
                    <tr key={b.id} className="border-b border-zinc-100" data-testid={`box-row-${b.label}`}>
                      <td className="px-3 py-2 font-medium">{b.label}</td>
                      <td className="px-3 py-2">
                        {b.archived ? "Retired" : b.inUseByOrderId ? `In use: ${b.inUseByOrderName}` : "Available"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!b.archived && b.inUseByOrderId && (
                          <button
                            type="button"
                            className={dangerButton}
                            disabled={busy}
                            onClick={() => {
                              setReleaseError(null);
                              setReleaseReason("");
                              setReleaseBox(b);
                            }}
                          >
                            Release
                          </button>
                        )}
                        {!b.archived && !b.inUseByOrderId && (
                          <button type="button" className={secondaryButton} disabled={busy} onClick={() => retire(b)}>
                            Retire
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {releaseBox && (
        <Modal title={`Release ${releaseBox.label}`} onClose={() => setReleaseBox(null)}>
          <p className="text-sm text-black">
            Use this for a lost, damaged or stuck box. Order {releaseBox.inUseByOrderName} goes back to the Pick List, so its
            items need to go back on the shelves.
          </p>
          <label htmlFor="release-reason" className="mb-1 mt-3 block text-xs font-medium text-black">
            Reason (required)
          </label>
          <textarea
            id="release-reason"
            value={releaseReason}
            onChange={(e) => setReleaseReason(e.target.value)}
            rows={3}
            className={inputClassName}
            placeholder="e.g. Box was crushed"
          />
          {releaseError && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {releaseError}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setReleaseBox(null)}>
              Cancel
            </button>
            <button type="button" className={dangerButton} disabled={busy} onClick={release}>
              {busy ? "Releasing…" : "Release box"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function OverrideEditor({
  order,
  line,
  batches,
  existing,
  onClose,
  onApply,
  onClear,
}: {
  order: WarehouseOrder;
  line: AllocLine;
  batches: Array<{ id: string; batchCode: string; remainingQty: number }>;
  existing: Override | undefined;
  onClose: () => void;
  onApply: (parts: Record<string, string>, reason: string, note: string) => void;
  onClear: () => void;
}) {
  const [parts, setParts] = useState<Record<string, string>>(
    existing?.byProduct[line.productId] ?? Object.fromEntries(line.parts.map((p) => [p.batchId, String(p.qty)])),
  );
  const [reason, setReason] = useState(existing?.reason ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [error, setError] = useState<{ text: string; count?: boolean } | null>(null);

  const apply = () => {
    let total = 0;
    for (const [batchId, q] of Object.entries(parts)) {
      if (q.trim() === "") continue;
      if (!/^\d+$/.test(q.trim())) return setError({ text: "Quantities must be whole numbers." });
      const b = batches.find((x) => x.id === batchId);
      if (b && Number(q) > b.remainingQty) {
        return setError({ text: `Batch ${b.batchCode} shows ${b.remainingQty} units. Count the box first.`, count: true });
      }
      total += Number(q);
    }
    if (total !== line.qty) return setError({ text: `Quantities must add up to ${line.qty}.` });
    if (!reason) return setError({ text: "Choose a reason." });
    if (reason === "Other" && !note.trim()) return setError({ text: "Add a note for Other." });
    onApply(Object.fromEntries(Object.entries(parts).filter(([, q]) => Number(q) > 0)), reason, note);
  };

  return (
    <Modal title={`${order.name}: picked ${line.qty}x ${line.productName} from a different batch`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>Enter how many units came from each box you actually pulled from.</p>
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide">
            <tr>
              <th className="pr-3 font-medium">Batch</th>
              <th className="pr-3 font-medium">In box</th>
              <th className="font-medium">Took</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td className="pr-3 font-semibold">{b.batchCode}</td>
                <td className="pr-3">{b.remainingQty}</td>
                <td className="py-1">
                  <input
                    inputMode="numeric"
                    aria-label={`Units from batch ${b.batchCode}`}
                    value={parts[b.id] ?? ""}
                    onChange={(e) => setParts((p) => ({ ...p, [b.id]: e.target.value }))}
                    className={`${inputClassName} w-20`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <label htmlFor="override-reason" className="mb-1 block text-xs font-medium">
            Reason
          </label>
          <select id="override-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClassName}>
            <option value="">Choose…</option>
            {OVERRIDE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            aria-label="Override note"
            placeholder={reason === "Other" ? "Note (required)" : "Note (optional)"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${inputClassName} mt-1`}
          />
        </div>
        {error && (
          <p className="text-sm text-red-700" role="alert">
            {error.text}{" "}
            {error.count && (
              <Link href={COUNT_BOXES_HREF} className="font-medium underline">
                Count boxes
              </Link>
            )}
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" className={secondaryButton} onClick={onClear}>
            Use the planned batch
          </button>
          <div className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={primaryButton} onClick={apply}>
              Use these batches
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
