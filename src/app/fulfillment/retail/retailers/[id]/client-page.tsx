"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { RetailerEditor, defaultTermsText } from "@/components/retail/RetailerEditor";
import { Badge, BackToRetail, ConfirmDialog, Dialog, btn, btnPrimary, card, errorBox, infoBox, input } from "@/components/retail/RetailUi";
import {
  archiveRetailerApi,
  fetchRetail,
  fetchRetailerDetail,
  priceToolApi,
  restoreRetailerApi,
  savePricesApi,
  RetailApiError,
} from "@/lib/retail/client";
import { formatMoney, formatShortDate, formatUnitPrice } from "@/lib/retail/format";
import { termsLabel, consignmentTermsText, termsSummary } from "@/lib/retail/terms";
import { retailerMargin } from "@/lib/retail/totals";
import { PRICE_LIST_NOTE, productBusinessLabel, RETAIL_NOTES_HINT, type RetailProduct } from "@/lib/retail/types";
import { parseListPrice } from "@/lib/retail/validation";
import { editedSinceDownload } from "@/lib/retail/snapshots";
import type { PriceChange, RetailBootstrap, RetailerDetail } from "@/lib/retail/service";

export default function RetailerDetailPage() {
  return (
    <AuthGuard>
      <RetailerDetailInner />
    </AuthGuard>
  );
}

type PriceDraft = { wholesale_price: string; msrp: string; notes: string };
type Tool = { tool: "fill_msrp" } | { tool: "fill_wholesale"; percent: string } | { tool: "copy"; source_retailer_id: string; overwrite: boolean };

const str = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : String(Number(v)));

