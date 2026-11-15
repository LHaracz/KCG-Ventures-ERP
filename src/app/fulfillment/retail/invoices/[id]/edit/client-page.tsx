"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { InvoiceForm } from "@/components/retail/InvoiceForm";
import { BackToRetail, errorBox, linkBtn } from "@/components/retail/RetailUi";
import { fetchInvoice, fetchRetail } from "@/lib/retail/client";
import type { RetailBootstrap } from "@/lib/retail/service";
import type { InvoiceWithLines } from "@/lib/retail/types";

export default function EditInvoicePage() {
  return (
    <AuthGuard>
      <EditInvoiceInner />
    </AuthGuard>
  );
}

function EditInvoiceInner() {
  const { user } = useSupabase();
  const { id } = useParams<{ id: string }>();
  const [boot, setBoot] = useState<RetailBootstrap | null>(null);
  const [invoice, setInvoice] = useState<InvoiceWithLines | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([fetchRetail(), fetchInvoice(id)])
      .then(([b, inv]) => {
        if (cancelled) return;
        setBoot(b);
        setInvoice(inv.invoice);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [user, id]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 text-black">
      <BackToRetail tab="invoices" />
      <h1 className="text-2xl font-semibold text-black">{invoice ? `Edit ${invoice.invoice_number}` : "Edit invoice"}</h1>
      {error && (
        <p className={errorBox} role="alert">
          {error}
        </p>
      )}
      {invoice?.deleted_at ? (
        <p className={errorBox} role="alert">
          This invoice is deleted. Restore it from the Invoices tab (Show deleted) before editing.{" "}
          <Link href={`/fulfillment/retail/invoices/${invoice.id}`} className={linkBtn}>
            Back to the invoice
          </Link>
        </p>
      ) : boot && invoice ? (
        <InvoiceForm boot={boot} mode={{ kind: "edit", invoice }} />
      ) : (
        !error && <p className="text-xs text-black">Loading…</p>
      )}
    </div>
  );
}
