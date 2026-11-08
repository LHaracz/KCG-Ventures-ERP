"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { PurchaseOrderForm } from "@/components/PurchaseOrderForm";
import { fetchPurchaseOrderWithLines, type PurchaseOrderWithLines } from "@/lib/purchaseOrders";

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

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <Link href="/inventory/purchase-orders" className="mb-1 inline-block text-[11px] font-medium text-emerald-700 underline">
            ← Back to Purchase Orders
          </Link>
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
        {loadingDuplicateSource ? <p className="text-xs text-black">Loading…</p> : <PurchaseOrderForm mode="create" duplicateFromPo={duplicateFromPo} />}
      </div>
    </AuthGuard>
  );
}
