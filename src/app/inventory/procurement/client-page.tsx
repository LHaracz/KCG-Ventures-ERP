"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { EquipmentTable, ProcurementTable, ProcurementTabs, btn, btnPrimary } from "@/components/procurement/ProcurementUi";
import {
  CategoriesModal,
  ConfirmDialog,
  EquipmentModal,
  LinkModal,
  ShortagesModal,
  SupplierEditorModal,
  type SupplierUsage,
} from "@/components/procurement/ProcurementForms";
import {
  archiveEquipmentLinkApi,
  archiveLinkApi,
  fetchProcurement,
  makeEquipmentPreferredApi,
  makePreferredApi,
  restoreEquipmentApi,
} from "@/lib/procurement/client";
import { newEquipmentPoHref, newPoHref } from "@/lib/procurement/poPrefill";
import { procurementHref, type ProcurementData, type ProcurementTab, type Supplier } from "@/lib/procurement/types";
import {
  buildEquipmentRows,
  buildMaterialRows,
  categoryCounts,
  equipmentSummary,
  filterEquipmentRows,
  filterRows,
  shortageGroups,
  summaryCounts,
  supplierEquipmentUsage,
  supplierUsage,
  type EquipmentLinkWithSupplier,
  type EquipmentQuick,
  type EquipmentRow,
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
  | { kind: "preferred"; row: MaterialRow; link: LinkWithSupplier }
  | { kind: "eq-remove"; row: EquipmentRow; link: EquipmentLinkWithSupplier }
  | { kind: "eq-preferred"; row: EquipmentRow; link: EquipmentLinkWithSupplier };

const pill = (on: boolean) =>
  `rounded-full px-2.5 py-1 text-xs font-medium text-black ring-1 ${on ? "bg-emerald-100 ring-emerald-500" : "bg-white ring-zinc-300 hover:bg-zinc-50"}`;
const searchBox = "w-64 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-600 shadow-sm";

function ProcurementInner() {
  const { user } = useSupabase();
  const router = useRouter();
  const params = useSearchParams();
  const tab: ProcurementTab = params.get("tab") === "equipment" ? "equipment" : "raw";
  const focusId = params.get("material");
  const focusEquipmentId = params.get("equipment");

  const [data, setData] = useState<ProcurementData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);

  // Raw Materials tab
  const [search, setSearch] = useState("");
  const [shortagesOnly, setShortagesOnly] = useState(false);
  const [missingInfo, setMissingInfo] = useState(false);
  const [missingPrice, setMissingPrice] = useState(false);
  const [quick, setQuick] = useState<QuickFilter>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusId ? [focusId] : []));
  const [linkModal, setLinkModal] = useState<{ materialId: string; linkId: string | null } | null>(null);
  const [shortagesOpen, setShortagesOpen] = useState(false);

  // Equipment tab
  const [eqSearch, setEqSearch] = useState("");
  const [eqCategory, setEqCategory] = useState<string>("");
  const [eqMissingInfo, setEqMissingInfo] = useState(false);
  const [eqMissingPrice, setEqMissingPrice] = useState(false);
  const [eqQuick, setEqQuick] = useState<EquipmentQuick>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [eqExpanded, setEqExpanded] = useState<Set<string>>(() => new Set(focusEquipmentId ? [focusEquipmentId] : []));
  const [equipmentModal, setEquipmentModal] = useState<{ itemId: string | null } | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [eqLinkModal, setEqLinkModal] = useState<{ equipmentId: string; linkId: string | null; justCreated?: boolean } | null>(null);

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
    if (!data) return;
    const id = tab === "equipment" ? (focusEquipmentId ? `equipment-${focusEquipmentId}` : null) : focusId ? `material-${focusId}` : null;
    if (id) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [data, focusId, focusEquipmentId, tab]);

  const rows = useMemo(() => (data ? buildMaterialRows(data) : []), [data]);
  const usage: SupplierUsage = useMemo(
    () => ({ materials: data ? supplierUsage(data) : new Map(), equipment: data ? supplierEquipmentUsage(data) : new Map() }),
    [data],
  );
  const counts = useMemo(() => summaryCounts(rows), [rows]);
  const rawMissingPrice = useMemo(() => rows.filter((r) => r.missingPrice).length, [rows]);
  const visible = useMemo(
    () => filterRows(rows, { search, shortagesOnly, missingInfo, missingPrice, quick }),
    [rows, search, shortagesOnly, missingInfo, missingPrice, quick],
  );
  const shortages = useMemo(() => shortageGroups(rows), [rows]);

  const eqRows = useMemo(() => (data ? buildEquipmentRows(data, { includeArchived: showArchived }) : []), [data, showArchived]);
  const eqCounts = useMemo(() => equipmentSummary(eqRows), [eqRows]);
  const cats = useMemo(() => (data ? categoryCounts(data) : []), [data]);
  const eqVisible = useMemo(
    () => filterEquipmentRows(eqRows, { search: eqSearch, categoryId: eqCategory || null, missingInfo: eqMissingInfo, missingPrice: eqMissingPrice, quick: eqQuick }),
    [eqRows, eqSearch, eqCategory, eqMissingInfo, eqMissingPrice, eqQuick],
  );

  const modalRow = linkModal ? rows.find((r) => r.material.id === linkModal.materialId) ?? null : null;
  const modalLink = modalRow && linkModal?.linkId ? modalRow.links.find((l) => l.id === linkModal.linkId) ?? null : null;
  const eqModalRow = eqLinkModal ? eqRows.find((r) => r.item.id === eqLinkModal.equipmentId) ?? null : null;
  const eqModalLink = eqModalRow && eqLinkModal?.linkId ? eqModalRow.links.find((l) => l.id === eqLinkModal.linkId) ?? null : null;
  const editingItem = equipmentModal?.itemId ? data?.equipment.find((e) => e.id === equipmentModal.itemId) ?? null : null;

  const setTab = (t: ProcurementTab) => router.replace(procurementHref(t));
  const toggleIn = (set: (f: (prev: Set<string>) => Set<string>) => void) => (id: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    setActionError(null);
    try {
      if (confirm.kind === "remove") await archiveLinkApi(confirm.link.id);
      else if (confirm.kind === "preferred") await makePreferredApi(confirm.link.id);
      else if (confirm.kind === "eq-remove") await archiveEquipmentLinkApi(confirm.link.id);
      else await makeEquipmentPreferredApi(confirm.link.id);
      setConfirm(null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">Procurement</h1>
          <p className="text-sm text-black">Where and how to buy raw materials and equipment, and Purchase Orders.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={tab === "equipment" ? "/inventory/purchase-orders?tab=equipment" : "/inventory/purchase-orders"} className={btn}>
            Purchase Orders
          </Link>
          <Link href={tab === "equipment" ? "/inventory/procurement/suppliers?tab=equipment" : "/inventory/procurement/suppliers"} className={btn}>
            Suppliers
          </Link>
        </div>
      </div>

      <ProcurementTabs tab={tab} onChange={setTab} />

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
      ) : data && tab === "raw" ? (
        <div className="space-y-4" role="tabpanel" aria-label="Raw Materials">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2" aria-label="Summary">
              <button type="button" className={pill(quick === "out")} aria-pressed={quick === "out"} onClick={() => setQuick((q) => (q === "out" ? null : "out"))} data-testid="count-out">
                {counts.out} out of stock
              </button>
              <button type="button" className={pill(quick === "below")} aria-pressed={quick === "below"} onClick={() => setQuick((q) => (q === "below" ? null : "below"))} data-testid="count-below">
                {counts.below} below par
              </button>
              <button
                type="button"
                className={pill(quick === "no_supplier")}
                aria-pressed={quick === "no_supplier"}
                onClick={() => setQuick((q) => (q === "no_supplier" ? null : "no_supplier"))}
                data-testid="count-no_supplier"
              >
                {counts.noSupplier} {counts.noSupplier === 1 ? "ingredient with no supplier" : "ingredients with no supplier"}
              </button>
              {quick && (
                <button type="button" className="text-xs font-medium text-black underline" onClick={() => setQuick(null)}>
                  Show all
                </button>
              )}
            </div>
            <button type="button" className={btnPrimary} onClick={() => setShortagesOpen(true)}>
              Create PO for shortages
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search material or supplier" aria-label="Search material or supplier" className={searchBox} />
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={shortagesOnly} onChange={(e) => setShortagesOnly(e.target.checked)} />
              Shortages only
            </label>
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={missingInfo} onChange={(e) => setMissingInfo(e.target.checked)} />
              Missing supplier info
            </label>
            <label className="flex items-center gap-1.5 text-xs text-black" title="The preferred supplier listing has no price">
              <input type="checkbox" checked={missingPrice} onChange={(e) => setMissingPrice(e.target.checked)} />
              Missing price ({rawMissingPrice})
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
              onToggle: toggleIn(setExpanded),
              onAddSupplier: (row) => setLinkModal({ materialId: row.material.id, linkId: null }),
              onEditLink: (row, link) => setLinkModal({ materialId: row.material.id, linkId: link.id }),
              onEditSupplier: setEditSupplier,
              onRemoveLink: (row, link) => {
                setActionError(null);
                setConfirm({ kind: "remove", row, link });
              },
              onMakePreferred: (row, link) =>
                row.preferred && row.preferred.id !== link.id ? setConfirm({ kind: "preferred", row, link }) : void act(() => makePreferredApi(link.id)),
              onCreatePo: (supplierId, ids) => router.push(newPoHref(supplierId, ids)),
            }}
          />
        </div>
      ) : data ? (
        <div className="space-y-4" role="tabpanel" aria-label="Equipment">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2" aria-label="Summary">
              <button
                type="button"
                className={pill(eqQuick === "no_supplier")}
                aria-pressed={eqQuick === "no_supplier"}
                onClick={() => setEqQuick((q) => (q === "no_supplier" ? null : "no_supplier"))}
                data-testid="eq-count-no_supplier"
              >
                {eqCounts.noSupplier} no supplier yet
              </button>
              <button
                type="button"
                className={pill(eqQuick === "missing_price")}
                aria-pressed={eqQuick === "missing_price"}
                onClick={() => setEqQuick((q) => (q === "missing_price" ? null : "missing_price"))}
                data-testid="eq-count-missing_price"
              >
                {eqCounts.missingPrice} missing price
              </button>
              {eqQuick && (
                <button type="button" className="text-xs font-medium text-black underline" onClick={() => setEqQuick(null)}>
                  Show all
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => setCategoriesOpen(true)}>
                Manage categories
              </button>
              <button type="button" className={btnPrimary} onClick={() => setEquipmentModal({ itemId: null })}>
                Add equipment
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input type="search" value={eqSearch} onChange={(e) => setEqSearch(e.target.value)} placeholder="Search equipment or supplier" aria-label="Search equipment or supplier" className={searchBox} />
            <select
              value={eqCategory}
              onChange={(e) => setEqCategory(e.target.value)}
              aria-label="Category"
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm"
            >
              <option value="">All categories ({eqRows.filter((r) => !r.archived).length})</option>
              {cats.map(({ category, count }) => (
                <option key={category.id} value={category.id}>
                  {category.name} ({count})
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={eqMissingInfo} onChange={(e) => setEqMissingInfo(e.target.checked)} />
              Missing supplier info
            </label>
            <label className="flex items-center gap-1.5 text-xs text-black" title="The preferred supplier listing has no price">
              <input type="checkbox" checked={eqMissingPrice} onChange={(e) => setEqMissingPrice(e.target.checked)} />
              Missing price
            </label>
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived
            </label>
            <span className="text-xs text-black">
              Showing {eqVisible.length} of {eqRows.length}
            </span>
          </div>
          <EquipmentTable
            rows={eqVisible}
            expanded={eqExpanded}
            highlightId={focusEquipmentId}
            handlers={{
              onToggle: toggleIn(setEqExpanded),
              onEditItem: (row) => !row.archived && setEquipmentModal({ itemId: row.item.id }),
              onRestore: (row) => void act(() => restoreEquipmentApi(row.item.id)),
              onAddSupplier: (row) => setEqLinkModal({ equipmentId: row.item.id, linkId: null }),
              onEditLink: (row, link) => setEqLinkModal({ equipmentId: row.item.id, linkId: link.id }),
              onEditSupplier: setEditSupplier,
              onRemoveLink: (row, link) => {
                setActionError(null);
                setConfirm({ kind: "eq-remove", row, link });
              },
              onMakePreferred: (row, link) =>
                row.preferred && row.preferred.id !== link.id
                  ? setConfirm({ kind: "eq-preferred", row, link })
                  : void act(() => makeEquipmentPreferredApi(link.id)),
              onCreatePo: (supplierId, equipmentId) => router.push(newEquipmentPoHref(supplierId, equipmentId)),
            }}
          />
        </div>
      ) : null}

      {linkModal && modalRow && data && (
        <LinkModal
          key={`raw:${linkModal.materialId}:${linkModal.linkId ?? "new"}`}
          kind="raw"
          target={{ id: modalRow.material.id, name: modalRow.name, takenSupplierIds: modalRow.links.map((l) => l.supplier_id), hasListings: modalRow.links.length > 0 }}
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
      {eqLinkModal && eqModalRow && data && (
        <LinkModal
          key={`eq:${eqLinkModal.equipmentId}:${eqLinkModal.linkId ?? "new"}`}
          kind="equipment"
          target={{ id: eqModalRow.item.id, name: eqModalRow.name, takenSupplierIds: eqModalRow.links.map((l) => l.supplier_id), hasListings: eqModalRow.links.length > 0 }}
          link={eqModalLink}
          suppliers={data.suppliers}
          usage={usage}
          cancelLabel={eqLinkModal.justCreated ? "Skip for now" : "Cancel"}
          onClose={() => setEqLinkModal(null)}
          onSaved={async () => {
            setEqLinkModal(null);
            setEqExpanded((prev) => new Set(prev).add(eqModalRow.item.id));
            await load();
          }}
        />
      )}
      {equipmentModal && data && (
        <EquipmentModal
          key={equipmentModal.itemId ?? "new"}
          item={editingItem}
          categories={cats.map((c) => c.category)}
          onClose={() => setEquipmentModal(null)}
          onArchived={async () => {
            setEquipmentModal(null);
            await load();
          }}
          onSaved={async (item, created) => {
            setEquipmentModal(null);
            await load();
            if (created) setEqLinkModal({ equipmentId: item.id, linkId: null, justCreated: true });
          }}
        />
      )}
      {categoriesOpen && <CategoriesModal categories={cats} onClose={() => setCategoriesOpen(false)} onChanged={load} />}
      {editSupplier && (
        <SupplierEditorModal
          supplier={editSupplier}
          usage={usage}
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
          onCreatePo={(supplierId, ids) => router.push(newPoHref(supplierId, ids))}
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
          title={confirm.kind === "remove" || confirm.kind === "eq-remove" ? `Remove ${confirm.link.supplier.name}?` : "Change the preferred supplier?"}
          confirmLabel={confirm.kind === "remove" || confirm.kind === "eq-remove" ? "Remove" : "Make preferred"}
          busy={busy}
          error={actionError}
          onConfirm={runConfirm}
          onClose={() => setConfirm(null)}
        >
          {confirm.kind === "remove" || confirm.kind === "eq-remove" ? (
            <p>
              {confirm.link.supplier.name} will no longer be listed for {confirm.row.name}. The listing is archived, not deleted.
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
