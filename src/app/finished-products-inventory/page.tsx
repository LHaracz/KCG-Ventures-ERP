"use client";

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { LOW_STOCK_THRESHOLD } from "@/lib/finishedGoodsInventory";
import { fetchActiveEmployees, type Employee } from "@/lib/employees";
import { useAuthedApi, type ApiError } from "@/lib/useWarehouse";
import { formatNyDate, formatNyDateTime, NY_TIME_ZONE } from "@/lib/nyTime";
import { Modal, inputClassName, primaryButton, secondaryButton } from "@/components/fulfillment/WarehouseUi";

// Finished Products Inventory (BotanIQals only). Finished goods are tracked
// by batch: each box on the shelf is one batch of one product. A product's
// "In boxes" count is the sum of its active batches; "Awaiting pick" is what
// unpicked orders need; "Available" is the difference (may be negative).

type ProductRow = {
  productId: string;
  name: string;
  onHandQty: number;
  batchTracked: boolean;
  updatedAt: string | null;
  inBoxes: number;
  awaitingPick: number | null;
  available: number | null;
  activeBatches: number | null;
};

type BatchRow = {
  id: string;
  batchCode: string;
  productId: string;
  productName: string;
  productionCycleId: string | null;
  submittedAt: string;
  initialQty: number;
  remainingQty: number;
  status: "active" | "depleted";
  needsCount: boolean;
  source: "production" | "opening_seed" | "manual";
  depletedAt: string | null;
  note: string | null;
  plannedQty: number;
  nextToPick: boolean;
};

type Overview = { products: ProductRow[]; batches: BatchRow[] };

type TransactionRow = {
  id: string;
  type: string;
  quantity_delta: number;
  resulting_qty: number;
  reference_type: string | null;
  reference_id: string | null;
  note: string | null;
  created_at: string;
  batch_id: string | null;
  batch_remaining_after: number | null;
  order_ref: string | null;
};

const TYPE_LABELS: Record<string, string> = {
  sale_decrease: "Sale",
  production_increase: "Production",
  cycle_count_adjustment: "Cycle Count",
  production_reversal: "Production reversal",
  batch_receipt: "Batch received (production)",
  batch_pick: "Picked for order",
  batch_pick_reversal: "Returned to stock",
  batch_cycle_count: "Box count",
  batch_manual_add: "Batch added manually",
  batch_opening_seed: "Opening batch",
};
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;
const formatDelta = (d: number) => (d > 0 ? `+${d}` : String(d));
const deltaClass = (d: number) => (d > 0 ? "text-emerald-800" : d < 0 ? "text-red-700" : "text-black");

const COUNT_REASONS = ["Sold at market", "Recount", "Damaged", "Other"] as const;

function todayNy(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: NY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export default function FinishedProductsInventoryPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-sm text-black">Loading…</p>}>
        <FinishedProductsInventory />
      </Suspense>
    </AuthGuard>
  );
}

