"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { LineSheetBuilder } from "@/components/retail/LineSheetBuilder";
import { BackToRetail, errorBox } from "@/components/retail/RetailUi";
import { fetchLineSheet, fetchLineSheets } from "@/lib/retail/lineSheetClient";
import type { LineSheetBuilderData } from "@/lib/retail/lineSheetService";
import type { LineSheetWithLines } from "@/lib/retail/lineSheets";

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
  const params = useParams<{ id?: string }>();
  const id = params.id ?? null;
  const [data, setData] = useState<LineSheetBuilderData | null>(null);
  const [sheet, setSheet] = useState<LineSheetWithLines | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void Promise.all([fetchLineSheets(), id ? fetchLineSheet(id) : Promise.resolve(null)])
      .then(([list, one]) => {
        if (cancelled) return;
        setData(list.builder);
        setSheet(one?.sheet ?? null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [user, id]);
  return (
    <div className="mx-auto max-w-5xl space-y-4 text-black">
      <BackToRetail tab="line-sheets" />
      <h1 className="text-2xl font-semibold text-black">Edit line sheet</h1>
      {error && <p className={errorBox} role="alert">{error}</p>}
      {!data && !error && <p className="text-xs">Loading…</p>}
      {data && sheet?.deleted_at && <p className={errorBox}>This line sheet is deleted. Restore it from the Line sheets tab to edit it.</p>}
      {data && (!id || sheet) && !sheet?.deleted_at && <LineSheetBuilder data={data} sheet={sheet} />}
    </div>
  );
}
