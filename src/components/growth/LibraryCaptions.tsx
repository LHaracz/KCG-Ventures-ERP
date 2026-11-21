"use client";

/**
 * Ad Library caption tools: the Edit caption popup (conflicts, previous
 * versions, final caption preview), Copy captions (split button, options
 * remembered in this browser, a fallback window when the clipboard is
 * blocked), the hashtag text area used for subtopics and products, plus a
 * small accessible menu, popover and toast.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { captionHistoryApi, updateCaptionApi, type MarketingData } from "@/lib/growth/client";
import { buildCopyText, parseHashtags, stripTrailingHashtagBlock } from "@/lib/growth/naming";
import { finalCaptionOf, hitsIn } from "@/lib/growth/libraryView";
import { PLATFORM_SHORT } from "@/lib/growth/scheduling";
import { todayNy } from "@/lib/growth/dates";
import type { CaptionVersion, PremadeRow } from "@/lib/growth/libraryService";
import { Dialog, btn, btnPrimary, errorBox, fmtDate, infoBox, input, warnBox } from "./GrowthUi";

const touch = "min-h-11";

// --- Menu, popover, toast ------------------------------------------------------------------------------
export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; hint?: string };

/** A button that opens a menu. Arrow keys move, Escape closes and focus returns to the button. */
export function MenuButton({ label, items, ariaLabel, className = btn }: { label: ReactNode; items: MenuItem[]; ariaLabel?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };
  return (
    <div className="relative inline-block">
      <button ref={button} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <div ref={menu} id={id} role="menu" onKeyDown={onKey} className="absolute right-0 z-30 mt-1 min-w-44 rounded-md border border-zinc-200 bg-white py-1 text-black shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.hint}
              onClick={() => {
                close();
                it.onSelect();
              }}
              className="block w-full px-3 py-2 text-left text-sm text-black hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A button that opens a panel (filters, options). Escape or a click outside closes it. */
export function Popover({ label, children, ariaLabel, className = btn, align = "right" }: { label: ReactNode; children: ReactNode; ariaLabel?: string; className?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="relative inline-block">
      <button ref={button} type="button" className={className} aria-expanded={open} aria-controls={id} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={ariaLabel}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
              button.current?.focus();
            }
          }}
          className={`absolute ${align === "right" ? "right-0" : "left-0"} z-30 mt-1 w-80 max-w-[90vw] rounded-md border border-zinc-200 bg-white p-3 text-black shadow-lg`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A short message at the bottom of the screen. */
export function useToast(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 6000);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const node = (
    <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-4 left-1/2 z-[70] -translate-x-1/2">
      {text && <p className="pointer-events-auto rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm text-black shadow-lg" data-testid="toast">{text}</p>}
    </div>
  );
  return [node, show];
}

// --- Hashtag text area ------------------------------------------------------------------------------------
/** A plain text area for a hashtag list, with a live count and a warning listing anything that isn't a hashtag. */
export function HashtagField({ name, value, onChange, label = "Hashtags", error }: { name: string; value: string; onChange: (v: string) => void; label?: string; error?: string }) {
  const parsed = parseHashtags(value);
  const id = `f-${name}`;
  return (
    <div data-testid={`hashtags-${name}`}>
      <label htmlFor={id} className="text-xs font-medium text-black">{label}</label>
      <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} className={input} aria-invalid={!!error || parsed.invalid.length > 0} aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="mt-1 text-[11px] text-black">
        Paste or type all hashtags, separated by spaces. No numbering. {parsed.tags.length} hashtag{parsed.tags.length === 1 ? "" : "s"}.
      </p>
      {parsed.invalid.length > 0 && (
        <p className={`${warnBox} mt-1`} role="alert">
          These aren&apos;t hashtags and will be left out: {parsed.invalid.join(", ")}
        </p>
      )}
      {error && <p className={`${errorBox} mt-1`}>{error}</p>}
    </div>
  );
}

