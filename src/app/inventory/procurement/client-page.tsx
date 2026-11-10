"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { ProcurementTable, btn, btnPrimary } from "@/components/procurement/ProcurementUi";
import { ConfirmDialog, LinkModal, ShortagesModal, SupplierEditorModal } from "@/components/procurement/ProcurementForms";
import { archiveLinkApi, fetchProcurement, makePreferredApi } from "@/lib/procurement/client";
import { newPoHref } from "@/lib/procurement/poPrefill";
import type { ProcurementData, Supplier } from "@/lib/procurement/types";
import {
  buildMaterialRows,
  filterRows,
  shortageGroups,
  summaryCounts,
  supplierUsage,
  type LinkWithSupplier,
  type MaterialRow,
  type QuickFilter,
} from "@/lib/procurement/view";

export default function ProcurementPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <ProcurementInner />
      </Suspense>
    </AuthGuard>
  );
}

type Confirm =
  | { kind: "remove"; row: MaterialRow; link: LinkWithSupplier }
  | { kind: "preferred"; row: MaterialRow; link: LinkWithSupplier };

function ProcurementInner() {
  const { user } = useSupabase();
  const router = useRouter();
  const focusId = useSearchParams().get("material");

  const [data, setData] = useState<ProcurementData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [shortagesOnly, setShortagesOnly] = useState(false);
  const [missingInfo, setMissingInfo] = useState(false);
  const [quick, setQuick] = useState<QuickFilter>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusId ? [focusId] : []));
  const [linkModal, setLinkModal] = useState<{ materialId: string; linkId: string | null } | null>(null);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [shortagesOpen, setShortagesOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchProcurement());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load Procurement.");
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  useEffect(() => {
    if (!data || !focusId) return;
    document.getElementById(`material-${focusId}`)?.scrollIntoView({ block: "center" });
  }, [data, focusId]);

  const rows = useMemo(() => (data ? buildMaterialRows(data) : []), [data]);
  const usage = useMemo(() => (data ? supplierUsage(data) : new Map<string, number>()), [data]);
  const counts = useMemo(() => summaryCounts(rows), [rows]);
  const visible = useMemo(() => filterRows(rows, { search, shortagesOnly, missingInfo, quick }), [rows, search, shortagesOnly, missingInfo, quick]);
  const shortages = useMemo(() => shortageGroups(rows), [rows]);

  const modalRow = linkModal ? rows.find((r) => r.material.id === linkModal.materialId) ?? null : null;
  const modalLink = modalRow && linkModal?.linkId ? modalRow.links.find((l) => l.id === linkModal.linkId) ?? null : null;

  const createPo = (supplierId: string, materialIds: string[]) => router.push(newPoHref(supplierId, materialIds));
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    setActionError(null);
    try {
      if (confirm.kind === "remove") await archiveLinkApi(confirm.link.id);
      else await makePreferredApi(confirm.link.id);
      setConfirm(null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const makePreferred = async (row: MaterialRow, link: LinkWithSupplier) => {
    setActionError(null);
    if (row.preferred && row.preferred.id !== link.id) {
      setConfirm({ kind: "preferred", row, link });
      return;
    }
    try {
      await makePreferredApi(link.id);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not change the preferred supplier.");
    }
  };

  const quickButton = (key: Exclude<QuickFilter, null>, n: number, text: string) => (
    <button
      type="button"
      onClick={() => setQuick((q) => (q === key ? null : key))}
      aria-pressed={quick === key}
      className={`rounded-full px-2.5 py-1 text-xs font-medium text-black ring-1 ${quick === key ? "bg-emerald-100 ring-emerald-500" : "bg-white ring-zinc-300 hover:bg-zinc-50"}`}
      data-testid={`count-${key}`}
    >
      {n} {text}
    </button>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">Procurement</h1>
          <p className="text-sm text-black">Stock against par, shortages first, and where and how to buy each raw material.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/inventory/purchase-orders" className={btn}>
            Purchase Orders
          </Link>
          <Link href="/inventory/procurement/suppliers" className={btn}>
            Suppliers
          </Link>
          <button type="button" className={btnPrimary} onClick={() => setShortagesOpen(true)} disabled={!data}>
            Create PO for shortages
          </button>
        </div>
      </div>

      {loadError && (
        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
          {loadError}
        </p>
      )}
      {actionError && !confirm && (
        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
          {actionError}
        </p>
      )}

      {!data && !loadError ? (
        <p className="text-xs text-black">Loading…</p>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-center gap-2" aria-label="Summary">
            {quickButton("out", counts.out, "out of stock")}
            {quickButton("below", counts.below, "below par")}
            {quickButton("no_supplier", counts.noSupplier, counts.noSupplier === 1 ? "ingredient with no supplier" : "ingredients with no supplier")}
            {quick && (
              <button type="button" className="text-xs font-medium text-black underline" onClick={() => setQuick(null)}>
                Show all
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search material or supplier"
              aria-label="Search material or supplier"
              className="w-64 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-600 shadow-sm"
            />
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={shortagesOnly} onChange={(e) => setShortagesOnly(e.target.checked)} />
              Shortages only
            </label>
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={missingInfo} onChange={(e) => setMissingInfo(e.target.checked)} />
              Missing supplier info
            </label>
            <span className="text-xs text-black">
              Showing {visible.length} of {rows.length}
            </span>
          </div>
          <ProcurementTable
            rows={visible}
            expanded={expanded}
            highlightId={focusId}
            handlers={{
              onToggle: toggle,
              onAddSupplier: (row) => setLinkModal({ materialId: row.material.id, linkId: null }),
              onEditLink: (row, link) => setLinkModal({ materialId: row.material.id, linkId: link.id }),
              onEditSupplier: (s) => setEditSupplier(s),
              onRemoveLink: (row, link) => {
                setActionError(null);
                setConfirm({ kind: "remove", row, link });
              },
              onMakePreferred: makePreferred,
              onCreatePo: createPo,
            }}
          />
        </>
      ) : null}

      {linkModal && modalRow && data && (
        <LinkModal
          key={`${linkModal.materialId}:${linkModal.linkId ?? "new"}`}
          row={modalRow}
          link={modalLink}
          suppliers={data.suppliers}
          usage={usage}
          onClose={() => setLinkModal(null)}
          onSaved={async () => {
            setLinkModal(null);
            setExpanded((prev) => new Set(prev).add(modalRow.material.id));
            await load();
          }}
        />
      )}
      {editSupplier && (
        <SupplierEditorModal
          supplier={editSupplier}
          usedFor={usage.get(editSupplier.id) ?? 0}
          onClose={() => setEditSupplier(null)}
          onSaved={async () => {
            setEditSupplier(null);
            await load();
          }}
        />
      )}
      {shortagesOpen && (
        <ShortagesModal
          groups={shortages.groups}
          noSupplier={shortages.noSupplier}
          onCreatePo={createPo}
          onAddSupplier={(row) => {
            setShortagesOpen(false);
            setExpanded((prev) => new Set(prev).add(row.material.id));
            if (row.links.length === 0) setLinkModal({ materialId: row.material.id, linkId: null });
            else document.getElementById(`material-${row.material.id}`)?.scrollIntoView({ block: "center" });
          }}
          onClose={() => setShortagesOpen(false)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "remove" ? `Remove ${confirm.link.supplier.name}?` : "Change the preferred supplier?"}
          confirmLabel={confirm.kind === "remove" ? "Remove" : "Make preferred"}
          busy={busy}
          error={actionError}
          onConfirm={runConfirm}
          onClose={() => setConfirm(null)}
        >
          {confirm.kind === "remove" ? (
            <p>
              {confirm.link.supplier.name} will no longer be listed for {confirm.row.name}. The link is archived, not deleted.
              {confirm.link.is_preferred && " No other supplier becomes preferred automatically."}
            </p>
          ) : (
            <p>
              {confirm.row.preferred?.supplier.name} is the preferred supplier for {confirm.row.name}. Make {confirm.link.supplier.name} preferred instead?
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
