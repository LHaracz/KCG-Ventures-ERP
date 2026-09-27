"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import {
  LOW_STOCK_THRESHOLD,
  recordInventoryTransaction,
  type InventoryRowCache,
} from "@/lib/finishedGoodsInventory";

// Finished Products Inventory (BotanIQals only — MiniLeaf/microgreens are
// out of scope). One row per BotanIQals product (products.is_microgreen =
// false) with a finished_products_inventory row; a product added after the
// migration's one-time backfill gets its row lazily created the first time
// this page loads, so the list never silently omits a current product.

type InventoryListRow = {
  id: string;
  product_id: string;
  product_name: string;
  on_hand_qty: number;
  updated_at: string;
};

type TransactionType = "sale_decrease" | "production_increase" | "cycle_count_adjustment";
type ReferenceType = "order" | "production_cycle" | "manual" | null;

type TransactionRow = {
  id: string;
  type: TransactionType;
  quantity_delta: number;
  resulting_qty: number;
  reference_type: ReferenceType;
  reference_id: string | null;
  note: string | null;
  created_at: string;
};

type SortKey = "name" | "qty";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function typeLabel(type: TransactionType): string {
  if (type === "sale_decrease") return "Sale";
  if (type === "production_increase") return "Production";
  return "Cycle Count";
}

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function deltaClassName(delta: number): string {
  if (delta > 0) return "text-emerald-700";
  if (delta < 0) return "text-red-600";
  return "text-zinc-600";
}