function FinishedProductsInventory() {
  const { user, supabase } = useSupabase();
  const api = useAuthedApi();
  const searchParams = useSearchParams();

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"name" | "available">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [historyByProduct, setHistoryByProduct] = useState<Map<string, TransactionRow[]>>(new Map());
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [view, setView] = useState<"products" | "batches">(searchParams.get("view") === "batches" ? "batches" : "products");
  const [countOpen, setCountOpen] = useState(searchParams.get("count") === "1");
  const [addOpen, setAddOpen] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [flash, setFlash] = useState<string | null>(null);

  // A BotanIQals product created after the inventory migration gets its row
  // lazily (as before). New rows are batch tracked from the start once the
  // opening-batch script has switched the column default.
  const ensureRows = useCallback(async () => {
    const [productsResult, inventoryResult] = await Promise.all([
      supabase.from("products").select("id").eq("is_microgreen", false).is("deleted_at", null),
      supabase.from("finished_products_inventory").select("product_id"),
    ]);
    if (productsResult.error || inventoryResult.error) return;
    const have = new Set(((inventoryResult.data || []) as Array<{ product_id: string }>).map((r) => r.product_id));
    const missing = ((productsResult.data || []) as Array<{ id: string }>).filter((p) => !have.has(p.id));
    if (missing.length > 0) {
      await supabase.from("finished_products_inventory").insert(missing.map((p) => ({ product_id: p.id, on_hand_qty: 0 })));
    }
  }, [supabase]);

  const refresh = useCallback(async () => {
    try {
      const data = await api<Overview>("/api/finished-goods/overview");
      setOverview(data);
      setLoadError(null);
      setHistoryByProduct(new Map());
    } catch (err: any) {
      setLoadError(err.message || "Failed to load finished goods.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      await ensureRows();
      await refresh();
      try {
        setEmployees(await fetchActiveEmployees(supabase));
      } catch {
        setEmployees([]);
      }
    })();
  }, [user, supabase, ensureRows, refresh]);

  const batchCodeById = useMemo(() => new Map((overview?.batches ?? []).map((b) => [b.id, b.batchCode])), [overview]);

  const visibleRows = useMemo(() => {
    const rows = overview?.products ?? [];
    const needle = search.trim().toLowerCase();
    const filtered = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
    return [...filtered].sort((a, b) => {
      const cmp = sortKey === "name" ? a.name.localeCompare(b.name) : (a.available ?? a.inBoxes) - (b.available ?? b.inBoxes);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [overview, search, sortKey, sortDir]);

  const toggleSort = (key: "name" | "available") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const toggleHistory = async (row: ProductRow) => {
    if (expandedProductId === row.productId) {
      setExpandedProductId(null);
      return;
    }
    setExpandedProductId(row.productId);
    if (historyByProduct.has(row.productId)) return;
    setHistoryError(null);
    const { data, error } = await supabase
      .from("inventory_transactions")
      .select("id, type, quantity_delta, resulting_qty, reference_type, reference_id, note, created_at, batch_id, batch_remaining_after, order_ref")
      .eq("product_id", row.productId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) setHistoryError(error.message);
    else setHistoryByProduct((prev) => new Map(prev).set(row.productId, (data || []) as TransactionRow[]));
  };

  if (view === "batches") {
    return (
      <>
        <ActiveBatchesPanel
          overview={overview}
          onBack={() => setView("products")}
          onCount={() => setCountOpen(true)}
          onAdd={() => setAddOpen(true)}
          flash={flash}
          onDismissFlash={() => setFlash(null)}
        />
        {countOpen && overview && (
          <CountBoxesModal
            overview={overview}
            employees={employees}
            onClose={() => setCountOpen(false)}
            refresh={refresh}
            onDone={(msg) => {
              setCountOpen(false);
              setFlash(msg);
            }}
          />
        )}
        {addOpen && overview && (
          <AddBatchModal
            products={overview.products.filter((p) => p.batchTracked)}
            employees={employees}
            onClose={() => setAddOpen(false)}
            onDone={async (msg) => {
              setAddOpen(false);
              setFlash(msg);
              await refresh();
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 text-black">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-semibold text-black">Finished Products Inventory</h1>
          <p className="text-sm text-black">
            BotanIQals finished goods, tracked by batch box. In boxes is what is on the shelf; Awaiting pick is what unpicked
            orders need; Available is the difference.
          </p>
        </div>
        <button type="button" onClick={() => setView("batches")} className={primaryButton}>
          Active Batches
        </button>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="mb-3">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…" className={`${inputClassName} max-w-xs`} />
        </div>
        {loading ? (
          <p className="text-sm text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-sm text-red-700" role="alert">
            {loadError}
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="text-sm text-black">No BotanIQals products found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-sm text-black">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-black">
                <tr>
                  <th className="px-3 py-2 font-medium">
                    <button type="button" onClick={() => toggleSort("name")}>
                      Product {sortKey === "name" && (sortDir === "asc" ? "↑" : "↓")}
                    </button>
                  </th>
                  <th className="px-3 py-2 font-medium">In boxes</th>
                  <th className="px-3 py-2 font-medium">Awaiting pick</th>
                  <th className="px-3 py-2 font-medium">
                    <button type="button" onClick={() => toggleSort("available")}>
                      Available {sortKey === "available" && (sortDir === "asc" ? "↑" : "↓")}
                    </button>
                  </th>
                  <th className="px-3 py-2 font-medium">Batches</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const lowBasis = row.available ?? row.inBoxes;
                  const isLow = lowBasis < LOW_STOCK_THRESHOLD;
                  const isExpanded = expandedProductId === row.productId;
                  const history = historyByProduct.get(row.productId) ?? [];
                  return (
                    <Fragment key={row.productId}>
                      <tr className={`border-b border-zinc-100 ${isLow ? "bg-amber-50" : ""}`} data-testid={`fg-row-${row.name}`}>
                        <td className="px-3 py-2 font-medium">
                          {row.name}
                          {!row.batchTracked && (
                            <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-black">Not batch tracked</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-semibold">{row.inBoxes}</td>
                        <td className="px-3 py-2">{row.awaitingPick ?? "—"}</td>
                        <td className="px-3 py-2 font-semibold">
                          {row.available == null ? (
                            "—"
                          ) : row.available < 0 ? (
                            <span className="text-red-700">Short by {-row.available}</span>
                          ) : (
                            row.available
                          )}
                          {isLow && row.available != null && row.available >= 0 && (
                            <span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-medium text-black">Low stock</span>
                          )}
                        </td>
                        <td className="px-3 py-2">{row.activeBatches ?? "—"}</td>
                        <td className="px-3 py-2">{formatNyDate(row.updatedAt)}</td>
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => toggleHistory(row)} className="text-xs font-medium text-emerald-800 underline">
                            {isExpanded ? "Hide history" : "Transaction History"}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="border-b border-zinc-100 bg-zinc-50">
                          <td colSpan={7} className="px-3 py-3">
                            {historyError ? (
                              <p className="text-xs text-red-700">{historyError}</p>
                            ) : history.length === 0 ? (
                              <p className="text-xs text-black">No transactions yet.</p>
                            ) : (
                              <TransactionsTable rows={history} batchCodeById={batchCodeById} />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function TransactionsTable({ rows, batchCodeById }: { rows: TransactionRow[]; batchCodeById: Map<string, string> }) {
  const reference = (t: TransactionRow) => {
    if (t.order_ref) return `Order ${t.order_ref}`;
    if (t.reference_type === "order") return "Order (sales import)";
    if (t.reference_type === "production_cycle") return t.reference_id ? `Cycle ${t.reference_id.slice(0, 8)}` : "Production cycle";
    return "Manual";
  };
  return (
    <table className="min-w-full border-collapse text-left text-xs text-black">
      <thead>
        <tr>
          <th className="px-2 py-1 font-medium">Type</th>
          <th className="px-2 py-1 font-medium">Batch</th>
          <th className="px-2 py-1 font-medium">Change</th>
          <th className="px-2 py-1 font-medium">Product total after</th>
          <th className="px-2 py-1 font-medium">When</th>
          <th className="px-2 py-1 font-medium">Reference</th>
          <th className="px-2 py-1 font-medium">Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className="border-t border-zinc-200">
            <td className="px-2 py-1">{typeLabel(t.type)}</td>
            <td className="px-2 py-1">{t.batch_id ? batchCodeById.get(t.batch_id) ?? "—" : "—"}</td>
            <td className={`px-2 py-1 font-medium ${deltaClass(t.quantity_delta)}`}>{formatDelta(t.quantity_delta)}</td>
            <td className="px-2 py-1">{t.resulting_qty}</td>
            <td className="px-2 py-1">{formatNyDateTime(t.created_at)}</td>
            <td className="px-2 py-1">{reference(t)}</td>
            <td className="px-2 py-1">{t.note || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Active Batches panel ---------------------------------------------------

function ActiveBatchesPanel({
  overview,
  onBack,
  onCount,
  onAdd,
  flash,
  onDismissFlash,
}: {
  overview: Overview | null;
  onBack: () => void;
  onCount: () => void;
  onAdd: () => void;
  flash: string | null;
  onDismissFlash: () => void;
}) {
  const { supabase } = useSupabase();
  const [showEmptied, setShowEmptied] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Map<string, { tx: TransactionRow[]; picks: any[] }>>(new Map());

  const groups = useMemo(() => {
    const byProduct = new Map<string, BatchRow[]>();
    for (const b of overview?.batches ?? []) {
      if (!showEmptied && b.status !== "active") continue;
      const list = byProduct.get(b.productName) ?? [];
      list.push(b);
      byProduct.set(b.productName, list);
    }
    for (const list of byProduct.values()) {
      list.sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime() || a.batchCode.localeCompare(b.batchCode));
    }
    return [...byProduct.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [overview, showEmptied]);

  const toggle = async (b: BatchRow) => {
    if (expanded === b.id) {
      setExpanded(null);
      return;
    }
    setExpanded(b.id);
    if (detail.has(b.id)) return;
    const [tx, picks] = await Promise.all([
      supabase
        .from("inventory_transactions")
        .select("id, type, quantity_delta, resulting_qty, reference_type, reference_id, note, created_at, batch_id, batch_remaining_after, order_ref")
        .eq("batch_id", b.id)
        .order("created_at", { ascending: false }),
      supabase.from("order_batch_picks").select("id, order_id, order_name, qty, picked_at, reversed_at, is_override").eq("batch_id", b.id).order("picked_at", { ascending: false }),
    ]);
    setDetail((prev) => new Map(prev).set(b.id, { tx: (tx.data || []) as TransactionRow[], picks: picks.data || [] }));
  };

  const codeMap = useMemo(() => new Map((overview?.batches ?? []).map((b) => [b.id, b.batchCode])), [overview]);

  return (
    <div className="mx-auto max-w-7xl space-y-5 text-black" data-testid="active-batches-panel">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <button type="button" onClick={onBack} className="mb-2 text-sm font-medium text-emerald-800 underline">
            ← Back
          </button>
          <h1 className="text-2xl font-semibold text-black">Active Batches</h1>
          <p className="text-sm text-black">Every batch box on the shelf, oldest first per product. Pick from the box marked &quot;Next to pick&quot;.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryButton} onClick={onCount}>
            Count boxes
          </button>
          <button type="button" className={secondaryButton} onClick={onAdd}>
            Add batch manually
          </button>
        </div>
      </section>
      {flash && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-black ring-1 ring-emerald-300" role="status">
          {flash}{" "}
          <button type="button" className="ml-2 underline" onClick={onDismissFlash}>
            Dismiss
          </button>
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showEmptied} onChange={(e) => setShowEmptied(e.target.checked)} className="h-4 w-4" />
        Show emptied batches
      </label>
      <section className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
        {!overview ? (
          <p className="p-4 text-sm">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="p-4 text-sm">No batches yet.</p>
        ) : (
          <table className="min-w-full text-left text-sm text-black">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 font-medium">Batch ID</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">Production submitted</th>
                <th className="px-3 py-2 font-medium">Original qty</th>
                <th className="px-3 py-2 font-medium">Current qty</th>
                <th className="px-3 py-2 font-medium">Planned for pending orders</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([productName, list]) => (
                <Fragment key={productName}>
                  <tr className="bg-zinc-100">
                    <td colSpan={7} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">
                      {productName}
                    </td>
                  </tr>
                  {list.map((b) => (
                    <Fragment key={b.id}>
                      <tr
                        className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50"
                        onClick={() => toggle(b)}
                        data-testid={`batch-row-${b.batchCode}`}
                      >
                        <td className="px-3 py-2 font-semibold">
                          <span className="mr-1">{expanded === b.id ? "▾" : "▸"}</span>
                          {b.batchCode}
                        </td>
                        <td className="px-3 py-2">{b.productName}</td>
                        <td className="px-3 py-2">{formatNyDateTime(b.submittedAt)}</td>
                        <td className="px-3 py-2">{b.initialQty}</td>
                        <td className="px-3 py-2 font-semibold">{b.remainingQty}</td>
                        <td className="px-3 py-2">{b.plannedQty}</td>
                        <td className="px-3 py-2">
                          <span className="flex flex-wrap gap-1">
                            {b.nextToPick && <span className="rounded-full bg-emerald-200 px-2 py-0.5 text-[11px] font-medium text-black">Next to pick</span>}
                            {b.needsCount && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-medium text-black">Needs count</span>}
                            {b.status === "depleted" && <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-black">Emptied</span>}
                          </span>
                        </td>
                      </tr>
                      {expanded === b.id && (
                        <tr className="bg-zinc-50">
                          <td colSpan={7} className="px-3 py-3">
                            {!detail.get(b.id) ? (
                              <p className="text-xs">Loading…</p>
                            ) : (
                              <div className="grid gap-4 lg:grid-cols-2">
                                <div>
                                  <h3 className="mb-1 text-xs font-semibold">Orders that received units from this batch</h3>
                                  {detail.get(b.id)!.picks.length === 0 ? (
                                    <p className="text-xs">None yet.</p>
                                  ) : (
                                    <table className="text-left text-xs">
                                      <thead>
                                        <tr>
                                          <th className="pr-4 font-medium">Order</th>
                                          <th className="pr-4 font-medium">Date</th>
                                          <th className="pr-4 font-medium">Qty</th>
                                          <th className="font-medium"></th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {detail.get(b.id)!.picks.map((p: any) => (
                                          <tr key={p.id}>
                                            <td className="pr-4">
                                              <Link href={`/fulfillments/${p.order_id}`} className="underline">
                                                {p.order_name ?? p.order_id}
                                              </Link>
                                            </td>
                                            <td className="pr-4">{formatNyDateTime(p.picked_at)}</td>
                                            <td className="pr-4">{p.qty}</td>
                                            <td>
                                              {p.reversed_at ? "Returned to stock" : ""}
                                              {p.is_override ? " · Picked from different batch" : ""}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                                <div>
                                  <h3 className="mb-1 text-xs font-semibold">Transactions</h3>
                                  <TransactionsTable rows={detail.get(b.id)!.tx} batchCodeById={codeMap} />
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// --- Count boxes --------------------------------------------------------------

type CountEntry = { counted: string; reason: string; note: string };

function CountBoxesModal({
  overview,
  employees,
  onClose,
  refresh,
  onDone,
}: {
  overview: Overview;
  employees: Employee[];
  onClose: () => void;
  refresh: () => Promise<void>;
  onDone: (message: string) => void;
}) {
  const api = useAuthedApi();
  const [includeEmptied, setIncludeEmptied] = useState(false);
  const [entries, setEntries] = useState<Record<string, CountEntry>>({});
  // System quantity at the moment the count was opened (or last refreshed for that batch).
  const [expected, setExpected] = useState<Record<string, number>>(() =>
    Object.fromEntries(overview.batches.map((b) => [b.id, b.remainingQty])),
  );
  const [step, setStep] = useState<"count" | "review">("count");
  const [person, setPerson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const batches = overview.batches
    .filter((b) => includeEmptied || b.status === "active")
    .sort((a, b) => a.productName.localeCompare(b.productName) || new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime());

  const entered = batches.filter((b) => (entries[b.id]?.counted ?? "").trim() !== "");
  const changes = entered.filter((b) => Number(entries[b.id].counted) !== expected[b.id]);

  const validate = (): string | null => {
    if (entered.length === 0) return "Enter a count for at least one box.";
    for (const b of entered) {
      const v = entries[b.id].counted.trim();
      if (!/^\d+$/.test(v)) return `Batch ${b.batchCode}: enter a whole number, 0 or more.`;
      if (Number(v) !== expected[b.id]) {
        if (!entries[b.id].reason) return `Batch ${b.batchCode}: choose a reason for the difference.`;
        if (entries[b.id].reason === "Other" && !entries[b.id].note.trim()) return `Batch ${b.batchCode}: add a note for "Other".`;
      }
    }
    if (!person) return "Choose who counted.";
    return null;
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ changed: number; counted: number }>("/api/finished-goods/count", {
        body: {
          name: person,
          counts: entered.map((b) => {
            const e = entries[b.id];
            const reason = e.reason === "Other" ? `Other: ${e.note.trim()}` : [e.reason, e.note.trim()].filter(Boolean).join(": ");
            return { batch_id: b.id, expected_remaining: expected[b.id], counted_qty: Number(e.counted), reason: reason || null };
          }),
        },
      });
      await refresh();
      onDone(`Count saved: ${res.counted} box${res.counted === 1 ? "" : "es"} counted, ${res.changed} changed.`);
    } catch (err) {
      const e = err as ApiError;
      if (e.code === "count_stale") {
        // Someone picked or counted meanwhile: refresh the numbers and ask for those batches again.
        await refresh();
        const stale = (e.body?.stale ?? []) as Array<{ batch_id: string; current_remaining: number }>;
        setExpected((prev) => ({ ...prev, ...Object.fromEntries(stale.map((s) => [s.batch_id, s.current_remaining])) }));
        setEntries((prev) => {
          const next = { ...prev };
          for (const s of stale) next[s.batch_id] = { counted: "", reason: "", note: "" };
          return next;
        });
        setStaleIds(new Set(stale.map((s) => s.batch_id)));
        setStep("count");
      }
      setError(e.message || "Couldn't save the count.");
    } finally {
      setSubmitting(false);
    }
  };

  const setEntry = (id: string, patch: Partial<CountEntry>) =>
    setEntries((prev) => ({ ...prev, [id]: { ...{ counted: "", reason: "", note: "" }, ...prev[id], ...patch } }));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Count boxes">
      <div className="mt-8 w-full max-w-4xl rounded-md border border-zinc-200 bg-white p-4 text-black shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{step === "count" ? "Count boxes" : "Count boxes: review changes"}</h2>
          <button type="button" onClick={onClose} className="text-sm underline">
            Close
          </button>
        </div>
        {error && (
          <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-black ring-1 ring-red-300" role="alert">
            {error}
          </p>
        )}
        {step === "count" ? (
          <>
            <label className="mb-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeEmptied} onChange={(e) => setIncludeEmptied(e.target.checked)} className="h-4 w-4" />
              Include emptied batches
            </label>
            <div className="max-h-[55vh] overflow-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-2 py-2 font-medium">Batch</th>
                    <th className="px-2 py-2 font-medium">Product</th>
                    <th className="px-2 py-2 font-medium">System qty</th>
                    <th className="px-2 py-2 font-medium">Counted</th>
                    <th className="px-2 py-2 font-medium">Reason (if different)</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const e = entries[b.id] ?? { counted: "", reason: "", note: "" };
                    const differs = e.counted.trim() !== "" && Number(e.counted) !== expected[b.id];
                    return (
                      <tr key={b.id} className={`border-b border-zinc-100 align-top ${staleIds.has(b.id) ? "bg-amber-50" : ""}`} data-testid={`count-row-${b.batchCode}`}>
                        <td className="px-2 py-2 font-semibold">
                          {b.batchCode}
                          {staleIds.has(b.id) && <div className="text-[11px] font-normal">Changed: re-enter</div>}
                        </td>
                        <td className="px-2 py-2">{b.productName}</td>
                        <td className="px-2 py-2">{expected[b.id]}</td>
                        <td className="px-2 py-2">
                          <input
                            inputMode="numeric"
                            aria-label={`Counted for batch ${b.batchCode}`}
                            value={e.counted}
                            onChange={(ev) => setEntry(b.id, { counted: ev.target.value })}
                            className={`${inputClassName} w-24`}
                          />
                        </td>
                        <td className="px-2 py-2">
                          {differs && (
                            <div className="flex flex-col gap-1">
                              <select
                                aria-label={`Reason for batch ${b.batchCode}`}
                                value={e.reason}
                                onChange={(ev) => setEntry(b.id, { reason: ev.target.value })}
                                className={`${inputClassName} w-44`}
                              >
                                <option value="">Choose…</option>
                                {COUNT_REASONS.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                              <input
                                aria-label={`Note for batch ${b.batchCode}`}
                                placeholder={e.reason === "Other" ? "Note (required)" : "Note (optional)"}
                                value={e.note}
                                onChange={(ev) => setEntry(b.id, { note: ev.target.value })}
                                className={`${inputClassName} w-56`}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <label htmlFor="count-person" className="mb-1 block text-xs font-medium">
                  Counted by
                </label>
                <select id="count-person" value={person} onChange={(e) => setPerson(e.target.value)} className={`${inputClassName} w-56`}>
                  <option value="">Choose…</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.full_name}>
                      {emp.full_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <button type="button" className={secondaryButton} onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => {
                    const v = validate();
                    setError(v);
                    if (!v) setStep("review");
                  }}
                >
                  Review
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {changes.length === 0 ? (
              <p className="text-sm">Every counted box matches the system. Saving clears &quot;Needs count&quot; on them.</p>
            ) : (
              <table className="min-w-full text-left text-sm" data-testid="count-review">
                <thead className="text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-2 py-1 font-medium">Batch</th>
                    <th className="px-2 py-1 font-medium">Product</th>
                    <th className="px-2 py-1 font-medium">System</th>
                    <th className="px-2 py-1 font-medium">Counted</th>
                    <th className="px-2 py-1 font-medium">Change</th>
                    <th className="px-2 py-1 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((b) => {
                    const c = Number(entries[b.id].counted);
                    return (
                      <tr key={b.id} className="border-t border-zinc-200">
                        <td className="px-2 py-1 font-semibold">{b.batchCode}</td>
                        <td className="px-2 py-1">{b.productName}</td>
                        <td className="px-2 py-1">{expected[b.id]}</td>
                        <td className="px-2 py-1">{c}</td>
                        <td className={`px-2 py-1 font-medium ${deltaClass(c - expected[b.id])}`}>{formatDelta(c - expected[b.id])}</td>
                        <td className="px-2 py-1">{[entries[b.id].reason, entries[b.id].note].filter(Boolean).join(": ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-sm">
              {entered.length} box{entered.length === 1 ? "" : "es"} counted by {person}.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={secondaryButton} onClick={() => setStep("count")}>
                Back
              </button>
              <button type="button" className={primaryButton} disabled={submitting} onClick={submit}>
                {submitting ? "Saving…" : "Save count"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- Add batch manually ---------------------------------------------------------

function AddBatchModal({
  products,
  employees,
  onClose,
  onDone,
}: {
  products: ProductRow[];
  employees: Employee[];
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const api = useAuthedApi();
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [date, setDate] = useState(todayNy());
  const [note, setNote] = useState("");
  const [person, setPerson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    if (!productId) return setError("Choose a product.");
    if (!/^\d+$/.test(qty.trim()) || Number(qty) <= 0) return setError("Enter a quantity greater than 0.");
    if (!date) return setError("Enter the production date.");
    if (!person) return setError("Choose who is adding this batch.");
    setSaving(true);
    try {
      const res = await api<{ batch_code: string }>("/api/finished-goods/manual-batch", {
        body: { productId, qty: Number(qty), producedDate: date, note, name: person },
      });
      const name = products.find((p) => p.productId === productId)?.name ?? "";
      await onDone(`Batch ${res.batch_code} added: ${qty} ${name}. Write ${res.batch_code} on the box.`);
    } catch (err: any) {
      setError(err.message || "Couldn't add the batch.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add batch manually" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>Use this for stock that didn&apos;t come from a production cycle. It gets the next batch code.</p>
        <div>
          <label htmlFor="add-product" className="mb-1 block text-xs font-medium">
            Product
          </label>
          <select id="add-product" value={productId} onChange={(e) => setProductId(e.target.value)} className={inputClassName}>
            <option value="">Choose…</option>
            {products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="add-qty" className="mb-1 block text-xs font-medium">
              Quantity
            </label>
            <input id="add-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputClassName} />
          </div>
          <div>
            <label htmlFor="add-date" className="mb-1 block text-xs font-medium">
              Production date
            </label>
            <input id="add-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClassName} />
          </div>
        </div>
        <div>
          <label htmlFor="add-note" className="mb-1 block text-xs font-medium">
            Note
          </label>
          <input id="add-note" value={note} onChange={(e) => setNote(e.target.value)} className={inputClassName} />
        </div>
        <div>
          <label htmlFor="add-person" className="mb-1 block text-xs font-medium">
            Added by
          </label>
          <select id="add-person" value={person} onChange={(e) => setPerson(e.target.value)} className={inputClassName}>
            <option value="">Choose…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.full_name}>
                {emp.full_name}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} disabled={saving} onClick={submit}>
            {saving ? "Adding…" : "Add batch"}
          </button>
        </div>
      </div>
    </Modal>
  );
}