function RetailerDetailInner() {
  const { user } = useSupabase();
  const { id } = useParams<{ id: string }>();
  const [boot, setBoot] = useState<RetailBootstrap | null>(null);
  const [detail, setDetail] = useState<RetailerDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [toolPreview, setToolPreview] = useState<PriceChange[] | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "missing">("all");

  const load = useCallback(async () => {
    try {
      const [b, d] = await Promise.all([fetchRetail(), fetchRetailerDetail(id)]);
      setBoot(b);
      setDetail(d);
      setDrafts({});
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  const priceBy = useMemo(() => new Map((detail?.prices ?? []).map((p) => [p.product_id, p])), [detail]);
  const products = useMemo(() => {
    const list = [...(boot?.products ?? [])].sort((a, b) => productBusinessLabel(a).localeCompare(productBusinessLabel(b)) || a.name.localeCompare(b.name));
    if (filter === "missing") return list.filter((p) => !priceBy.get(p.id)?.wholesale_price || !priceBy.get(p.id)?.msrp);
    return list;
  }, [boot, filter, priceBy]);

  if (loadError) {
    return (
      <div className="mx-auto max-w-7xl space-y-3 text-black">
        <BackToRetail />
        <p className={errorBox} role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (!boot || !detail) return <p className="text-xs text-black">Loading…</p>;
  const r = detail.retailer;

  const draftFor = (p: RetailProduct): PriceDraft => {
    const row = priceBy.get(p.id);
    return drafts[p.id] ?? { wholesale_price: str(row?.wholesale_price), msrp: str(row?.msrp), notes: row?.notes ?? "" };
  };
  const dirty = Object.keys(drafts).filter((pid) => {
    const row = priceBy.get(pid);
    const d = drafts[pid];
    return d.wholesale_price !== str(row?.wholesale_price) || d.msrp !== str(row?.msrp) || d.notes !== (row?.notes ?? "");
  });
  const setDraft = (p: RetailProduct, patch: Partial<PriceDraft>) => {
    setSaved(null);
    setDrafts((all) => ({ ...all, [p.id]: { ...draftFor(p), ...patch } }));
  };

  const savePrices = async () => {
    const errs: Record<string, string> = {};
    const rows = dirty.map((pid) => {
      const d = drafts[pid];
      const w = parseListPrice(d.wholesale_price);
      const m = parseListPrice(d.msrp);
      if (!w.ok) errs[`prices.${pid}.wholesale_price`] = w.error;
      if (!m.ok) errs[`prices.${pid}.msrp`] = m.error;
      return { product_id: pid, wholesale_price: d.wholesale_price, msrp: d.msrp, notes: d.notes };
    });
    setPriceErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await savePricesApi(r.id, rows);
      setDetail({ ...detail, prices: res.prices });
      setDrafts({});
      setSaved(`Saved ${rows.length} price${rows.length === 1 ? "" : "s"}.`);
    } catch (e) {
      const err = e as RetailApiError;
      setActionError(err.message);
      if (err.fields) setPriceErrors(err.fields);
    } finally {
      setBusy(false);
    }
  };

  const toolBody = (t: Tool): Record<string, unknown> =>
    t.tool === "fill_wholesale" ? { tool: t.tool, percent: Number(t.percent) } : t.tool === "copy" ? { tool: t.tool, source_retailer_id: t.source_retailer_id, overwrite: t.overwrite } : { tool: t.tool };

  const previewTool = async () => {
    if (!tool) return;
    setToolError(null);
    setBusy(true);
    try {
      const res = await priceToolApi(r.id, toolBody(tool), false);
      setToolPreview(res.changes);
    } catch (e) {
      setToolError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const applyTool = async () => {
    if (!tool) return;
    setToolError(null);
    setBusy(true);
    try {
      const res = await priceToolApi(r.id, toolBody(tool), true);
      setTool(null);
      setToolPreview(null);
      await load();
      setSaved(`Updated ${res.changes.length} price${res.changes.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setToolError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    setBusy(true);
    setActionError(null);
    try {
      if (r.archived_at) await restoreRetailerApi(r.id);
      else await archiveRetailerApi(r.id);
      setArchiveOpen(false);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeBusinesses = boot.businesses.filter((b) => !b.archived_at);
  const otherRetailers = boot.retailers.filter((x) => x.id !== r.id).sort((a, b) => a.name.localeCompare(b.name));
  const shipping = r.shipping_same_as_billing
    ? "Same as billing"
    : [r.shipping_name, r.shipping_line1, r.shipping_line2, [r.shipping_city, r.shipping_state, r.shipping_zip].filter(Boolean).join(", "), r.shipping_country].filter(Boolean).join("\n");
  const billing = [r.billing_line1, r.billing_line2, [r.billing_city, r.billing_state, r.billing_zip].filter(Boolean).join(", "), r.billing_country].filter(Boolean).join("\n");

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <BackToRetail />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">{r.name}</h1>
          <div className="mt-1 flex flex-wrap gap-1">
            {r.archived_at && <Badge>Archived</Badge>}
            {r.tax_exempt && <Badge tone="blue">Tax exempt</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => setEditing(true)}>
            Edit retailer
          </button>
          <button type="button" className={btn} onClick={() => setArchiveOpen(true)}>
            {r.archived_at ? "Restore" : "Archive"}
          </button>
          {!r.archived_at && (
            <Link href={`/fulfillment/retail/invoices/new?retailer=${r.id}`} className={btnPrimary}>
              New invoice
            </Link>
          )}
        </div>
      </div>
      {actionError && (
        <p className={errorBox} role="alert">
          {actionError}
        </p>
      )}

      <section className={`${card} grid grid-cols-1 gap-4 text-xs md:grid-cols-3`}>
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Contact</h2>
          {r.legal_name && <p>Legal name: {r.legal_name}</p>}
          <p>{r.contact_name || "No contact name"}</p>
          {r.contact_email && <p>{r.contact_email}</p>}
          {r.contact_phone && <p>{r.contact_phone}</p>}
          {r.website_url && (
            <p>
              <a href={r.website_url} target="_blank" rel="noopener noreferrer" className="text-black underline">
                {r.website_url}
              </a>
            </p>
          )}
          {r.tax_exempt && <p>Resale certificate: {r.resale_certificate_number || "not recorded"}</p>}
          {r.description && <p className="whitespace-pre-line">{r.description}</p>}
        </div>
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Addresses</h2>
          <p className="font-medium">Billing</p>
          <p className="whitespace-pre-line">{billing || "—"}</p>
          <p className="mt-2 font-medium">Shipping</p>
          <p className="whitespace-pre-line">{shipping || "—"}</p>
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Payment terms</h2>
          {activeBusinesses.map((b) => {
            const t = detail.terms.find((x) => x.company_profile_id === b.id);
            return (
              <div key={b.id}>
                <p className="font-medium">{b.display_name}</p>
                {t ? (
                  <>
                    <p>{t.terms_type === "consignment" ? termsSummary(t) : termsLabel(t)}{t.terms_type === "net" && t.terms_start === "delivery_date" ? " (from delivery date)" : ""}</p>
                    {t.terms_type === "consignment" && (
                      <ul className="mt-1 list-disc pl-4">
                        {consignmentTermsText(t, b.legal_name).map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p>Business default ({defaultTermsText(boot.settings.find((s) => s.company_profile_id === b.id))})</p>
                )}
              </div>
            );
          })}
          {r.notes && (
            <div>
              <p className="font-medium">Internal notes</p>
              <p className="whitespace-pre-line">{r.notes}</p>
              <p className="text-[11px]">{RETAIL_NOTES_HINT}</p>
            </div>
          )}
        </div>
      </section>

      <section className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Price list</h2>
            <p className="text-xs">{PRICE_LIST_NOTE}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} onClick={() => { setTool({ tool: "fill_msrp" }); setToolPreview(null); setToolError(null); }}>
              Fill MSRP from shop prices
            </button>
            <button type="button" className={btn} onClick={() => { setTool({ tool: "fill_wholesale", percent: "50" }); setToolPreview(null); setToolError(null); }}>
              Fill wholesale from MSRP
            </button>
            <button type="button" className={btn} onClick={() => { setTool({ tool: "copy", source_retailer_id: otherRetailers[0]?.id ?? "", overwrite: false }); setToolPreview(null); setToolError(null); }} disabled={otherRetailers.length === 0}>
              Copy from another retailer
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="inline-flex items-center gap-2 text-xs">
            <input type="checkbox" checked={filter === "missing"} onChange={(e) => setFilter(e.target.checked ? "missing" : "all")} />
            Only products missing a price
          </label>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs">{saved}</span>}
            {dirty.length > 0 && (
              <button type="button" className={btn} onClick={() => { setDrafts({}); setPriceErrors({}); }} disabled={busy}>
                Discard changes
              </button>
            )}
            <button type="button" className={btnPrimary} onClick={savePrices} disabled={busy || dirty.length === 0}>
              {busy ? "Saving…" : dirty.length > 0 ? `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}` : "Save prices"}
            </button>
          </div>
        </div>
        {products.length === 0 ? (
          <p className="text-xs">{filter === "missing" ? "Every product has both prices." : "No products yet."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-zinc-50">
                <tr>
                  <th className="px-2 py-2 font-semibold">Product</th>
                  <th className="px-2 py-2 font-semibold">Business</th>
                  <th className="px-2 py-2 text-right font-semibold">Shop price</th>
                  <th className="px-2 py-2 font-semibold">Wholesale price</th>
                  <th className="px-2 py-2 font-semibold">MSRP (retail)</th>
                  <th className="px-2 py-2 text-right font-semibold">Retailer margin</th>
                  <th className="px-2 py-2 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const d = draftFor(p);
                  const margin = retailerMargin(d.msrp, d.wholesale_price);
                  const changed = dirty.includes(p.id);
                  const we = priceErrors[`prices.${p.id}.wholesale_price`];
                  const me = priceErrors[`prices.${p.id}.msrp`];
                  return (
                    <tr key={p.id} className={`border-t border-zinc-100 align-top ${changed ? "bg-amber-50" : ""}`}>
                      <td className="px-2 py-1.5 font-medium">{p.name}</td>
                      <td className="px-2 py-1.5">{productBusinessLabel(p)}</td>
                      <td className="px-2 py-1.5 text-right">{p.sale_price_per_unit ? formatUnitPrice(p.sale_price_per_unit) : "—"}</td>
                      <td className="px-2 py-1.5">
                        <input aria-label={`Wholesale price for ${p.name}`} inputMode="decimal" value={d.wholesale_price} onChange={(e) => setDraft(p, { wholesale_price: e.target.value })} placeholder="0.00" className={`${input} w-24 ${we ? "border-red-500" : ""}`} />
                        {we && <p className="text-[11px] text-red-700">{we}</p>}
                      </td>
                      <td className="px-2 py-1.5">
                        <input aria-label={`MSRP for ${p.name}`} inputMode="decimal" value={d.msrp} onChange={(e) => setDraft(p, { msrp: e.target.value })} placeholder="0.00" className={`${input} w-24 ${me ? "border-red-500" : ""}`} />
                        {me && <p className="text-[11px] text-red-700">{me}</p>}
                      </td>
                      <td className="px-2 py-1.5 text-right">{margin ? `${margin}%` : "—"}</td>
                      <td className="px-2 py-1.5">
                        <input aria-label={`Notes for ${p.name}`} value={d.notes} onChange={(e) => setDraft(p, { notes: e.target.value })} className={`${input} w-48`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={`${card} space-y-2`}>
        <h2 className="text-sm font-semibold">Invoices</h2>
        {detail.invoices.length === 0 ? (
          <p className="text-xs">No invoices for this retailer yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-zinc-50">
                <tr>
                  <th className="px-2 py-2 font-semibold">Invoice</th>
                  <th className="px-2 py-2 font-semibold">Shopify order</th>
                  <th className="px-2 py-2 font-semibold">Business</th>
                  <th className="px-2 py-2 font-semibold">Invoice date</th>
                  <th className="px-2 py-2 font-semibold">Terms</th>
                  <th className="px-2 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {detail.invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-zinc-100">
                    <td className="px-2 py-1.5">
                      <Link href={`/fulfillment/retail/invoices/${inv.id}`} className="font-medium text-black underline">
                        {inv.invoice_number}
                      </Link>{" "}
                      {inv.last_downloaded_at && editedSinceDownload(inv) && <Badge tone="amber">Edited since last download</Badge>}
                    </td>
                    <td className="px-2 py-1.5">{inv.order_number}</td>
                    <td className="px-2 py-1.5">{inv.business_name}</td>
                    <td className="px-2 py-1.5">{formatShortDate(inv.invoice_date)}</td>
                    <td className="px-2 py-1.5">{inv.terms_type === "consignment" ? "Consignment" : termsLabel(inv)}</td>
                    <td className="px-2 py-1.5 text-right">{formatMoney(inv.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {tool && (
        <Dialog
          title={tool.tool === "fill_msrp" ? "Fill MSRP from shop prices" : tool.tool === "fill_wholesale" ? "Fill wholesale from MSRP" : "Copy prices from another retailer"}
          onClose={() => setTool(null)}
          wide
        >
          <div className="space-y-3 text-xs text-black">
            {tool.tool === "fill_msrp" && <p>Sets MSRP to each product&apos;s shop price where this retailer has no MSRP yet. Existing prices are not changed.</p>}
            {tool.tool === "fill_wholesale" && (
              <div className="space-y-2">
                <p>Sets the wholesale price to a percentage of MSRP (rounded to cents) where there is an MSRP and no wholesale price yet. Existing prices are not changed.</p>
                <label className="inline-flex items-center gap-2">
                  Wholesale is
                  <input aria-label="Percent of MSRP" inputMode="decimal" value={tool.percent} onChange={(e) => { setTool({ ...tool, percent: e.target.value.replace(/[^\d.]/g, "") }); setToolPreview(null); }} className={`${input} w-20`} />
                  % of MSRP
                </label>
              </div>
            )}
            {tool.tool === "copy" && (
              <div className="space-y-2">
                <p>Copies wholesale prices and MSRP from another retailer&apos;s price list.</p>
                <label className="block">
                  <span className="mb-1 block font-medium">Copy from</span>
                  <select value={tool.source_retailer_id} onChange={(e) => { setTool({ ...tool, source_retailer_id: e.target.value }); setToolPreview(null); }} className={input}>
                    {otherRetailers.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                        {x.archived_at ? " (archived)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={tool.overwrite} onChange={(e) => { setTool({ ...tool, overwrite: e.target.checked }); setToolPreview(null); }} />
                  Replace prices this retailer already has
                </label>
              </div>
            )}
            {dirty.length > 0 && <p className={infoBox}>You have unsaved price edits. Save or discard them first; applying this reloads the price list.</p>}
            {toolError && (
              <p className={errorBox} role="alert">
                {toolError}
              </p>
            )}
            {toolPreview && (
              <div className="max-h-72 overflow-y-auto rounded-md border border-zinc-200">
                {toolPreview.length === 0 ? (
                  <p className="p-2">Nothing to change.</p>
                ) : (
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-zinc-50">
                      <tr>
                        <th className="px-2 py-1 font-semibold">Product</th>
                        <th className="px-2 py-1 font-semibold">Field</th>
                        <th className="px-2 py-1 text-right font-semibold">Now</th>
                        <th className="px-2 py-1 text-right font-semibold">New</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toolPreview.map((c) => (
                        <tr key={`${c.product_id}-${c.field}`} className="border-t border-zinc-100">
                          <td className="px-2 py-1">{c.product_name}</td>
                          <td className="px-2 py-1">{c.field === "msrp" ? "MSRP" : "Wholesale"}</td>
                          <td className="px-2 py-1 text-right">{c.from ? formatUnitPrice(c.from) : "—"}</td>
                          <td className="px-2 py-1 text-right font-medium">{formatUnitPrice(c.to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => setTool(null)} disabled={busy}>
                Cancel
              </button>
              {!toolPreview ? (
                <button type="button" className={btnPrimary} onClick={previewTool} disabled={busy || (tool.tool === "copy" && !tool.source_retailer_id) || dirty.length > 0}>
                  {busy ? "Working…" : "Preview changes"}
                </button>
              ) : (
                <button type="button" className={btnPrimary} onClick={applyTool} disabled={busy || toolPreview.length === 0 || dirty.length > 0}>
                  {busy ? "Working…" : `Apply ${toolPreview.length} change${toolPreview.length === 1 ? "" : "s"}`}
                </button>
              )}
            </div>
          </div>
        </Dialog>
      )}

      {archiveOpen && (
        <ConfirmDialog title={r.archived_at ? `Restore ${r.name}?` : `Archive ${r.name}?`} confirmLabel={r.archived_at ? "Restore" : "Archive"} busy={busy} error={actionError} onConfirm={toggleArchive} onClose={() => setArchiveOpen(false)}>
          {r.archived_at ? (
            <p>The retailer comes back on the Retailers tab and can be chosen for new invoices.</p>
          ) : (
            <p>The retailer is hidden from new invoices. Its price list and invoices are kept, and existing invoices still open and download.</p>
          )}
        </ConfirmDialog>
      )}

      {editing && (
        <RetailerEditor
          retailer={r}
          businesses={boot.businesses}
          settings={boot.settings}
          terms={detail.terms}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
