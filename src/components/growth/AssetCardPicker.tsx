"use client";

/**
 * Asset cards: the card picker (a modal, 20 assets per page from the server,
 * filters, multi or single select that survives paging, a larger preview
 * with arrows, Upload new asset), and the cards that show a post's selected
 * assets. Thumbnails for a page are signed in one batch call and load lazily.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { assetPickerApi, signedAssetUrlsApi, type AssetPage, type MarketingData } from "@/lib/growth/client";
import { fileKindOf } from "@/lib/growth/naming";
import { categoryLabel } from "@/lib/growth/assetCategories";
import type { Asset } from "@/lib/growth/marketingService";
import { AddAssetsDialog, CANT_PLAY, NO_PREVIEW, THUMB_STALE_MS, hasThumb, isVideoKind, mediaKind, thumbKey } from "./AssetLibrary";
import { Dialog, btn, btnPrimary, errorBox, input, warnBox } from "./GrowthUi";

const touch = "min-h-11";
type CardAsset = Pick<Asset, "id" | "title" | "source" | "mime_type" | "preview_path" | "poster_path" | "file_path" | "url" | "category" | "created_at">;
const KIND_LABEL: Record<string, string> = { image: "Image", gif: "GIF", video: "Video", pdf: "PDF", link: "Link", other: "File" };
const KINDS = [
  { value: "", label: "All file types" },
  { value: "image", label: "Images" },
  { value: "gif", label: "GIFs" },
  { value: "video", label: "Videos" },
  { value: "pdf", label: "PDFs" },
  { value: "link", label: "Links" },
];

/** Signed thumbnail links for the given assets, fetched in one batch and kept for about 50 minutes. */
export function useThumbs(assets: readonly CardAsset[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cache = useRef<Record<string, { url: string; at: number }>>({});
  const [retry, setRetry] = useState(0);
  const keys = assets.filter(hasThumb).map(thumbKey).join(",");
  useEffect(() => {
    const want = keys ? keys.split(",") : [];
    const now = Date.now();
    const missing = want.filter((k) => !cache.current[k] || now - cache.current[k].at > THUMB_STALE_MS);
    if (!missing.length) return;
    let live = true;
    void signedAssetUrlsApi(missing.map((k) => k.split("|")[0]), false, "thumb")
      .then((r) => {
        const at = Date.now();
        const add: Record<string, string> = {};
        for (const k of missing) {
          const u = r.urls[k.split("|")[0]];
          if (u) {
            cache.current[k] = { url: u, at };
            add[k] = u;
          }
        }
        if (live) setUrls((s) => ({ ...s, ...add }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [keys, retry]);
  const url = useCallback((a: CardAsset) => urls[thumbKey(a)] ?? null, [urls]);
  const failed = useCallback((a: CardAsset) => {
    delete cache.current[thumbKey(a)];
    setUrls((s) => {
      const next = { ...s };
      delete next[thumbKey(a)];
      return next;
    });
    setRetry((n) => n + 1);
  }, []);
  return { url, failed };
}

/** A fixed-size thumbnail (the layout never jumps), or a placeholder. */
function Thumb({ asset, src, onError }: { asset: CardAsset; src: string | null; onError: () => void }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed URL from private storage
      <img src={src} alt={asset.title} loading="lazy" decoding="async" width={320} height={192} onError={onError} className="h-32 w-full rounded object-cover" />
    );
  }
  return (
    <div className="flex h-32 w-full items-center justify-center rounded bg-zinc-100 p-2 text-center text-xs text-black" data-testid="card-placeholder">
      {asset.source === "link" ? "Link" : KIND_LABEL[fileKindOf(asset)]}
    </div>
  );
}

/** A larger preview: image (GIFs animate), MP4 or MOV in a player, HEIC as its JPG preview; links open in a new tab. */
function PreviewDialog({
  list,
  index,
  setIndex,
  isSelected,
  onToggle,
  onClose,
}: {
  list: readonly CardAsset[];
  index: number;
  setIndex: (i: number) => void;
  isSelected?: (id: string) => boolean;
  onToggle?: (a: CardAsset) => void;
  onClose: () => void;
}) {
  const a = list[index];
  const [view, setView] = useState<{ id: string; url: string | null; poster?: string | null; failed?: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!a || a.source === "link") return { id: a?.id ?? "", url: null };
      const kind = mediaKind(a);
      if (kind === "heic") return { id: a.id, url: a.preview_path ? (await signedAssetUrlsApi([a.id], false, "preview")).urls[a.id] ?? null : null };
      if (isVideoKind(kind)) {
        const [o, p] = await Promise.all([signedAssetUrlsApi([a.id]), a.poster_path ? signedAssetUrlsApi([a.id], false, "thumb") : Promise.resolve({ urls: {} as Record<string, string> })]);
        return { id: a.id, url: o.urls[a.id] ?? null, poster: p.urls[a.id] ?? null };
      }
      if (fileKindOf(a) === "image" || fileKindOf(a) === "gif") return { id: a.id, url: (await signedAssetUrlsApi([a.id])).urls[a.id] ?? null };
      return { id: a.id, url: null };
    };
    load()
      .then((v) => live && setView(v))
      .catch(() => live && setView({ id: a?.id ?? "", url: null }));
    return () => {
      live = false;
    };
  }, [a]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      if (e.key === "ArrowRight" && index < list.length - 1) setIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, list.length, setIndex]);
  if (!a) return null;
  const shown = view?.id === a.id ? view : null;
  const selected = isSelected?.(a.id) ?? false;
  return (
    <Dialog title={a.title} onClose={onClose} wide>
      <div className="space-y-2 text-black" data-testid="asset-preview">
        {a.source === "link" ? (
          <p>
            <a className="underline" href={a.url ?? "#"} target="_blank" rel="noopener noreferrer">Open the link</a>
          </p>
        ) : !shown ? (
          <div className="flex h-64 items-center justify-center rounded bg-zinc-100 text-sm">Loading…</div>
        ) : !shown.url ? (
          <div className="flex h-48 items-center justify-center rounded bg-zinc-100 text-sm">{NO_PREVIEW}</div>
        ) : isVideoKind(mediaKind(a)) ? (
          shown.failed ? (
            <p className={warnBox} role="alert">{CANT_PLAY}</p>
          ) : (
            <video src={shown.url} poster={shown.poster ?? undefined} controls playsInline preload="metadata" className="max-h-[60vh] w-full" onError={() => setView({ ...shown, failed: true })} />
          )
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage (GIFs animate)
          <img src={shown.url} alt={a.title} className="max-h-[60vh] w-full object-contain" />
        )}
        <div className="flex items-center justify-between gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={() => setIndex(index - 1)} disabled={index === 0} aria-label="Previous asset">←</button>
          {onToggle && (
            <button type="button" className={`${selected ? btn : btnPrimary} ${touch}`} onClick={() => onToggle(a)}>
              {selected ? "Deselect" : "Select"}
            </button>
          )}
          <button type="button" className={`${btn} ${touch}`} onClick={() => setIndex(index + 1)} disabled={index >= list.length - 1} aria-label="Next asset">→</button>
        </div>
      </div>
    </Dialog>
  );
}

