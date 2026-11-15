"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { InvoiceForm, type InvoiceFormMode } from "@/components/retail/InvoiceForm";
import { BackToRetail, errorBox } from "@/components/retail/RetailUi";
import { fetchInvoice, fetchRetail } from "@/lib/retail/client";
import type { RetailBootstrap } from "@/lib/retail/service";

export default function NewInvoicePage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <NewInvoiceInner />
      </Suspense>
    </AuthGuard>
  );
}

function NewInvoiceInner() {
  const { user } = useSupabase();
  const params = useSearchParams();
  const fromId = params.get("from");
  const retailerId = params.get("retailer");
  const [boot, setBoot] = useState<RetailBootstrap | null>(null);
  const [mode, setMode] = useState<InvoiceFormMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const [b, src] = await Promise.all([fetchRetail(), fromId ? fetchInvoice(fromId) : Promise.resolve(null)]);
        if (cancelled) return;
        setBoot(b);
        setMode(src ? { kind: "duplicate", source: src.invoice } : { kind: "new", retailerId });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, fromId, retailerId]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 text-black">
      <BackToRetail tab="invoices" />
      <div>
        <h1 className="text-2xl font-semibold text-black">{mode?.kind === "duplicate" ? `New invoice (copy of ${mode.source.invoice_number})` : "New invoice"}</h1>
        <p className="text-sm text-black">
          {mode?.kind === "duplicate"
            ? "Lines, terms, addresses and notes are copied. Enter the Shopify order number; the dates start as today."
            : "Invoices are documents only: they don't create Shopify orders or change inventory."}
        </p>
      </div>
      {error && (
        <p className={errorBox} role="alert">
          {error}
        </p>
      )}
      {!error && (!boot || !mode) && <p className="text-xs text-black">Loading…</p>}
      {boot && mode && <InvoiceForm boot={boot} mode={mode} />}
    </div>
  );
}
