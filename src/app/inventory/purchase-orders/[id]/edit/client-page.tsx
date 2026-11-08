"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { PurchaseOrderForm } from "@/components/PurchaseOrderForm";
import { fetchPurchaseOrderWithLines, type PurchaseOrderWithLines } from "@/lib/purchaseOrders";

export default function EditPurchaseOrderPage() {
  const { user, supabase } = useSupabase();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [po, setPo] = useState<PurchaseOrderWithLines | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await fetchPurchaseOrderWithLines(supabase, id);
        if (!data) {
          setLoadError("Purchase order not found.");
        } else if (data.deleted_at) {
          setLoadError("This purchase order has been deleted. Restore it before editing.");
        } else {
          setPo(data);
        }
      } catch (err: any) {
        setLoadError(err.message || "Failed to load this purchase order.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <Link href={`/inventory/purchase-orders/${id}`} className="mb-1 inline-block text-[11px] font-medium text-emerald-700 underline">
            ← Back to purchase order
          </Link>
          <h1 className="text-2xl font-semibold text-zinc-900">Edit {po ? po.po_number : "Purchase Order"}</h1>
        </div>
        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700" role="alert">
            {loadError}
          </p>
        ) : po ? (
          <PurchaseOrderForm mode="edit" poId={po.id} initialPo={po} />
        ) : null}
      </div>
    </AuthGuard>
  );
}
