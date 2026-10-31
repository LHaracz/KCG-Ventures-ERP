"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { SopRenderProvider } from "@/components/sop/SopRenderContext";
import { SopDocumentRenderer } from "@/components/sop/SopDocumentRenderer";
import type { DocNode } from "@/lib/sopDocument";
import type { FormulaSnapshot } from "@/lib/sopFormulaData";
import "@/components/sop/sopDocument.css";

// pdfjs-dist touches browser-only globals (canvas, worker), so the viewer
// is loaded client-side only — never during SSR.
const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => <p className="pt-8 text-center text-xs text-black">Loading viewer…</p>,
});

type SopDetail = {
  id: string;
  title: string;
  sop_number: string | null;
  description: string | null;
  format: "pdf" | "document";
  product_id: string | null;
  has_draft: boolean;
};

type VersionRow = {
  id: string;
  version_number: number;
  original_filename: string | null;
  effective_date: string | null;
  change_note: string | null;
  is_current: boolean;
  uploaded_at: string;
  uploaded_by: string | null;
  source: "upload" | "editor" | "auto_formula_update" | "migration";
  published_by_name: string | null;
  has_file: boolean;
};

const SOURCE_LABEL: Record<VersionRow["source"], string> = {
  upload: "PDF upload",
  editor: "Editor",
  auto_formula_update: "Automatic formula update",
  migration: "Converted from PDF",
};

