"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";

// pdfjs-dist touches browser-only globals (canvas, worker), so the viewer
// is loaded client-side only — never during SSR.
const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => <p className="pt-8 text-center text-xs text-zinc-600">Loading viewer…</p>,
});

type SopDetail = {
  id: string;
  title: string;
  sop_number: string | null;
  description: string | null;
};

type VersionRow = {
  id: string;
  version_number: number;
  original_filename: string;
  effective_date: string | null;
  change_note: string | null;
  is_current: boolean;
  uploaded_at: string;
  uploaded_by: string | null;
};

export default function SopViewerPage() {
  const params = useParams<{ id: string }>();
  const sopId = params.id;
  const { user, supabase } = useSupabase();

  const [sop, setSop] = useState<SopDetail | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [uploaderEmails, setUploaderEmails] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const printFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [printing, setPrinting] = useState(false);

  const authedFetch = async (path: string) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed.");
    return payload;
  };

  const load = async () => {
    if (!sopId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [sopResult, versionsPayload] = await Promise.all([
        supabase.from("sops").select("id, title, sop_number, description").eq("id", sopId).maybeSingle(),
        // Versions go through an API route (not a direct client query) only
        // because it also resolves uploader emails via the admin API — the
        // browser can't read auth.users directly.
        authedFetch(`/api/compliance/sops/${sopId}/versions`),
      ]);
      if (sopResult.error) throw new Error(sopResult.error.message);
      if (!sopResult.data) throw new Error("SOP not found.");

      setSop(sopResult.data as SopDetail);
      const versionRows = (versionsPayload.versions ?? []) as VersionRow[];
      setVersions(versionRows);
      setUploaderEmails(new Map(Object.entries(versionsPayload.uploaderEmails ?? {})));

      const current = versionRows.find((v) => v.is_current) ?? versionRows[0] ?? null;
      setSelectedVersionId(current?.id ?? null);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load this SOP.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user || !sopId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, sopId]);

  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === selectedVersionId) ?? null,
    [versions, selectedVersionId],
  );
  const currentVersion = useMemo(() => versions.find((v) => v.is_current) ?? null, [versions]);

  // Fetches a fresh short-lived signed URL whenever the selected version
  // changes — never reuses one past its ~10 minute window.
  useEffect(() => {
    if (!selectedVersionId || !sopId) return;
    let cancelled = false;
    const fetchUrl = async () => {
      setUrlLoading(true);
      setUrlError(null);
      setViewUrl(null);
      try {
        const payload = await authedFetch(
          `/api/compliance/sops/${sopId}/versions/${selectedVersionId}/signed-url`,
        );
        if (!cancelled) setViewUrl(payload.url);
      } catch (err: any) {
        if (!cancelled) setUrlError(err.message || "Failed to load this file.");
      } finally {
        if (!cancelled) setUrlLoading(false);
      }
    };
    fetchUrl();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId, sopId]);

  const handleDownload = async () => {
    if (!sopId || !selectedVersionId) return;
    try {
      const payload = await authedFetch(
        `/api/compliance/sops/${sopId}/versions/${selectedVersionId}/signed-url?download=1`,
      );
      window.location.href = payload.url;
    } catch (err: any) {
      setUrlError(err.message || "Failed to download this file.");
    }
  };

  const handlePrint = async () => {
    if (!viewUrl || !printFrameRef.current) return;
    setPrinting(true);
    try {
      const frame = printFrameRef.current;
      frame.src = viewUrl;
      frame.onload = () => {
        try {
          frame.contentWindow?.print();
        } finally {
          setPrinting(false);
        }
      };
    } catch {
      setPrinting(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-4">
        <Link
          href="/compliance/sops"
          className="inline-block text-[11px] font-medium text-emerald-700 underline"
        >
          ← Back to library
        </Link>

        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        ) : sop ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-2xl font-semibold text-zinc-900">{sop.title}</h1>
                <p className="text-sm text-black">
                  {sop.sop_number ? `${sop.sop_number} · ` : ""}
                  {currentVersion ? `Current version v${currentVersion.version_number}` : "No versions"}
                  {currentVersion?.effective_date
                    ? ` · Effective ${formatDate(currentVersion.effective_date)}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={!selectedVersionId}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={handlePrint}
                  disabled={!viewUrl || printing}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {printing ? "Preparing…" : "Print"}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs font-medium text-zinc-800">Version</label>
              <select
                value={selectedVersionId ?? ""}
                onChange={(e) => setSelectedVersionId(e.target.value)}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version_number}
                    {v.is_current ? " (current)" : ""} — {formatDate(v.uploaded_at)}
                  </option>
                ))}
              </select>
            </div>

            {selectedVersion && !selectedVersion.is_current && currentVersion && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                You are viewing an older version (v{selectedVersion.version_number}). Current
                version is v{currentVersion.version_number}.
              </div>
            )}

            {selectedVersion && (
              <p className="text-[11px] text-zinc-500">
                Uploaded {formatDate(selectedVersion.uploaded_at)}
                {selectedVersion.uploaded_by && uploaderEmails.get(selectedVersion.uploaded_by)
                  ? ` by ${uploaderEmails.get(selectedVersion.uploaded_by)}`
                  : ""}
                {selectedVersion.change_note ? ` — ${selectedVersion.change_note}` : ""}
              </p>
            )}

            {urlLoading ? (
              <p className="pt-8 text-center text-xs text-zinc-600">Preparing file…</p>
            ) : urlError ? (
              <p
                className="mx-auto mt-8 max-w-md rounded-md border border-red-200 bg-red-50 px-3 py-2 text-center text-xs text-red-700"
                role="alert"
              >
                {urlError}
              </p>
            ) : viewUrl ? (
              <PdfViewer key={selectedVersionId} fileUrl={viewUrl} />
            ) : null}

            {/* Hidden print target — never shown; only used to invoke the
                browser's native print dialog on the current file. */}
            <iframe ref={printFrameRef} className="hidden" title="Print" />
          </>
        ) : (
          <p className="text-xs text-black">SOP not found.</p>
        )}
      </div>
    </AuthGuard>
  );
}
