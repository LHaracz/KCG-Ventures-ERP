"use client";

/**
 * Renders a PDF with pdfjs-dist directly onto <canvas> elements — never an
 * <iframe>, <embed>, or window.open. Continuous vertical scroll with lazy,
 * IntersectionObserver-driven rendering (so a long SOP doesn't render every
 * page up front), fit-to-width by default, zoom in/out, a current-page
 * indicator, and devicePixelRatio-aware canvases so text stays sharp on
 * retina/high-DPI screens. The worker is served from this app's own
 * /public folder (see GlobalWorkerOptions.workerSrc below) — never an
 * external CDN. Meant to be loaded via next/dynamic with { ssr: false }.
 * Native pinch-to-zoom is left to the browser (layout.tsx sets no
 * viewport meta that would disable it) rather than hand-rolled touch
 * gesture handling.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.15;
// Horizontal padding (px-4 on each side) around the page column — subtracted
// from the container's width when computing a fit-to-width scale.
const CONTAINER_HORIZONTAL_PADDING = 32;

type PageEntry = {
  pageNumber: number;
  // Dimensions at scale 1 — used both to size each page's placeholder
  // before it's actually rendered (so continuous scroll never jumps) and
  // to compute the fit-to-width scale.
  baseWidth: number;
  baseHeight: number;
};

const buttonClassName =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

export function PdfViewer({ fileUrl }: { fileUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderedAtScale = useRef<Map<number, number>>(new Map());
  const renderTasks = useRef<Map<number, RenderTask>>(new Map());
  const visiblePages = useRef<Set<number>>(new Set());
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [scale, setScale] = useState(1);
  const [fitToWidth, setFitToWidth] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  // Loads the document (and every page's base dimensions, so the
  // continuous-scroll column can be laid out immediately) whenever the
  // signed URL changes — e.g. a different version was selected, or the
  // viewer re-fetched a fresh URL after the previous one expired.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPages([]);
    setCurrentPage(1);
    pageRefs.current.clear();
    canvasRefs.current.clear();
    renderedAtScale.current.clear();
    visiblePages.current.clear();

    const load = async () => {
      try {
        const doc = await pdfjsLib.getDocument({ url: fileUrl }).promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        const entries: PageEntry[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          entries.push({ pageNumber: i, baseWidth: viewport.width, baseHeight: viewport.height });
        }
        if (!cancelled) setPages(entries);
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "";
        const looksExpired = /missing|404|403|400/i.test(message);
        setError(
          looksExpired
            ? "This file couldn't be loaded — the link may have expired. Try reopening the viewer."
            : message || "Failed to load this PDF.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();

    return () => {
      cancelled = true;
      docRef.current?.destroy();
      docRef.current = null;
      renderTasks.current.forEach((task) => task.cancel());
      renderTasks.current.clear();
    };
  }, [fileUrl]);

  // Recomputes the fit-to-width scale whenever that mode is active and the
  // viewer's available width changes (container resize, or pages finishing
  // their metadata load).
  useEffect(() => {
    if (!fitToWidth || pages.length === 0 || !containerRef.current) return;
    const container = containerRef.current;
    const maxBaseWidth = Math.max(...pages.map((p) => p.baseWidth));
    if (maxBaseWidth <= 0) return;

    const computeFitScale = () => {
      const available = container.clientWidth - CONTAINER_HORIZONTAL_PADDING;
      if (available <= 0) return;
      setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / maxBaseWidth)));
    };
    computeFitScale();

    const observer = new ResizeObserver(computeFitScale);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitToWidth, pages]);

  const renderPage = useCallback(
    async (pageNumber: number, targetScale: number) => {
      const doc = docRef.current;
      const canvas = canvasRefs.current.get(pageNumber);
      if (!doc || !canvas) return;
      if (renderedAtScale.current.get(pageNumber) === targetScale) return;

      renderTasks.current.get(pageNumber)?.cancel();

      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: targetScale });
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        const task = page.render({ canvasContext: context, viewport });
        renderTasks.current.set(pageNumber, task);
        await task.promise;
        renderedAtScale.current.set(pageNumber, targetScale);
      } catch {
        // A render task that's superseded by a newer one (scale changed
        // mid-render) rejects with a cancellation error — expected, not a
        // failure worth surfacing.
      }
    },
    [],
  );

  // Lazily renders a page only once it's scrolled near the viewport, and
  // tracks the current page for the "Page X of N" indicator.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || pages.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let mostVisible: { pageNumber: number; ratio: number } | null = null;
        for (const entry of entries) {
          const pageNumber = Number(entry.target.getAttribute("data-page-number"));
          if (!pageNumber) continue;
          if (entry.isIntersecting) {
            visiblePages.current.add(pageNumber);
            renderPage(pageNumber, scale);
            if (!mostVisible || entry.intersectionRatio > mostVisible.ratio) {
              mostVisible = { pageNumber, ratio: entry.intersectionRatio };
            }
          } else {
            visiblePages.current.delete(pageNumber);
          }
        }
        if (mostVisible) setCurrentPage(mostVisible.pageNumber);
      },
      { root: container, rootMargin: "800px 0px", threshold: 0.01 },
    );

    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  // Re-renders whatever is currently on screen whenever the zoom level
  // changes (zoom in/out, or a fit-to-width recompute).
  useEffect(() => {
    visiblePages.current.forEach((pageNumber) => renderPage(pageNumber, scale));
  }, [scale, renderPage]);

  const handleZoomIn = () => {
    setFitToWidth(false);
    setScale((s) => Math.min(MAX_SCALE, Math.round((s + ZOOM_STEP) * 100) / 100));
  };
  const handleZoomOut = () => {
    setFitToWidth(false);
    setScale((s) => Math.max(MIN_SCALE, Math.round((s - ZOOM_STEP) * 100) / 100));
  };
  const handleFitWidth = () => setFitToWidth(true);

  return (
    <div className="flex h-full min-h-[70vh] flex-col overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={handleZoomOut} className={buttonClassName} aria-label="Zoom out">
            −
          </button>
          <span className="w-12 text-center text-xs text-zinc-700">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={handleZoomIn} className={buttonClassName} aria-label="Zoom in">
            +
          </button>
          <button
            type="button"
            onClick={handleFitWidth}
            disabled={fitToWidth}
            className={buttonClassName}
          >
            Fit width
          </button>
        </div>
        <div className="text-xs font-medium text-zinc-700">
          {pages.length > 0 ? `Page ${currentPage} of ${pages.length}` : ""}
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-zinc-100 px-4 py-4"
        style={{ touchAction: "pan-x pan-y pinch-zoom" }}
      >
        {loading && <p className="pt-8 text-center text-xs text-zinc-600">Loading PDF…</p>}
        {!loading && error && (
          <p
            className="mx-auto mt-8 max-w-md rounded-md border border-red-200 bg-red-50 px-3 py-2 text-center text-xs text-red-700"
            role="alert"
          >
            {error}
          </p>
        )}
        {!loading && !error && (
          <div className="mx-auto flex w-fit flex-col items-center gap-4">
            {pages.map((p) => (
              <div
                key={p.pageNumber}
                data-page-number={p.pageNumber}
                ref={(el) => {
                  if (el) pageRefs.current.set(p.pageNumber, el);
                  else pageRefs.current.delete(p.pageNumber);
                }}
                style={{ width: p.baseWidth * scale, height: p.baseHeight * scale }}
                className="relative bg-white shadow-sm"
              >
                <canvas
                  ref={(el) => {
                    if (el) canvasRefs.current.set(p.pageNumber, el);
                    else canvasRefs.current.delete(p.pageNumber);
                  }}
                  className="block"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
