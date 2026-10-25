"use client";

/**
 * Shared modal for opening a log entry's attached file in-app — PDF via
 * the existing pdf.js viewer, PNG/JPG via a plain image viewer. Never a
 * new browser tab and never a bare download prompt: Download and Print
 * are explicit buttons. Used by the entry detail page's Documents section
 * and by the COAs page's Files column.
 */

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { isImageFilename } from "@/lib/complianceLogs";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => <p className="pt-8 text-center text-xs text-zinc-600">Loading viewer…</p>,
});

export type DocumentViewerTarget = {
  fileName: string;
  title: string;
  fetchSignedUrl: (opts?: { download?: boolean }) => Promise<string>;
};

export function DocumentViewerModal({ target, onClose }: { target: DocumentViewerTarget; onClose: () => void }) {
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setViewUrl(null);
    target
      .fetchSignedUrl()
      .then((url) => {
        if (!cancelled) setViewUrl(url);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || "Failed to load this file.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.fileName]);

  const handleDownload = async () => {
    try {
      const url = await target.fetchSignedUrl({ download: true });
      window.location.href = url;
    } catch (err: any) {
      setError(err.message || "Failed to download this file.");
    }
  };

  const handlePrint = () => {
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

  const isImage = isImageFilename(target.fileName);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-full max-h-[90vh] w-full max-w-4xl flex-col rounded-md border border-zinc-200 bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2.5">
          <h2 className="truncate text-sm font-semibold text-zinc-900">{target.title}</h2>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleDownload}
              disabled={!viewUrl}
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
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <p className="pt-8 text-center text-xs text-zinc-600">Preparing file…</p>
          ) : error ? (
            <p className="mx-auto mt-8 max-w-md rounded-md border border-red-200 bg-red-50 px-3 py-2 text-center text-xs text-red-700" role="alert">
              {error}
            </p>
          ) : viewUrl ? (
            isImage ? (
              <div className="flex justify-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not a static asset */}
                <img src={viewUrl} alt={target.fileName} className="max-w-full rounded-md border border-zinc-200" />
              </div>
            ) : (
              <PdfViewer key={viewUrl} fileUrl={viewUrl} />
            )
          ) : null}
        </div>

        {/* Hidden print target — never shown; only used to invoke the
            browser's native print dialog on the current file. */}
        <iframe ref={printFrameRef} className="hidden" title="Print" />
      </div>
    </div>
  );
}