// --- Copy captions -----------------------------------------------------------------------------------------
const OPT_NAMES = "kcg.copyCaptions.names";
const OPT_BOTH = "kcg.copyCaptions.bothTabs";
const readOpt = (k: string) => {
  try {
    return window.localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const writeOpt = (k: string, v: boolean) => {
  try {
    window.localStorage.setItem(k, v ? "1" : "0");
  } catch {
    // Storage blocked: the option still applies until the page reloads.
  }
};
export const COPY_MAX = 2000;
type CopyRow = { name: string; caption: string | null };
/** What Copy captions puts on the clipboard: each caption's body (no hashtags), one blank line between. */
export const copyTextFor = (rows: readonly CopyRow[], includeNames: boolean) =>
  buildCopyText(rows.map((r) => ({ name: r.name, body: stripTrailingHashtagBlock(r.caption).body })), { includeNames });
export function copyMessage(copied: number, skipped: number) {
  if (!copied) return "Nothing to copy";
  return `Copied ${copied} caption${copied === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} with no caption` : ""}`;
}

/**
 * Copy captions (split button). `rowsFor(bothTabs)` returns the complete
 * filtered list in table order; the text is built in the click so the
 * clipboard write happens inside it.
 */
export function CopyCaptionsButton({ rowsFor, toast }: { rowsFor: (bothTabs: boolean) => readonly CopyRow[]; toast: (t: string) => void }) {
  const [names, setNames] = useState(false);
  const [both, setBoth] = useState(false);
  const [fallback, setFallback] = useState<{ text: string; message: string } | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the remembered options once, in the browser
    setNames(readOpt(OPT_NAMES));
    setBoth(readOpt(OPT_BOTH));
  }, []);
  const rows = rowsFor(both);
  const preview = rows.length > COPY_MAX ? null : copyTextFor(rows, names);
  const count = preview ? preview.copied : rows.length;
  const copy = () => {
    if (rows.length > COPY_MAX) return toast(`Too many to copy at once: ${rows.length} posts. Narrow the filters to ${COPY_MAX} or fewer.`);
    const r = copyTextFor(rows, names);
    if (!r.copied) return toast("Nothing to copy");
    const message = copyMessage(r.copied, r.skipped);
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip?.writeText) return setFallback({ text: r.text, message });
    clip.writeText(r.text).then(
      () => toast(message),
      () => setFallback({ text: r.text, message }),
    );
  };
  return (
    <div className="inline-flex" data-testid="copy-captions">
      <button type="button" className={`${btn} ${touch} rounded-r-none`} onClick={copy}>
        Copy captions ({count})
      </button>
      <Popover label="▾" ariaLabel="Copy captions options" className={`${btn} ${touch} -ml-px rounded-l-none`}>
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={names} onChange={(e) => { setNames(e.target.checked); writeOpt(OPT_NAMES, e.target.checked); }} className="mt-1" />
            Add the post name above each caption
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={both} onChange={(e) => { setBoth(e.target.checked); writeOpt(OPT_BOTH, e.target.checked); }} className="mt-1" />
            Include both Reels and Picture posts
          </label>
          <p className="text-[11px]">Copies the caption text only (no hashtags), one blank line between captions.</p>
        </div>
      </Popover>
      {fallback && <CopyFallback text={fallback.text} message={fallback.message} onClose={() => setFallback(null)} />}
    </div>
  );
}

/** When the clipboard is blocked: the full text, selected, to copy by hand. */
export function CopyFallback({ text, message, onClose }: { text: string; message: string; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    area.current?.focus();
    area.current?.select();
  }, []);
  return (
    <Dialog title="Copy captions" onClose={onClose} wide>
      <div className="space-y-2 text-black" data-testid="copy-fallback">
        <p className="text-sm">Press Ctrl+C (or Cmd+C) to copy.</p>
        <textarea ref={area} readOnly value={text} rows={14} className={input} aria-label="Captions to copy" />
        <div className="flex justify-end gap-2">
          {done && <span className="self-center text-sm">{message}</span>}
          <button
            type="button"
            className={btnPrimary}
            onClick={() => {
              area.current?.select();
              const clip = navigator.clipboard;
              if (clip?.writeText) void clip.writeText(text).then(() => setDone(true), () => undefined);
            }}
          >
            Copy
          </button>
          <button type="button" className={btn} onClick={onClose}>Close</button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Edit caption popup -------------------------------------------------------------------------------------
type Conflict = { theirs: string; updatedAt: string };

/** "AA-1 is scheduled on Dec 1 for IG, FB." for the earliest upcoming group that isn't Posted. */
export function scheduledNotice(data: MarketingData, post: { id: string; name: string }): string | null {
  const today = todayNy();
  const live = data.posts.filter((e) => e.premade_post_id === post.id && !e.archived_at && e.status !== "posted" && e.scheduled_date && e.scheduled_date >= today);
  if (!live.length) return null;
  const first = live.map((e) => e.scheduled_date!).sort()[0];
  const plats = [...new Set(live.filter((e) => e.scheduled_date === first).map((e) => PLATFORM_SHORT[e.platform] ?? e.platform))];
  return `${post.name} is scheduled on ${fmtDate(first)} for ${plats.join(", ")}. The scheduled post will use the new caption.`;
}

/**
 * Edit caption: changes only the caption, with the version the user opened
 * (so someone else's change is never overwritten without asking).
 */
export function CaptionEditDialog({ data, post, onClose, onSaved }: { data: MarketingData; post: PremadeRow; onClose: () => void; onSaved: (message: string) => void }) {
  const [text, setText] = useState(post.caption ?? "");
  const [expected, setExpected] = useState(post.updated_at);
  const [restored, setRestored] = useState<string | null>(null);
  const [versions, setVersions] = useState<CaptionVersion[] | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState(post.caption ?? "");
  const dirty = text !== original;
  useEffect(() => {
    let live = true;
    captionHistoryApi(post.id)
      .then((r) => live && setVersions(r.versions))
      .catch(() => live && setVersions([]));
    return () => {
      live = false;
    };
  }, [post.id]);
  const hits = hitsIn(data, text);
  const finalCaption = finalCaptionOf(data, { ...post, caption: text });
  const notice = scheduledNotice(data, post);
  const rows = Math.min(30, Math.max(8, text.split("\n").length + 1));
  const save = async (expectedAt = expected) => {
    setBusy(true);
    setError(null);
    try {
      const r = await updateCaptionApi(post.id, { caption: text, expected_updated_at: expectedAt, source: restored !== null && restored === text ? "restore" : "table_edit" });
      if ("conflict" in r) {
        setConflict({ theirs: r.current_caption, updatedAt: r.current_updated_at });
        setBusy(false);
        return;
      }
      onSaved(`Saved ${post.name}${r.notice ? `. ${r.notice}` : ""}`);
    } catch (e) {
      // Keep the popup open with the user's text.
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());
  return (
    <Dialog title={`Edit caption: ${post.name}`} onClose={requestClose} wide>
      <div
        className="space-y-3 text-black"
        data-testid="caption-editor"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !busy) {
            e.preventDefault();
            void save();
          }
        }}
      >
        {post.category === "reel" && <p className="text-xs">Hook and script are edited in the full editor.</p>}
        {notice && <p className={infoBox} data-testid="scheduled-notice">{notice}</p>}
        {error && <p className={errorBox} role="alert">{error}</p>}
        {conflict && (
          <div className={warnBox} role="alert" data-testid="caption-conflict">
            <p className="font-medium">This post was changed by someone else.</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold">Their caption</p>
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-200 bg-white p-2 text-xs">{conflict.theirs || "(empty)"}</p>
              </div>
              <div>
                <p className="text-xs font-semibold">Your text</p>
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-200 bg-white p-2 text-xs">{text || "(empty)"}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={btn}
                onClick={() => {
                  setText(conflict.theirs);
                  setOriginal(conflict.theirs);
                  setExpected(conflict.updatedAt);
                  setConflict(null);
                }}
              >
                Use theirs
              </button>
              <button
                type="button"
                className={btnPrimary}
                onClick={() => {
                  const at = conflict.updatedAt;
                  setExpected(at);
                  setConflict(null);
                  void save(at);
                }}
              >
                Keep mine and save
              </button>
            </div>
          </div>
        )}
        <div>
          <label htmlFor="f-caption-edit" className="text-xs font-medium">Caption</label>
          <textarea id="f-caption-edit" value={text} rows={rows} onChange={(e) => setText(e.target.value)} className={`${input} [field-sizing:content]`} autoFocus />
          <p className="mt-1 text-[11px]">{text.length} characters</p>
        </div>
        <p className="text-[11px]">Hashtags from the subtopic and products are added automatically when posted, so you do not need to type them.</p>
        {(hits.avoid.length > 0 || hits.risky.length > 0) && (
          <div className={warnBox} data-testid="caption-hits">
            <p className="font-medium">Words to review:</p>
            {hits.avoid.length > 0 && <p>Avoid list: {hits.avoid.map((h) => `“${h.phrase}”`).join(", ")}</p>}
            {hits.risky.length > 0 && <p>Watch words: {hits.risky.map((h) => `“${h.phrase}”`).join(", ")}</p>}
          </div>
        )}
        <details className="rounded-md border border-zinc-200 p-2">
          <summary className="cursor-pointer text-xs font-medium">Preview final caption</summary>
          <p className="mt-2 whitespace-pre-wrap text-xs" data-testid="final-caption-preview">{finalCaption || "(empty)"}</p>
        </details>
        <div>
          <p className="text-xs font-semibold">Previous versions</p>
          {versions === null ? (
            <p className="text-xs">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="text-xs">No earlier versions.</p>
          ) : (
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto" data-testid="caption-versions">
              {versions.map((v) => (
                <li key={v.id} className="flex items-start justify-between gap-2 rounded border border-zinc-200 p-1 text-xs">
                  <span>
                    <span className="font-medium">{v.changed_by_name ?? "Unknown"}</span>, {new Date(v.changed_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}: {v.caption.slice(0, 80)}
                    {v.caption.length > 80 ? "…" : ""}
                  </span>
                  <button type="button" className={btn} onClick={() => { setText(v.caption); setRestored(v.caption); }}>Restore</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {confirmClose ? (
          <div className={`${warnBox} flex flex-wrap items-center justify-between gap-2`} role="alert">
            <span>Discard your changes?</span>
            <span className="flex gap-2">
              <button type="button" className={btn} onClick={() => setConfirmClose(false)}>Keep editing</button>
              <button type="button" className={btnPrimary} onClick={onClose}>Discard</button>
            </span>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" className={`${btn} ${touch}`} onClick={requestClose}>Cancel</button>
            <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => void save()} disabled={busy || !!conflict}>{busy ? "Saving…" : "Save"}</button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
