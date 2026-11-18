"use client";

import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { BackToRetail, Badge, btn, btnPrimary, errorBox, infoBox } from "@/components/retail/RetailUi";
import { saveBlob } from "@/lib/retail/client";
import { duplicateLineSheetApi, fetchLineSheet, lineSheetPdfBlob } from "@/lib/retail/lineSheetClient";
import { lineSheetFilename, type LineSheetWithLines } from "@/lib/retail/lineSheets";
import { formatLongDate } from "@/lib/retail/format";
import { nyDateOf } from "@/lib/growth/dates";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), { ssr: false, loading: () => <p className="p-4 text-xs text-black">Loading…</p> });

export default function Page() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <Inner />
      </Suspense>
    </AuthGuard>
  );
}

function Inner() {
  const { user } = useSupabase();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [sheet, setSheet] = useState<LineSheetWithLines | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let url: string | null = null;
    void fetchLineSheet(id)
      .then(async ({ sheet: s }) => {
        if (cancelled) return;
        setSheet(s);
        url = URL.createObjectURL(await lineSheetPdfBlob(id, true));
        if (!cancelled) setPdfUrl(url);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [user, id]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-4 text-black">
      <BackToRetail tab="line-sheets" />
      {error && <p className={errorBox} role="alert">{error}</p>}
      {sheet && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-black">{sheet.name}</h1>
              <p className="text-sm">
                {sheet.lines.length} products · Prices saved on {formatLongDate(nyDateOf(sheet.prices_saved_at))}
                {sheet.last_downloaded_at ? ` · Last downloaded ${formatLongDate(nyDateOf(sheet.last_downloaded_at))}` : ""}
              </p>
              {sheet.deleted_at && <Badge>Deleted</Badge>}
            </div>
            {!sheet.deleted_at && (
              <div className="flex flex-wrap gap-2">
                <Link href={`/fulfillment/retail/line-sheets/${sheet.id}/edit`} className={btn}>Edit</Link>
                <button type="button" className={btn} disabled={busy} onClick={() => act(async () => router.push(`/fulfillment/retail/line-sheets/${(await duplicateLineSheetApi(sheet.id)).id}/edit`))}>Duplicate</button>
                <button type="button" className={btnPrimary} disabled={busy} onClick={() => act(async () => saveBlob(await lineSheetPdfBlob(sheet.id, false), lineSheetFilename(sheet.name)))}>Download PDF</button>
              </div>
            )}
          </div>
          <p className={infoBox}>The PDF uses the prices and letterhead saved with this line sheet. Edit it and choose Refresh prices to update them.</p>
          <div className="h-[80vh] overflow-hidden rounded-md border border-zinc-200 bg-zinc-100">{pdfUrl ? <PdfViewer fileUrl={pdfUrl} /> : <p className="p-4 text-xs text-black">Loading PDF…</p>}</div>
        </>
      )}
      {!sheet && !error && <p className="text-xs">Loading…</p>}
    </div>
  );
}