function dateTimeNY(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function todayNYLabel(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
}

export default function SopViewerPage() {
  const params = useParams<{ id: string }>();
  const sopId = params.id;
  const { user, supabase } = useSupabase();

  const [sop, setSop] = useState<SopDetail | null>(null);
  const [productName, setProductName] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [uploaderEmails, setUploaderEmails] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<{ versionId: string; content: DocNode; snapshot: FormulaSnapshot | null } | null>(null);

  const printFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [printing, setPrinting] = useState(false);

  const getToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    return token;
  }, [supabase]);

  const authedFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getToken();
      const response = await fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      return payload;
    },
    [getToken],
  );

  const load = useCallback(
    async (keepSelection = false) => {
      if (!sopId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const sopResult = await supabase
          .from("sops")
          .select("id, title, sop_number, description, format, product_id, draft_content")
          .eq("id", sopId)
          .maybeSingle();
        if (sopResult.error) throw new Error(sopResult.error.message);
        if (!sopResult.data) throw new Error("SOP not found.");
        const row = sopResult.data as any;

        // Catch any missed automatic formula updates before showing versions.
        if (row.format === "document") {
          try {
            await authedFetch("/api/compliance/sops/reconcile", { method: "POST", body: JSON.stringify({ sopIds: [sopId] }) });
          } catch {
            // Non-blocking: the page still shows what is published.
          }
        }

        const versionsPayload = await authedFetch(`/api/compliance/sops/${sopId}/versions`);
        setSop({
          id: row.id,
          title: row.title,
          sop_number: row.sop_number,
          description: row.description,
          format: row.format ?? "pdf",
          product_id: row.product_id ?? null,
          has_draft: !!row.draft_content,
        });
        if (row.product_id) {
          const { data: p } = await supabase.from("products").select("name").eq("id", row.product_id).maybeSingle();
          setProductName(p?.name ?? null);
        } else setProductName(null);

        const versionRows = ((versionsPayload.versions ?? []) as VersionRow[]).sort(
          (a, b) => Number(b.is_current) - Number(a.is_current) || b.version_number - a.version_number,
        );
        setVersions(versionRows);
        setUploaderEmails(new Map(Object.entries(versionsPayload.uploaderEmails ?? {})));
        if (!keepSelection) setSelectedVersionId((versionRows.find((v) => v.is_current) ?? versionRows[0])?.id ?? null);
      } catch (err: any) {
        setLoadError(err.message || "Failed to load this SOP.");
      } finally {
        setLoading(false);
      }
    },
    [sopId, supabase, authedFetch],
  );

  useEffect(() => {
    if (!user || !sopId) return;
    load();
  }, [user, sopId, load]);

  const selectedVersion = useMemo(() => versions.find((v) => v.id === selectedVersionId) ?? null, [versions, selectedVersionId]);
  const currentVersion = useMemo(() => versions.find((v) => v.is_current) ?? null, [versions]);

  // PDF versions: fresh short-lived signed URL. Document versions: content + frozen snapshot.
  useEffect(() => {
    if (!selectedVersion || !sopId) return;
    let cancelled = false;
    setUrlError(null);
    setViewUrl(null);
    if (selectedVersion.has_file) {
      setUrlLoading(true);
      authedFetch(`/api/compliance/sops/${sopId}/versions/${selectedVersion.id}/signed-url`)
        .then((p) => !cancelled && setViewUrl(p.url))
        .catch((err) => !cancelled && setUrlError(err.message || "Failed to load this file."))
        .finally(() => !cancelled && setUrlLoading(false));
    } else {
      setUrlLoading(true);
      (async () => {
        const { data, error } = await supabase
          .from("sop_versions")
          .select("id, content, formula_snapshot")
          .eq("id", selectedVersion.id)
          .maybeSingle();
        if (cancelled) return;
        if (error || !data?.content) setUrlError(error?.message || "This version has no content.");
        else setDocContent({ versionId: data.id, content: data.content, snapshot: data.formula_snapshot ?? null });
        setUrlLoading(false);
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [selectedVersion, sopId, authedFetch, supabase]);

  const handleDownload = async () => {
    if (!sopId || !selectedVersion?.has_file) return;
    try {
      const payload = await authedFetch(`/api/compliance/sops/${sopId}/versions/${selectedVersion.id}/signed-url?download=1`);
      window.location.href = payload.url;
    } catch (err: any) {
      setUrlError(err.message || "Failed to download this file.");
    }
  };

  const handlePrint = async () => {
    if (!selectedVersion) return;
    if (selectedVersion.has_file) {
      if (!viewUrl || !printFrameRef.current) return;
      setPrinting(true);
      const frame = printFrameRef.current;
      frame.src = viewUrl;
      frame.onload = () => {
        try {
          frame.contentWindow?.print();
        } finally {
          setPrinting(false);
        }
      };
      return;
    }
    // Document versions print from this page with print CSS (no new tab).
    const footer = `${sop?.sop_number ? `${sop.sop_number} ` : ""}v${selectedVersion.version_number} · Printed ${todayNYLabel()} · Uncontrolled when printed. Verify the current version in the ERP.`;
    const style = document.createElement("style");
    style.setAttribute("data-sop-print", "");
    style.textContent = `@media print { @page { @bottom-center { content: ${JSON.stringify(footer)}; font-family: Arial, sans-serif; font-size: 7pt; color: #000; } } }`;
    document.head.appendChild(style);
    document.body.classList.add("sop-print-mode");
    const cleanup = () => {
      document.body.classList.remove("sop-print-mode");
      style.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);
  };

  const whoPublished = (v: VersionRow) => v.published_by_name || (v.uploaded_by ? uploaderEmails.get(v.uploaded_by) : null) || "—";
  const showingDoc = selectedVersion && !selectedVersion.has_file && docContent?.versionId === selectedVersion.id;
  // An SOP covering several products (no single linked product) lists the products in its formula tables.
  const snapshotProducts =
    showingDoc && docContent?.snapshot
      ? Array.from(new Set(Object.values(docContent.snapshot).map((x) => x.productName).filter(Boolean))).join(", ")
      : "";

  return (
    <AuthGuard>
      <div className="sop-print-root mx-auto max-w-5xl space-y-4 text-black">
        <Link href="/compliance/sops" className="sop-no-print inline-block text-[11px] font-medium text-emerald-800 underline">
          ← Back to library
        </Link>

        {loading && !sop ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-xs text-red-600" role="alert">{loadError}</p>
        ) : sop ? (
          <>
            <div className="sop-no-print flex flex-wrap items-center justify-end gap-2">
              {sop.has_draft && (
                <span className="mr-auto rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-black">
                  A draft with unpublished changes exists.
                </span>
              )}
              <Link
                href={`/compliance/sops/${sop.id}/edit`}
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-800"
              >
                Edit
              </Link>
              {selectedVersion?.has_file && (
                <button type="button" onClick={handleDownload} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black shadow-sm hover:bg-zinc-50">
                  Download
                </button>
              )}
              <button
                type="button"
                onClick={handlePrint}
                disabled={!selectedVersion || printing || (selectedVersion.has_file ? !viewUrl : !showingDoc)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {printing ? "Preparing…" : selectedVersion?.has_file ? "Print" : "Print / Save as PDF"}
              </button>
            </div>

            {/* Document header block (prints on the first page). */}
            <div className="sop-header-block rounded-md border border-zinc-300 bg-white p-3">
              <h1 className="text-2xl font-semibold text-black">{sop.title}</h1>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-black sm:grid-cols-3">
                <div><dt className="font-semibold">SOP number</dt><dd>{sop.sop_number || "—"}</dd></div>
                <div><dt className="font-semibold">Version</dt><dd>{selectedVersion ? `v${selectedVersion.version_number}${selectedVersion.is_current ? " (current)" : ""}` : "Not published"}</dd></div>
                <div><dt className="font-semibold">Effective date</dt><dd>{selectedVersion?.effective_date ? formatDate(selectedVersion.effective_date) : "—"}</dd></div>
                <div><dt className="font-semibold">Linked product</dt><dd>{productName ?? (snapshotProducts || "—")}</dd></div>
                <div><dt className="font-semibold">Published by</dt><dd>{selectedVersion ? whoPublished(selectedVersion) : "—"}</dd></div>
                {sop.description && <div className="col-span-2 sm:col-span-3"><dt className="font-semibold">Description</dt><dd>{sop.description}</dd></div>}
              </dl>
            </div>

            {selectedVersion && !selectedVersion.is_current && currentVersion && (
              <div className="sop-no-print rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-black">
                You are viewing an older version (v{selectedVersion.version_number}). Current version is v{currentVersion.version_number}.{" "}
                <button type="button" className="font-medium underline" onClick={() => setSelectedVersionId(currentVersion.id)}>
                  View current
                </button>
              </div>
            )}

            <div className="flex flex-col gap-4 lg:flex-row-reverse lg:items-start">
              {/* Version history: always visible */}
              <aside className="sop-no-print w-full shrink-0 rounded-md border border-zinc-200 bg-white p-2 lg:w-72">
                <h2 className="px-1 pb-1 text-xs font-semibold text-black">Version history ({versions.length})</h2>
                {versions.length === 0 ? (
                  <p className="px-1 text-xs text-black">Not published yet.{sop.has_draft ? " Open the editor to publish the draft." : ""}</p>
                ) : (
                  <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
                    {versions.map((v) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedVersionId(v.id)}
                          className={`w-full rounded px-2 py-1.5 text-left text-xs text-black hover:bg-zinc-50 ${v.id === selectedVersionId ? "bg-emerald-50 ring-1 ring-emerald-500" : ""}`}
                        >
                          <span className="font-semibold">v{v.version_number}</span>
                          {v.is_current && <span className="ml-1 rounded-full bg-emerald-700 px-1.5 py-0.5 text-[10px] text-white">current</span>}
                          <span className="block">{dateTimeNY(v.uploaded_at)} · {whoPublished(v)}</span>
                          <span className="block">{SOURCE_LABEL[v.source] ?? v.source}{v.has_file ? " (PDF)" : ""}</span>
                          {v.change_note && <span className="block italic">{v.change_note}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>

              <section className="min-w-0 flex-1">
                {urlLoading ? (
                  <p className="pt-8 text-center text-xs text-black">Loading…</p>
                ) : urlError ? (
                  <p className="mx-auto mt-8 max-w-md rounded-md border border-red-200 bg-red-50 px-3 py-2 text-center text-xs text-red-700" role="alert">
                    {urlError}
                  </p>
                ) : selectedVersion?.has_file && viewUrl ? (
                  <PdfViewer key={selectedVersion.id} fileUrl={viewUrl} />
                ) : showingDoc && docContent ? (
                  <div className="rounded-md border border-zinc-200 bg-white p-4 print:border-0 print:p-0">
                    <SopRenderProvider mode="snapshot" snapshot={docContent.snapshot} products={[]} supabase={supabase} getToken={getToken}>
                      <SopDocumentRenderer doc={docContent.content} />
                    </SopRenderProvider>
                  </div>
                ) : null}
              </section>
            </div>

            <iframe ref={printFrameRef} className="hidden" title="Print" />
          </>
        ) : (
          <p className="text-xs text-black">SOP not found.</p>
        )}
      </div>
    </AuthGuard>
  );
}
