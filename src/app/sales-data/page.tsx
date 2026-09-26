"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate, toMidnight } from "@/lib/date";

type OrderRow = {
  id: string;
  shopify_order_id: string;
  order_name: string;
  created_at: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  customer_email: string | null;
  customer_name: string | null;
  total: number | null;
};

type LineItemRow = {
  order_id: string;
  lineitem_name: string;
  quantity: number;
  position: number;
};

type MappingComponent = { product_id: string; qty_per_unit: number };

type MapRow = {
  lineitem_name: string;
  business: "minileaf" | "botaniqals";
  components: MappingComponent[];
};

type ProductOption = {
  id: string;
  name: string;
};

type UnmappedRow = {
  id: string;
  lineitem_name: string;
  first_seen_at: string;
  order_count: number;
};

type BusinessTag = "botaniqals" | "minileaf" | "Mixed" | "Unmapped";

const PAGE_SIZE = 100;
const FETCH_PAGE_SIZE = 1000;

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function businessLabel(tag: BusinessTag): string {
  if (tag === "botaniqals") return "BotanIQals";
  if (tag === "minileaf") return "MiniLeaf";
  return tag;
}

function formatTotal(amount: number | null): string {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

// Supabase/PostgREST caps unbounded selects at a default row limit, which
// silently truncated the (created_at-desc-sorted) orders/line-items fetch to
// only the newest rows once enough history was imported. This loops through
// with explicit .range() pages until a page comes back short, so nothing is
// ever silently dropped.
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  let offset = 0;
  let all: T[] = [];
  while (true) {
    const { data, error } = await build(offset, offset + FETCH_PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const rows = data || [];
    all = all.concat(rows);
    if (rows.length < FETCH_PAGE_SIZE) break;
    offset += FETCH_PAGE_SIZE;
  }
  return { data: all, error: null };
}

export default function SalesDataPage() {
  const { user, supabase } = useSupabase();

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [lineItems, setLineItems] = useState<LineItemRow[]>([]);
  const [variantMap, setVariantMap] = useState<MapRow[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedRow[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [importSince, setImportSince] = useState("");
  const [importUntil, setImportUntil] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [orderNameFilter, setOrderNameFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [businessFilter, setBusinessFilter] = useState<"all" | BusinessTag>("all");
  const [currentPage, setCurrentPage] = useState(1);

  const loadAll = async () => {
    const [ordersResult, lineItemsResult, mapResult, unmappedResult, productsResult] = await Promise.all([
      fetchAllRows<OrderRow>((from, to) =>
        supabase.from("orders").select("*").order("created_at", { ascending: false }).range(from, to),
      ),
      fetchAllRows<LineItemRow>((from, to) =>
        supabase
          .from("order_line_items")
          .select("order_id, lineitem_name, quantity, position")
          .order("order_id", { ascending: true })
          .order("position", { ascending: true })
          .range(from, to),
      ),
      supabase.from("variant_component_map").select("lineitem_name, business, components"),
      supabase.from("unmapped_line_items").select("*").order("order_count", { ascending: false }),
      supabase.from("products").select("id, name").eq("is_microgreen", false),
    ]);
    if (
      ordersResult.error ||
      lineItemsResult.error ||
      mapResult.error ||
      unmappedResult.error ||
      productsResult.error
    ) {
      setLoadError(
        [
          ordersResult.error?.message,
          lineItemsResult.error?.message,
          mapResult.error?.message,
          unmappedResult.error?.message,
          productsResult.error?.message,
        ]
          .filter(Boolean)
          .join(" | "),
      );
    }
    setOrders(ordersResult.data);
    setLineItems(lineItemsResult.data);
    setVariantMap((mapResult.data || []) as MapRow[]);
    setUnmapped((unmappedResult.data || []) as UnmappedRow[]);
    setProducts((productsResult.data || []) as ProductOption[]);
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

  // Reset to page 1 whenever a filter changes, so the page index never gets
  // stranded past the end of a newly-narrowed result set.
  useEffect(() => {
    setCurrentPage(1);
  }, [orderNameFilter, customerFilter, dateAfter, dateBefore, businessFilter]);

  const lineItemsByOrderId = useMemo(() => {
    const map = new Map<string, LineItemRow[]>();
    for (const li of lineItems) {
      const arr = map.get(li.order_id) ?? [];
      arr.push(li);
      map.set(li.order_id, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [lineItems]);

  const productNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products) map.set(p.id, p.name);
    return map;
  }, [products]);

  const componentsByLineitemName = useMemo(() => {
    const map = new Map<string, MappingComponent[]>();
    for (const m of variantMap) map.set(m.lineitem_name, m.components || []);
    return map;
  }, [variantMap]);

  const businessByLineitemName = useMemo(() => {
    const map = new Map<string, "minileaf" | "botaniqals">();
    for (const m of variantMap) map.set(m.lineitem_name, m.business);
    return map;
  }, [variantMap]);

  const businessTagByOrderId = useMemo(() => {
    const map = new Map<string, BusinessTag>();
    for (const order of orders) {
      const items = lineItemsByOrderId.get(order.id) ?? [];
      if (items.length === 0) {
        map.set(order.id, "Unmapped");
        continue;
      }
      const businesses = new Set<string>();
      let hasUnmapped = false;
      for (const li of items) {
        const business = businessByLineitemName.get(li.lineitem_name);
        if (!business) {
          hasUnmapped = true;
        } else {
          businesses.add(business);
        }
      }
      if (businesses.size === 0) {
        map.set(order.id, "Unmapped");
      } else if (businesses.size === 1 && !hasUnmapped) {
        map.set(order.id, Array.from(businesses)[0] as BusinessTag);
      } else {
        map.set(order.id, "Mixed");
      }
    }
    return map;
  }, [orders, lineItemsByOrderId, businessByLineitemName]);

  const authedFetch = async (path: string, body: unknown) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    const response = await fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Request failed.");
    }
    return payload;
  };

  const handleImport = async () => {
    setImporting(true);
    setImportError(null);
    setImportMessage(null);
    try {
      const payload = await authedFetch("/api/sales-data/import", {
        since: importSince || null,
        until: importUntil || null,
      });
      setImportMessage(
        `Imported ${payload.importedOrders} order(s). ${payload.newUnmappedCount} new unmapped line item(s) found.`,
      );
      await loadAll();
      setCurrentPage(1);
    } catch (err: any) {
      setImportError(err.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const visibleOrders = useMemo(() => {
    const orderNeedle = orderNameFilter.trim().toLowerCase();
    const customerNeedle = customerFilter.trim().toLowerCase();
    const afterMs = dateAfter ? toMidnight(dateAfter).getTime() : null;
    const beforeMs = dateBefore ? toMidnight(dateBefore).getTime() + 24 * 60 * 60 * 1000 - 1 : null;

    return orders.filter((o) => {
      if (orderNeedle && !o.order_name.toLowerCase().includes(orderNeedle)) return false;
      if (
        customerNeedle &&
        !(o.customer_name ?? "").toLowerCase().includes(customerNeedle) &&
        !(o.customer_email ?? "").toLowerCase().includes(customerNeedle)
      ) {
        return false;
      }
      if (afterMs != null || beforeMs != null) {
        const createdMs = new Date(o.created_at).getTime();
        if (afterMs != null && createdMs < afterMs) return false;
        if (beforeMs != null && createdMs > beforeMs) return false;
      }
      if (businessFilter !== "all" && businessTagByOrderId.get(o.id) !== businessFilter) return false;
      return true;
    });
  }, [orders, orderNameFilter, customerFilter, dateAfter, dateBefore, businessFilter, businessTagByOrderId]);

  const totalPages = Math.max(1, Math.ceil(visibleOrders.length / PAGE_SIZE));

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const pagedOrders = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return visibleOrders.slice(start, start + PAGE_SIZE);
  }, [visibleOrders, currentPage]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <section>
          <h1 className="mb-2 text-2xl font-semibold text-zinc-900">Sales Data</h1>
          <p className="text-sm text-black">
            Imported Shopify orders, mapped to products by line item name so sales can be tracked
            by business.
          </p>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Setup</h2>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/settings/variant-mapping"
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
            >
              Variant Mapping
            </Link>
          </div>
        </section>

        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">
            Unmapped Line Items {unmapped.length > 0 && `(${unmapped.length})`}
          </h2>
          {unmapped.length === 0 ? (
            <p className="text-xs text-zinc-700">
              Nothing needs mapping right now — every imported line item resolves to a product.
            </p>
          ) : (
            <div className="space-y-2">
              {unmapped.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between rounded border border-amber-200 bg-white px-3 py-2 text-xs"
                >
                  <div>
                    <div className="font-medium text-zinc-900">{u.lineitem_name}</div>
                    <div className="text-[11px] text-zinc-600">
                      Seen on {u.order_count} order{u.order_count === 1 ? "" : "s"} · first seen{" "}
                      {formatDate(u.first_seen_at)}
                    </div>
                  </div>
                  <Link
                    href={`/settings/variant-mapping?lineitem=${encodeURIComponent(u.lineitem_name)}`}
                    className="rounded-md bg-amber-500 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-amber-600"
                  >
                    Map this
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Import Orders</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">
                Since (blank = since last import)
              </label>
              <input
                type="date"
                value={importSince}
                onChange={(e) => setImportSince(e.target.value)}
                className={`${inputClassName} w-auto`}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Until (optional)</label>
              <input
                type="date"
                value={importUntil}
                onChange={(e) => setImportUntil(e.target.value)}
                className={`${inputClassName} w-auto`}
              />
            </div>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {importing ? "Importing…" : "Import Orders"}
            </button>
          </div>
          {importMessage && <p className="mt-2 text-xs text-emerald-700">{importMessage}</p>}
          {importError && (
            <p className="mt-2 text-xs text-red-600" role="alert">
              {importError}
            </p>
          )}
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Filter &amp; Sort</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Order #</label>
              <input
                value={orderNameFilter}
                onChange={(e) => setOrderNameFilter(e.target.value)}
                placeholder="#1082"
                className={inputClassName}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Customer</label>
              <input
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                placeholder="Name or email"
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
              <label className="mb-1 block text-xs font-medium text-zinc-800">Business</label>
              <select
                value={businessFilter}
                onChange={(e) => setBusinessFilter(e.target.value as "all" | BusinessTag)}
                className={inputClassName}
              >
                <option value="all">All</option>
                <option value="botaniqals">BotanIQals</option>
                <option value="minileaf">MiniLeaf</option>
                <option value="Mixed">Mixed</option>
                <option value="Unmapped">Unmapped</option>
              </select>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          {loading ? (
            <p className="text-xs text-black">Loading orders…</p>
          ) : loadError ? (
            <p className="text-xs text-red-600" role="alert">
              {loadError}
            </p>
          ) : orders.length === 0 ? (
            <p className="text-xs text-black">No orders imported yet. Use Import Orders above.</p>
          ) : visibleOrders.length === 0 ? (
            <p className="text-xs text-black">No orders match the current filters.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-xs">
                  <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Order</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Customer</th>
                      <th className="px-3 py-2 font-medium">Total</th>
                      <th className="px-3 py-2 font-medium">Business</th>
                      <th className="px-3 py-2 font-medium">Line Item Name</th>
                      <th className="px-3 py-2 font-medium">Products</th>
                      <th className="px-3 py-2 font-medium">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedOrders.map((o) => {
                      const items = lineItemsByOrderId.get(o.id) ?? [];
                      return (
                        <tr key={o.id} className="border-b border-zinc-100">
                          <td className="px-3 py-2 align-top font-medium text-zinc-900">{o.order_name}</td>
                          <td className="px-3 py-2 align-top text-zinc-700">{formatDate(o.created_at)}</td>
                          <td className="px-3 py-2 align-top text-zinc-700">
                            {o.customer_name || o.customer_email || "—"}
                          </td>
                          <td className="px-3 py-2 align-top text-zinc-700">{formatTotal(o.total)}</td>
                          <td className="px-3 py-2 align-top text-zinc-700">
                            {businessLabel(businessTagByOrderId.get(o.id) ?? "Unmapped")}
                          </td>
                          <td className="px-3 py-2 align-top text-zinc-700">
                            {items.length === 0 ? (
                              "—"
                            ) : (
                              <div className="divide-y divide-zinc-100">
                                {items.map((li, i) => (
                                  <div key={i} className="py-1 first:pt-0 last:pb-0">
                                    {li.lineitem_name}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-zinc-700">
                            {items.length === 0 ? (
                              "—"
                            ) : (
                              <div className="divide-y divide-zinc-100">
                                {items.map((li, i) => {
                                  const components = componentsByLineitemName.get(li.lineitem_name) ?? [];
                                  return (
                                    <div key={i} className="py-1 first:pt-0 last:pb-0">
                                      {components.length === 0 ? (
                                        <span className="text-zinc-400">Unmapped</span>
                                      ) : (
                                        <div className="space-y-0.5">
                                          {components.map((c, j) => (
                                            <div key={j}>
                                              {productNameById.get(c.product_id) ?? "Unknown product"}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-zinc-700">
                            {items.length === 0 ? (
                              "—"
                            ) : (
                              <div className="divide-y divide-zinc-100">
                                {items.map((li, i) => (
                                  <div key={i} className="py-1 first:pt-0 last:pb-0">
                                    {li.quantity}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600">
                <span>
                  Page {currentPage} of {totalPages} ({visibleOrders.length} order
                  {visibleOrders.length === 1 ? "" : "s"})
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage <= 1}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage >= totalPages}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </AuthGuard>
  );
}
