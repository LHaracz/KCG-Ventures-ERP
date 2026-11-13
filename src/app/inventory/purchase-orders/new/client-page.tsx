"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { PurchaseOrderForm } from "@/components/PurchaseOrderForm";
import { fetchPurchaseOrderWithLines, type PurchaseOrderWithLines } from "@/lib/purchaseOrders";
import { BackToProcurementLink, SupplierInfoBox } from "@/components/procurement/ProcurementUi";
import { fetchEquipmentPoPrefill, fetchPoPrefill } from "@/lib/procurement/client";
import type { PoPrefillResult } from "@/lib/procurement/service";

export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
      <NewPurchaseOrderPageInner />
    </Suspense>
  );
}

function NewPurchaseOrderPageInner() {
  const { user, supabase } = useSupabase();
  const searchParams = useSearchParams();
  const duplicateFromId = searchParams.get("duplicateFrom");
  // From Procurement: only ids are in the URL; the server builds the prefill.
  const procurementSupplierId = duplicateFromId ? null : searchParams.get("supplier");
  const procurementMaterialIds = (searchParams.get("materials") ?? "").split(",").filter(Boolean);
  // Equipment: one supplier and one equipment item.
  const procurementEquipmentId = searchParams.get("equipment");
  const procurementKey = procurementSupplierId
    ? `${procurementSupplierId}|${procurementEquipmentId ? `eq:${procurementEquipmentId}` : procurementMaterialIds.join(",")}`
    : null;
  const backTab = procurementEquipmentId || searchParams.get("tab") === "equipment" ? "equipment" : null;
  const [procurement, setProcurement] = useState<PoPrefillResult | null>(null);
  const [loadingProcurement, setLoadingProcurement] = useState(!!procurementSupplierId);
  const [procurementError, setProcurementError] = useState<string | null>(null);

  const [duplicateFromPo, setDuplicateFromPo] = useState<PurchaseOrderWithLines | null>(null);
  const [loadingDuplicateSource, setLoadingDuplicateSource] = useState(!!duplicateFromId);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !duplicateFromId) {
      setLoadingDuplicateSource(false);
      return;
    }
    (async () => {
      try {
        const po = await fetchPurchaseOrderWithLines(supabase, duplicateFromId);
        setDuplicateFromPo(po);
        if (!po) setDuplicateError("The purchase order you're duplicating from wasn't found. Starting a blank PO instead.");
      } catch (err: any) {
        setDuplicateError(err.message || "Failed to load the purchase order to duplicate. Starting a blank PO instead.");
      } finally {
        setLoadingDuplicateSource(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, duplicateFromId]);

  useEffect(() => {
    if (!user || !procurementKey) return;
    const [supplierId, ids] = procurementKey.split("|");
    (async () => {
      try {
        setProcurement(
          ids.startsWith("eq:") ? await fetchEquipmentPoPrefill(supplierId, ids.slice(3)) : await fetchPoPrefill(supplierId, ids ? ids.split(",") : []),
        );
      } catch (err) {
        setProcurementError(`${err instanceof Error ? err.message : "Could not load the supplier."} Starting a blank PO instead.`);
      } finally {
        setLoadingProcurement(false);
      }
    })();
  }, [user, procurementKey]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <div className="mb-1 flex flex-wrap gap-3">
            <BackToProcurementLink tab={procurement?.tab ?? backTab} className="inline-block text-[11px] font-medium text-emerald-700 underline" />
            <Link href="/inventory/purchase-orders" className="inline-block text-[11px] font-medium text-emerald-700 underline">
              ← Back to Purchase Orders
            </Link>
          </div>
          <h1 className="text-2xl font-semibold text-zinc-900">
            {duplicateFromPo ? `Duplicate ${duplicateFromPo.po_number}` : "New Purchase Order"}
          </h1>
          {duplicateFromPo && <p className="text-sm text-black">Review the details below — nothing is saved until you create it.</p>}
        </div>
        {duplicateError && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" role="alert">
            {duplicateError}
          </p>
        )}
        {procurementError && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" role="alert">
            {procurementError}
          </p>
        )}
        {procurement && (
          <>
            {procurement.prefill.warnings.map((w) => (
              <p key={w} className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-black" role="alert">
                {w}
              </p>
            ))}
            <SupplierInfoBox info={procurement.supplierInfo} />
            <p className="text-sm text-black">Review the details below. Nothing is saved, and no PO number is used, until you create it. {procurement.tab === "equipment" ? "The unit price comes from the listing when one is saved; check it before saving." : "Fill in the unit prices before saving."}</p>
          </>
        )}
        {loadingDuplicateSource || loadingProcurement ? (
          <p className="text-xs text-black">Loading…</p>
        ) : (
          <PurchaseOrderForm mode="create" duplicateFromPo={duplicateFromPo} prefill={procurement?.prefill ?? null} />
        )}
      </div>
    </AuthGuard>
  );
}