export default function FinishedProductsInventoryPage() {
  const { user, supabase } = useSupabase();

  const [rows, setRows] = useState<InventoryListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [transactionsByProduct, setTransactionsByProduct] = useState<Map<string, TransactionRow[]>>(
    new Map(),
  );
  const [orderNameByOrderId, setOrderNameByOrderId] = useState<Map<string, string>>(new Map());
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [cycleCountOpen, setCycleCountOpen] = useState(false);

  const loadAll = async () => {
    const [productsResult, inventoryResult] = await Promise.all([
      supabase.from("products").select("id, name").eq("is_microgreen", false),
      supabase
        .from("finished_products_inventory")
        .select("id, product_id, on_hand_qty, updated_at, products(name)"),
    ]);
    if (productsResult.error || inventoryResult.error) {
      setLoadError([productsResult.error?.message, inventoryResult.error?.message].filter(Boolean).join(" | "));
      return;
    }

    const products = (productsResult.data || []) as Array<{ id: string; name: string }>;
    const inventoryRows = (inventoryResult.data || []) as Array<{
      id: string;
      product_id: string;
      on_hand_qty: number;
      updated_at: string;
      products: { name: string } | { name: string }[] | null;
    }>;

    const existingByProductId = new Map(inventoryRows.map((r) => [r.product_id, r]));
    const missingProducts = products.filter((p) => !existingByProductId.has(p.id));

    let backfilledRows: typeof inventoryRows = [];
    if (missingProducts.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from("finished_products_inventory")
        .insert(missingProducts.map((p) => ({ product_id: p.id, on_hand_qty: 0 })))
        .select("id, product_id, on_hand_qty, updated_at");
      if (insertError) {
        setLoadError(insertError.message);
      } else {
        backfilledRows = (inserted || []) as typeof inventoryRows;
      }
    }

    const productNameById = new Map(products.map((p) => [p.id, p.name]));
    const combined: InventoryListRow[] = [...inventoryRows, ...backfilledRows].map((r) => {
      const embeddedName = Array.isArray(r.products) ? r.products[0]?.name : r.products?.name;
      return {
        id: r.id,
        product_id: r.product_id,
        product_name: embeddedName || productNameById.get(r.product_id) || "Unknown product",
        on_hand_qty: Number(r.on_hand_qty) || 0,
        updated_at: r.updated_at,
      };
    });

    setRows(combined);
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      await loadAll();
      if (!cancelled) setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, supabase]);

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = needle ? rows.filter((r) => r.product_name.toLowerCase().includes(needle)) : rows;
    const sorted = [...filtered].sort((a, b) => {
      const cmp =
        sortKey === "name"
          ? a.product_name.localeCompare(b.product_name)
          : a.on_hand_qty - b.on_hand_qty;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const toggleHistory = async (row: InventoryListRow) => {
    if (expandedProductId === row.product_id) {
      setExpandedProductId(null);
      return;
    }
    setExpandedProductId(row.product_id);
    if (transactionsByProduct.has(row.product_id)) return;

    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const { data, error } = await supabase
        .from("inventory_transactions")
        .select("id, type, quantity_delta, resulting_qty, reference_type, reference_id, note, created_at")
        .eq("product_id", row.product_id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;

      const transactions = (data || []) as TransactionRow[];
      setTransactionsByProduct((prev) => new Map(prev).set(row.product_id, transactions));

      const orderIds = Array.from(
        new Set(
          transactions
            .filter((t) => t.reference_type === "order" && t.reference_id)
            .map((t) => t.reference_id as string),
        ),
      ).filter((id) => !orderNameByOrderId.has(id));

      if (orderIds.length > 0) {
        const { data: orderRows, error: orderError } = await supabase
          .from("orders")
          .select("id, order_name")
          .in("id", orderIds);
        if (!orderError && orderRows) {
          setOrderNameByOrderId((prev) => {
            const next = new Map(prev);
            for (const o of orderRows as Array<{ id: string; order_name: string }>) {
              next.set(o.id, o.order_name);
            }
            return next;
          });
        }
      }
    } catch (err: any) {
      setHistoryError(err.message || "Failed to load transaction history.");
    } finally {
      setHistoryLoading(false);
    }
  };

  const referenceLabel = (t: TransactionRow): string => {
    if (t.reference_type === "order") {
      const name = t.reference_id ? orderNameByOrderId.get(t.reference_id) : null;
      return name ? `Order ${name}` : "Order";
    }
    if (t.reference_type === "production_cycle") {
      return t.reference_id ? `Cycle ${t.reference_id.slice(0, 8)}` : "Production cycle";
    }
    return "Manual count";
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">Finished Products Inventory</h1>
            <p className="text-sm text-black">
              On-hand quantity for BotanIQals finished products. Decremented automatically by Sales
              Data imports and incremented by completed production cycles.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCycleCountOpen(true)}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            Cycle Count
          </button>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="mb-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products…"
              className={`${inputClassName} max-w-xs`}
            />
          </div>

          {loading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : loadError ? (
            <p className="text-xs text-red-600" role="alert">
              {loadError}
            </p>
          ) : visibleRows.length === 0 ? (
            <p className="text-xs text-black">No BotanIQals products found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      <button type="button" onClick={() => toggleSort("name")} className="hover:text-zinc-800">
                        Product {sortKey === "name" && (sortDir === "asc" ? "↑" : "↓")}
                      </button>
                    </th>
                    <th className="px-3 py-2 font-medium">
                      <button type="button" onClick={() => toggleSort("qty")} className="hover:text-zinc-800">
                        On Hand {sortKey === "qty" && (sortDir === "asc" ? "↑" : "↓")}
                      </button>
                    </th>
                    <th className="px-3 py-2 font-medium">Last Updated</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const isLow = row.on_hand_qty < LOW_STOCK_THRESHOLD;
                    const isExpanded = expandedProductId === row.product_id;
                    const transactions = transactionsByProduct.get(row.product_id) || [];
                    return (
                      <>
                        <tr
                          key={row.id}
                          className={`border-b border-zinc-100 ${isLow ? "bg-amber-50" : ""}`}
                        >
                          <td className="px-3 py-2 font-medium text-zinc-900">{row.product_name}</td>
                          <td className={`px-3 py-2 font-semibold ${isLow ? "text-amber-800" : "text-zinc-800"}`}>
                            {row.on_hand_qty}
                            {isLow && (
                              <span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-medium text-amber-900">
                                Low stock
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-zinc-700">{formatDate(row.updated_at)}</td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => toggleHistory(row)}
                              className="text-[11px] font-medium text-emerald-700 underline"
                            >
                              {isExpanded ? "Hide history" : "Transaction History"}
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${row.id}-history`} className="border-b border-zinc-100 bg-zinc-50">
                            <td colSpan={4} className="px-3 py-3">
                              {historyLoading && transactions.length === 0 ? (
                                <p className="text-[11px] text-zinc-600">Loading history…</p>
                              ) : historyError ? (
                                <p className="text-[11px] text-red-600">{historyError}</p>
                              ) : transactions.length === 0 ? (
                                <p className="text-[11px] text-zinc-600">No transactions yet.</p>
                              ) : (
                                <table className="min-w-full border-collapse text-left text-[11px]">
                                  <thead className="text-zinc-500">
                                    <tr>
                                      <th className="px-2 py-1 font-medium">Type</th>
                                      <th className="px-2 py-1 font-medium">Delta</th>
                                      <th className="px-2 py-1 font-medium">Resulting Qty</th>
                                      <th className="px-2 py-1 font-medium">Date</th>
                                      <th className="px-2 py-1 font-medium">Reference</th>
                                      <th className="px-2 py-1 font-medium">Note</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {transactions.map((t) => (
                                      <tr key={t.id} className="border-t border-zinc-200">
                                        <td className="px-2 py-1 text-zinc-800">{typeLabel(t.type)}</td>
                                        <td className={`px-2 py-1 font-medium ${deltaClassName(t.quantity_delta)}`}>
                                          {formatDelta(t.quantity_delta)}
                                        </td>
                                        <td className="px-2 py-1 text-zinc-700">{t.resulting_qty}</td>
                                        <td className="px-2 py-1 text-zinc-700">{formatDate(t.created_at)}</td>
                                        <td className="px-2 py-1 text-zinc-700">{referenceLabel(t)}</td>
                                        <td className="px-2 py-1 text-zinc-700">{t.note || "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {cycleCountOpen && (
        <CycleCountModal
          rows={rows}
          supabase={supabase}
          userId={user?.id ?? null}
          onClose={() => setCycleCountOpen(false)}
          onSubmitted={async () => {
            setCycleCountOpen(false);
            await loadAll();
          }}
        />
      )}
    </AuthGuard>
  );
}

// --- Cycle Count modal ---------------------------------------------------

type CycleCountModalProps = {
  rows: InventoryListRow[];
  supabase: any;
  userId: string | null;
  onClose: () => void;
  onSubmitted: () => Promise<void> | void;
};

function CycleCountModal({ rows, supabase, userId, onClose, onSubmitted }: CycleCountModalProps) {
  const [step, setStep] = useState<"count" | "review">("count");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [rows],
  );

  const entries = useMemo(() => {
    return sortedRows
      .map((row) => {
        const raw = (counts[row.product_id] || "").trim();
        if (raw === "") return null;
        const counted = Number(raw);
        return {
          row,
          counted,
          raw,
          delta: counted - row.on_hand_qty,
        };
      })
      .filter((e): e is { row: InventoryListRow; counted: number; raw: string; delta: number } => e !== null);
  }, [sortedRows, counts]);

  const changedEntries = entries.filter((e) => e.delta !== 0);
  const unchangedCount = entries.length - changedEntries.length;

  const goToReview = () => {
    setValidationError(null);
    for (const row of sortedRows) {
      const raw = (counts[row.product_id] || "").trim();
      if (raw === "") continue;
      if (!/^\d+$/.test(raw)) {
        setValidationError(`Counted quantity for ${row.product_name} must be a non-negative whole number.`);
        return;
      }
      const counted = Number(raw);
      if (counted !== row.on_hand_qty && !(notes[row.product_id] || "").trim()) {
        setValidationError(`A reason is required for ${row.product_name} — the count doesn't match the system quantity.`);
        return;
      }
    }
    if (entries.length === 0) {
      setValidationError("Enter at least one counted quantity.");
      return;
    }
    setStep("review");
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const cache: InventoryRowCache = new Map(
        rows.map((r) => [r.product_id, { id: r.id, on_hand_qty: r.on_hand_qty }]),
      );
      for (const entry of entries) {
        await recordInventoryTransaction(supabase, {
          productId: entry.row.product_id,
          type: "cycle_count_adjustment",
          quantityDelta: entry.delta,
          referenceType: "manual",
          referenceId: null,
          note: entry.delta !== 0 ? (notes[entry.row.product_id] || "").trim() : null,
          createdBy: userId,
          cache,
        });
      }
      await onSubmitted();
    } catch (err: any) {
      setSubmitError(err.message || "Failed to submit cycle count.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">
            Cycle Count {step === "review" && "— Review"}
          </h2>
          <button type="button" onClick={onClose} className="text-xs font-medium text-zinc-500 hover:text-zinc-800">
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {step === "count" ? (
            <>
              <p className="mb-3 text-xs text-zinc-600">
                Enter physical counts for the products you&apos;re recounting this session — leave the
                rest blank to skip them. A reason is required only when a count doesn&apos;t match the
                system quantity.
              </p>
              <div className="space-y-2">
                {sortedRows.map((row) => {
                  const raw = (counts[row.product_id] || "").trim();
                  const counted = raw === "" ? null : Number(raw);
                  const showNote = raw !== "" && /^\d+$/.test(raw) && counted !== row.on_hand_qty;
                  return (
                    <div key={row.product_id} className="rounded border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs">
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <div className="font-medium text-zinc-900">{row.product_name}</div>
                          <div className="text-[11px] text-zinc-600">System qty: {row.on_hand_qty}</div>
                        </div>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={counts[row.product_id] || ""}
                          onChange={(e) =>
                            setCounts((prev) => ({ ...prev, [row.product_id]: e.target.value }))
                          }
                          placeholder="Counted qty"
                          className={`${inputClassName} w-28`}
                        />
                      </div>
                      {showNote && (
                        <input
                          value={notes[row.product_id] || ""}
                          onChange={(e) => setNotes((prev) => ({ ...prev, [row.product_id]: e.target.value }))}
                          placeholder="Reason for discrepancy (required)"
                          className={`${inputClassName} mt-2`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              {validationError && (
                <p className="mt-3 text-xs text-red-600" role="alert">
                  {validationError}
                </p>
              )}
            </>
          ) : (
            <>
              {changedEntries.length === 0 ? (
                <p className="text-xs text-zinc-600">No quantities are changing.</p>
              ) : (
                <table className="min-w-full border-collapse text-left text-xs">
                  <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Product</th>
                      <th className="px-3 py-2 font-medium">System → Counted</th>
                      <th className="px-3 py-2 font-medium">Delta</th>
                      <th className="px-3 py-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changedEntries.map((e) => (
                      <tr key={e.row.product_id} className="border-b border-zinc-100">
                        <td className="px-3 py-2 font-medium text-zinc-900">{e.row.product_name}</td>
                        <td className="px-3 py-2 text-zinc-700">
                          {e.row.on_hand_qty} → {e.counted}
                        </td>
                        <td className={`px-3 py-2 font-medium ${deltaClassName(e.delta)}`}>{formatDelta(e.delta)}</td>
                        <td className="px-3 py-2 text-zinc-700">{notes[e.row.product_id]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {unchangedCount > 0 && (
                <p className="mt-3 text-[11px] text-zinc-600">
                  + {unchangedCount} more counted with no change.
                </p>
              )}
              {submitError && (
                <p className="mt-3 text-xs text-red-600" role="alert">
                  {submitError}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          {step === "count" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={goToReview}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
              >
                Review
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep("count")}
                disabled={submitting}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {submitting ? "Submitting…" : "Confirm & Submit"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