/** The selected assets as cards (thumbnail, name, remove; click to enlarge). */
export function AssetCards({ data, ids, onRemove, emptyText = "No assets selected." }: { data: MarketingData; ids: readonly string[]; onRemove?: (id: string) => void; emptyText?: string }) {
  const list = ids.map((id) => data.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a);
  const thumbs = useThumbs(list);
  const [open, setOpen] = useState<number | null>(null);
  if (!list.length) return <p className="text-xs">{emptyText}</p>;
  return (
    <>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="asset-cards">
        {list.map((a, i) => (
          <li key={a.id} className="rounded-md border border-zinc-200 bg-white p-1" data-testid="asset-card-selected">
            <button type="button" className="block w-full" onClick={() => setOpen(i)} aria-label={`Enlarge ${a.title}`}>
              <Thumb asset={a} src={thumbs.url(a)} onError={() => thumbs.failed(a)} />
            </button>
            <div className="mt-1 flex items-start justify-between gap-1">
              <span className="line-clamp-2 break-all text-xs">{a.title}</span>
              {onRemove && <button type="button" className={btn} onClick={() => onRemove(a.id)} aria-label={`Remove ${a.title}`}>✕</button>}
            </div>
          </li>
        ))}
      </ul>
      {open !== null && <PreviewDialog list={list} index={open} setIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * The card picker. "multi" for Add assets (Save is enabled once the
 * selection differs from `initial` and isn't empty); "single" for a need's
 * Attach asset (choosing a card replaces the previous choice).
 */
export function AssetCardPicker({
  data,
  mode,
  initial = [],
  title,
  onClose,
  onSave,
  reload,
  extra,
}: {
  data: MarketingData;
  mode: "multi" | "single";
  initial?: readonly string[];
  title: string;
  onClose: () => void;
  onSave: (ids: string[]) => void | Promise<void>;
  reload: () => Promise<void>;
  /** Shown under the header (for example "Also apply to …"). */
  extra?: ReactNode;
}) {
  const [f, setF] = useState({ category: "", kind: "", q: "", product: "" });
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<AssetPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([...initial]);
  const [preview, setPreview] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const openedAt = useRef(new Date().toISOString());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    assetPickerApi({ page, ...f })
      .then((r) => {
        if (!live) return;
        setRes(r);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [page, f, tick]);
  const rows = res?.rows ?? [];
  const thumbs = useThumbs(rows);
  const setFilter = (patch: Partial<typeof f>) => {
    setF((s) => ({ ...s, ...patch }));
    setPage(1);
  };
  const toggle = (a: { id: string }) =>
    setSelected((s) => (mode === "single" ? (s.includes(a.id) ? [] : [a.id]) : s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id]));
  const changed = selected.length !== initial.length || selected.some((x) => !initial.includes(x));
  const canSave = selected.length > 0 && changed && !busy;
  const save = async () => {
    setBusy(true);
    try {
      await onSave(selected);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className="space-y-3 text-black" data-testid="asset-card-picker">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium" aria-live="polite">{selected.length} selected</p>
          <div className="flex gap-2">
            <button type="button" className={`${btn} ${touch}`} onClick={() => setUploading(true)}>Upload new asset</button>
            <button type="button" className={`${btn} ${touch}`} onClick={onClose}>Cancel</button>
            <button type="button" className={`${btnPrimary} ${touch}`} onClick={save} disabled={!canSave}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
        {extra}
        <div className="flex flex-wrap gap-2">
          <select aria-label="Category" value={f.category} onChange={(e) => setFilter({ category: e.target.value })} className={`${input} w-40`}>
            <option value="">All categories</option>
            {data.assetCategories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            <option value="uncategorized">Uncategorized</option>
          </select>
          <select aria-label="File type" value={f.kind} onChange={(e) => setFilter({ kind: e.target.value })} className={`${input} w-36`}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <select aria-label="Product" value={f.product} onChange={(e) => setFilter({ product: e.target.value })} className={`${input} w-40`}>
            <option value="">Any product</option>
            {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input aria-label="Search by name" placeholder="Search by name" value={f.q} onChange={(e) => setFilter({ q: e.target.value })} className={`${input} w-48`} />
        </div>
        {error && <p className={errorBox} role="alert">{error}</p>}
        {!res ? (
          <p className="text-sm">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No assets match.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="picker-grid">
            {rows.map((a, i) => {
              const on = selected.includes(a.id);
              return (
                <li key={a.id} className={`rounded-md border p-1 ${on ? "border-emerald-500 ring-2 ring-emerald-400" : "border-zinc-200"}`} data-testid="picker-card">
                  <button type="button" className="block w-full" onClick={() => setPreview(i)} aria-label={`Preview ${a.title}`}>
                    <Thumb asset={a} src={thumbs.url(a)} onError={() => thumbs.failed(a)} />
                  </button>
                  <p className="mt-1 line-clamp-2 break-all text-xs font-medium">{a.title}</p>
                  <p className="text-[11px]">{categoryLabel(data.assetCategories, a.category)} · {KIND_LABEL[fileKindOf(a)]}</p>
                  <button type="button" aria-pressed={on} className={`${on ? btnPrimary : btn} mt-1 w-full ${touch}`} onClick={() => toggle(a)}>
                    {on ? "✓ Selected" : "Select"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {res && res.pages > 1 && (
          <div className="flex items-center justify-center gap-2" data-testid="picker-pages">
            <button type="button" className={`${btn} ${touch}`} onClick={() => setPage(page - 1)} disabled={page <= 1}>Previous</button>
            <span className="text-sm">Page {res.page} of {res.pages} ({res.total} assets)</span>
            <button type="button" className={`${btn} ${touch}`} onClick={() => setPage(page + 1)} disabled={page >= res.pages}>Next</button>
          </div>
        )}
      </div>
      {preview !== null && <PreviewDialog list={rows} index={preview} setIndex={setPreview} isSelected={(id) => selected.includes(id)} onToggle={toggle} onClose={() => setPreview(null)} />}
      {uploading && (
        <AddAssetsDialog
          data={data}
          reload={reload}
          onClose={() => setUploading(false)}
          onDone={async () => {
            setUploading(false);
            await reload();
            // Select what was just uploaded (newest first, so it's on page 1 with no filters).
            const r = await assetPickerApi({ page: 1 });
            const fresh = r.rows.filter((a) => a.created_at >= openedAt.current).map((a) => a.id);
            if (fresh.length) setSelected((s) => (mode === "single" ? [fresh[0]] : [...new Set([...s, ...fresh])]));
            setF({ category: "", kind: "", q: "", product: "" });
            setPage(1);
            setTick((n) => n + 1);
          }}
        />
      )}
    </Dialog>
  );
}
