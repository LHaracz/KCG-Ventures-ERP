"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { RetailerEditor, defaultTermsText } from "@/components/retail/RetailerEditor";
import { InvoicesTab } from "@/components/retail/InvoicesTab";
import { Badge, RetailTabs, btn, btnPrimary, errorBox, input } from "@/components/retail/RetailUi";
import { fetchRetail } from "@/lib/retail/client";
import { formatShortDate } from "@/lib/retail/format";
import { termsSummary } from "@/lib/retail/terms";
import type { RetailBootstrap } from "@/lib/retail/service";
import type { Retailer } from "@/lib/retail/types";

export default function RetailPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <RetailInner />
      </Suspense>
    </AuthGuard>
  );
}

function RetailInner() {
  const { user } = useSupabase();
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get("tab") === "invoices" ? "invoices" : "retailers";
  const [data, setData] = useState<RetailBootstrap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Retailer | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await fetchRetail();
      setData(next);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    void load();
  }, [user, load]);

  const activeBusinesses = useMemo(() => (data?.businesses ?? []).filter((b) => !b.archived_at), [data]);
  const retailers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.retailers ?? [])
      .filter((r) => showArchived || !r.archived_at)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.contact_name ?? "").toLowerCase().includes(q) || (r.billing_city ?? "").toLowerCase().includes(q));
  }, [data, showArchived, search]);
  const archivedCount = (data?.retailers ?? []).filter((r) => r.archived_at).length;

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">Retail</h1>
          <p className="text-sm text-black">Retailers, their price lists and payment terms, and invoices for wholesale and consignment orders.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/fulfillment/retail/settings" className={btn}>
            Invoice settings
          </Link>
          <Link href="/fulfillment/retail/invoices/new" className={btnPrimary}>
            New invoice
          </Link>
        </div>
      </div>

      <RetailTabs tab={tab} />

      {loadError && (
        <p className={errorBox} role="alert">
          {loadError}
        </p>
      )}

      {tab === "retailers" ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <input aria-label="Search retailers" placeholder="Search retailers" value={search} onChange={(e) => setSearch(e.target.value)} className={`${input} w-64`} />
              <label className="inline-flex items-center gap-2 text-xs text-black">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived ({archivedCount})
              </label>
            </div>
            <button type="button" className={btnPrimary} onClick={() => setEditing("new")} disabled={!data}>
              Add retailer
            </button>
          </div>
          {!data && !loadError && <p className="text-xs text-black">Loading…</p>}
          {data && retailers.length === 0 && (
            <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">
              {data.retailers.length === 0 ? "No retailers yet. Add your first retailer to start making invoices." : "No retailers match."}
            </p>
          )}
          {data && retailers.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
              <table className="min-w-full text-left text-xs text-black">
                <thead className="bg-zinc-50">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Retailer</th>
                    <th className="px-3 py-2 font-semibold">Contact</th>
                    <th className="px-3 py-2 font-semibold">Location</th>
                    {activeBusinesses.map((b) => (
                      <th key={b.id} className="px-3 py-2 font-semibold">
                        {b.display_name} terms
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-semibold">Invoices</th>
                    <th className="px-3 py-2 font-semibold">Last invoice</th>
                    <th className="px-3 py-2 font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {retailers.map((r) => {
                    const stats = data.invoiceStats[r.id];
                    return (
                      <tr key={r.id} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-2">
                          <Link href={`/fulfillment/retail/retailers/${r.id}`} className="font-medium text-black underline">
                            {r.name}
                          </Link>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {r.archived_at && <Badge>Archived</Badge>}
                            {r.tax_exempt && <Badge tone="blue">Tax exempt</Badge>}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {r.contact_name || "—"}
                          {r.contact_email ? <div>{r.contact_email}</div> : null}
                        </td>
                        <td className="px-3 py-2">{[r.billing_city, r.billing_state].filter(Boolean).join(", ") || "—"}</td>
                        {activeBusinesses.map((b) => {
                          const t = data.terms.find((x) => x.retailer_id === r.id && x.company_profile_id === b.id);
                          return (
                            <td key={b.id} className="px-3 py-2">
                              {t ? (
                                <span className={t.terms_type === "consignment" ? "font-medium" : ""}>{termsSummary(t)}</span>
                              ) : (
                                <span>Default ({defaultTermsText(data.settings.find((s) => s.company_profile_id === b.id))})</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right">{stats?.count ?? 0}</td>
                        <td className="px-3 py-2">{stats?.last_invoice_date ? formatShortDate(stats.last_invoice_date) : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Link href={`/fulfillment/retail/retailers/${r.id}`} className={btn}>
                              View
                            </Link>
                            <button type="button" className={btn} onClick={() => setEditing(r)}>
                              Edit
                            </button>
                            {!r.archived_at && (
                              <Link href={`/fulfillment/retail/invoices/new?retailer=${r.id}`} className={btn}>
                                New invoice
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <InvoicesTab businesses={data?.businesses ?? []} retailers={data?.retailers ?? []} />
      )}

      {editing && data && (
        <RetailerEditor
          retailer={editing === "new" ? null : editing}
          businesses={data.businesses}
          settings={data.settings}
          terms={editing === "new" ? [] : data.terms.filter((t) => t.retailer_id === editing.id)}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            if (editing === "new") router.push(`/fulfillment/retail/retailers/${r.id}`);
            else void load();
          }}
        />
      )}
    </div>
  );
}
