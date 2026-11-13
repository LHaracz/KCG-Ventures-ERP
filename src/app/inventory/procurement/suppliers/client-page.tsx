"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { BackToProcurementLink, ExternalLink, PaymentChips, PriceText, StockBadge, btn, btnDanger, btnPrimary, linkBtn } from "@/components/procurement/ProcurementUi";
import { ConfirmDialog, SupplierEditorModal } from "@/components/procurement/ProcurementForms";
import { archiveSupplierApi, fetchProcurement } from "@/lib/procurement/client";
import { newPoHref } from "@/lib/procurement/poPrefill";
import { formatNyDate } from "@/lib/nyTime";
import { procurementHref, type ProcurementData, type Supplier } from "@/lib/procurement/types";
import {
  buildEquipmentRows,
  buildMaterialRows,
  filterSuppliers,
  supplierEquipment,
  supplierEquipmentUsage,
  supplierMaterials,
  supplierShortageMaterialIds,
  supplierUsage,
  usageText,
} from "@/lib/procurement/view";

export default function SuppliersPage() {
  return (
    <AuthGuard>
      <SuppliersInner />
    </AuthGuard>
  );
}

function SuppliersInner() {
  const { user } = useSupabase();
  const router = useRouter();
  const [data, setData] = useState<ProcurementData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ supplier: Supplier | null } | null>(null);
  const [archiving, setArchiving] = useState<Supplier | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchProcurement());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load suppliers.");
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  const rows = useMemo(() => (data ? buildMaterialRows(data) : []), [data]);
  const eqRows = useMemo(() => (data ? buildEquipmentRows(data) : []), [data]);
  const usage = useMemo(
    () => ({ materials: data ? supplierUsage(data) : new Map<string, number>(), equipment: data ? supplierEquipmentUsage(data) : new Map<string, number>() }),
    [data],
  );
  const list = useMemo(() => (data ? filterSuppliers(data.suppliers, search, showArchived) : []), [data, search, showArchived]);
  const affected = useMemo(() => (archiving ? supplierMaterials(rows, archiving.id) : []), [rows, archiving]);
  const affectedEquipment = useMemo(() => (archiving ? supplierEquipment(eqRows, archiving.id) : []), [eqRows, archiving]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const archive = async () => {
    if (!archiving) return;
    setBusy(true);
    setArchiveError(null);
    try {
      await archiveSupplierApi(archiving.id);
      setArchiving(null);
      await load();
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : "Could not archive the supplier.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div>
        <BackToProcurementLink />
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-black">Suppliers</h1>
            <p className="text-sm text-black">Shared supplier details: website, contact, payment and the address used on Purchase Orders.</p>
          </div>
          <button type="button" className={btnPrimary} onClick={() => setEditor({ supplier: null })}>
            + Add supplier
          </button>
        </div>
      </div>

      {loadError && (
        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
          {loadError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search suppliers"
          aria-label="Search suppliers"
          className="w-64 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-600 shadow-sm"
        />
        <label className="flex items-center gap-1.5 text-xs text-black">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {!data && !loadError ? (
        <p className="text-xs text-black">Loading…</p>
      ) : list.length === 0 ? (
        <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-black">{data?.suppliers.length ? "No suppliers match." : "No suppliers yet. Add the first one here or from an ingredient on the Procurement page."}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full border-collapse text-left text-xs text-black" data-testid="suppliers-table">
            <thead className="bg-zinc-50 text-[11px] text-black">
              <tr>
                <th className="w-6 px-2 py-2" aria-label="Expand" />
                <th className="px-2 py-2 font-semibold">Supplier</th>
                <th className="px-2 py-2 font-semibold">Website</th>
                <th className="px-2 py-2 font-semibold">Contact</th>
                <th className="px-2 py-2 font-semibold">Payment</th>
                <th className="px-2 py-2 font-semibold">Used for</th>
                <th className="px-2 py-2 font-semibold">Updated</th>
                <th className="px-2 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const open = expanded.has(s.id);
                const n = usage.materials.get(s.id) ?? 0;
                const m = usage.equipment.get(s.id) ?? 0;
                const materials = open ? supplierMaterials(rows, s.id) : [];
                const equipment = open ? supplierEquipment(eqRows, s.id) : [];
                return (
                  <Fragment key={s.id}>
                    <tr className="border-t border-zinc-100 align-top" data-testid="supplier-row">
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => toggle(s.id)} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ingredients for ${s.name}`}>
                          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                        </button>
                      </td>
                      <td className="px-2 py-2 font-medium">
                        {s.name}
                        {s.archived_at && <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-black">Archived</span>}
                      </td>
                      <td className="px-2 py-2">{s.website_url ? <ExternalLink href={s.website_url}>Website</ExternalLink> : "—"}</td>
                      <td className="px-2 py-2">
                        {s.contact_name && <div>{s.contact_name}</div>}
                        {s.contact_email && (
                          <a className={linkBtn} href={`mailto:${s.contact_email}`}>
                            {s.contact_email}
                          </a>
                        )}
                        {s.contact_phone && (
                          <div>
                            <a className={linkBtn} href={`tel:${s.contact_phone.replace(/[^\d+]/g, "")}`}>
                              {s.contact_phone}
                            </a>
                          </div>
                        )}
                        {!s.contact_name && !s.contact_email && !s.contact_phone && "—"}
                      </td>
                      <td className="px-2 py-2">
                        <PaymentChips methods={s.payment_methods} />
                      </td>
                      <td className="px-2 py-2" data-testid="supplier-usage">
                        {usageText(n, m)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        {formatNyDate(s.updated_at)}
                        {s.updated_by_name && <div className="text-[11px]">by {s.updated_by_name}</div>}
                      </td>
                      <td className="px-2 py-2">
                        {!s.archived_at && (
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              className={btn}
                              onClick={() => router.push(newPoHref(s.id, supplierShortageMaterialIds(rows, s.id)))}
                              data-testid="supplier-create-po"
                              title="Start a Purchase Order with this supplier and its short ingredients"
                            >
                              Create PO
                            </button>
                            <button type="button" className={btn} onClick={() => setEditor({ supplier: s })}>
                              Edit
                            </button>
                            <button
                              type="button"
                              className={btnDanger}
                              onClick={() => {
                                setArchiveError(null);
                                setArchiving(s);
                              }}
                            >
                              Archive
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={8} className="bg-zinc-50 px-4 py-3">
                          {materials.length === 0 && equipment.length === 0 ? (
                            <p className="text-xs text-black">{s.archived_at ? "Archived suppliers supply nothing." : "Not listed for any ingredient or equipment item yet."}</p>
                          ) : (
                            <div className="space-y-3">
                              {materials.length > 0 && (
                                <table className="min-w-full text-left text-xs text-black" data-testid="supplier-ingredients">
                                  <thead className="text-[11px]">
                                    <tr>
                                      <th className="px-2 py-1 font-semibold">Ingredient</th>
                                      <th className="px-2 py-1 font-semibold">Stock alert</th>
                                      <th className="px-2 py-1 font-semibold">Price</th>
                                      <th className="px-2 py-1 font-semibold">Product link</th>
                                      <th className="px-2 py-1 font-semibold">Preferred</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {materials.map(({ row, link }) => (
                                      <tr key={row.material.id} className="border-t border-zinc-100">
                                        <td className="px-2 py-1">
                                          <Link className={linkBtn} href={procurementHref("raw", { material: row.material.id })}>
                                            {row.name}
                                          </Link>
                                        </td>
                                        <td className="px-2 py-1">
                                          <StockBadge alert={row.alert} />
                                        </td>
                                        <td className="px-2 py-1">
                                          <PriceText listing={link} />
                                        </td>
                                        <td className="px-2 py-1">{link.product_url ? <ExternalLink href={link.product_url}>Product page</ExternalLink> : "No product link"}</td>
                                        <td className="px-2 py-1">{link.is_preferred ? "★ Preferred" : "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              {equipment.length > 0 && (
                                <table className="min-w-full text-left text-xs text-black" data-testid="supplier-equipment">
                                  <thead className="text-[11px]">
                                    <tr>
                                      <th className="px-2 py-1 font-semibold">Equipment</th>
                                      <th className="px-2 py-1 font-semibold">Category</th>
                                      <th className="px-2 py-1 font-semibold">Price</th>
                                      <th className="px-2 py-1 font-semibold">Product link</th>
                                      <th className="px-2 py-1 font-semibold">Preferred</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {equipment.map(({ row, link }) => (
                                      <tr key={row.item.id} className="border-t border-zinc-100">
                                        <td className="px-2 py-1">
                                          <Link className={linkBtn} href={procurementHref("equipment", { equipment: row.item.id })}>
                                            {row.name}
                                          </Link>
                                        </td>
                                        <td className="px-2 py-1">{row.category?.name ?? "—"}</td>
                                        <td className="px-2 py-1">
                                          <PriceText listing={link} />
                                        </td>
                                        <td className="px-2 py-1">{link.product_url ? <ExternalLink href={link.product_url}>Product page</ExternalLink> : "No product link"}</td>
                                        <td className="px-2 py-1">{link.is_preferred ? "★ Preferred" : "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
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

      {editor && (
        <SupplierEditorModal
          supplier={editor.supplier}
          usage={usage}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await load();
          }}
        />
      )}
      {archiving && (
        <ConfirmDialog title={`Archive ${archiving.name}?`} confirmLabel="Archive supplier" busy={busy} error={archiveError} onConfirm={archive} onClose={() => setArchiving(null)}>
          <p data-testid="archive-counts">
            This archives its {affected.length} raw material {affected.length === 1 ? "listing" : "listings"} and {affectedEquipment.length} equipment{" "}
            {affectedEquipment.length === 1 ? "listing" : "listings"}. Nothing is deleted, and no other supplier becomes preferred automatically.
          </p>
          {(affected.length > 0 || affectedEquipment.length > 0) && (
            <ul className="list-disc pl-5">
              {affected.map(({ row, link }) => (
                <li key={row.material.id}>
                  {row.name}
                  {link.is_preferred && " (preferred)"}
                </li>
              ))}
              {affectedEquipment.map(({ row, link }) => (
                <li key={row.item.id}>
                  {row.name} (equipment{link.is_preferred ? ", preferred" : ""})
                </li>
              ))}
            </ul>
          )}
          <p>Saved Purchase Orders are not changed.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
