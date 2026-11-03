"use client";

/**
 * Small shared UI pieces for the Pick List, Shipping Assignments, the
 * Fulfillments list and the order detail Packaging card. All text is black;
 * times are America/New_York.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { fulfillmentStatusBadge, type FulfillmentStatus } from "@/lib/fulfillmentStatus";
import { formatNyDateTime } from "@/lib/nyTime";
import type { EffectivePackage } from "@/lib/packagingEngine";
import type { LoaderMeta } from "@/lib/fulfillmentOrdersLoader";
import type { StagingBox } from "@/lib/warehouse";

export const flaggedBadgeClassName =
  "inline-flex items-center rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white";

export const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-black placeholder:text-zinc-600 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

export const primaryButton =
  "rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButton =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-black shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
export const dangerButton =
  "rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";

export function StatusBadge({ status, isFlagged, flaggedReason }: { status: FulfillmentStatus; isFlagged?: boolean; flaggedReason?: string | null }) {
  if (isFlagged) {
    return (
      <span className={flaggedBadgeClassName} title={flaggedReason ?? undefined}>
        Flagged
      </span>
    );
  }
  const badge = fulfillmentStatusBadge(status);
  return <span className={badge.className}>{badge.label}</span>;
}

/** Suggested/effective package, with the reason on hover. */
export function PackageBadge({ pkg, showOverridden = true }: { pkg: EffectivePackage; showOverridden?: boolean }) {
  const needsReview = pkg.key === "needs_review";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        title={pkg.reason}
        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
          needsReview ? "bg-amber-100 text-black ring-1 ring-amber-400" : "bg-emerald-100 text-black ring-1 ring-emerald-400"
        }`}
      >
        {pkg.label}
      </span>
      {showOverridden && pkg.overridden && (
        <span
          title={`Original suggestion: ${pkg.suggestionLabel}${pkg.suggestion.reason ? ` (${pkg.suggestion.reason})` : ""}`}
          className="inline-flex rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-black"
        >
          Overridden
        </span>
      )}
    </span>
  );
}

export function LastUpdatedNote({ meta }: { meta: LoaderMeta | null | undefined }) {
  if (!meta) return null;
  const when = meta.lastRefreshedAt ? formatNyDateTime(meta.lastRefreshedAt) : "never";
  if (meta.error) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-black" role="status">
        {meta.throttled ? "Shopify is busy (rate limited)" : "Couldn't reach Shopify"}, showing orders as of{" "}
        <strong>{when}</strong>. This retries automatically about once a minute.
      </p>
    );
  }
  return <p className="text-xs text-black">Orders last updated from Shopify: {when}</p>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4 text-black shadow-lg">
        <h2 id={titleId} className="text-sm font-semibold text-black">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

/**
 * Searchable staging box dropdown. Every active box is listed; boxes in use
 * are shown disabled as "STG-4 (in use: #2551)". Typing "12" jumps to STG-12.
 */
export function BoxPicker({
  boxes,
  value,
  onChange,
  disabled,
  ownOrderId,
  label = "Staging box",
}: {
  boxes: StagingBox[];
  value: string | null;
  onChange: (boxId: string | null) => void;
  disabled?: boolean;
  ownOrderId?: string;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => boxes.filter((b) => !b.archived), [boxes]);
  const selected = active.find((b) => b.id === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^stg-?/, "");
    if (!q) return active;
    const exact = active.filter((b) => String(b.boxNumber) === q);
    const starts = active.filter((b) => String(b.boxNumber).startsWith(q) && String(b.boxNumber) !== q);
    const contains = active.filter((b) => !String(b.boxNumber).startsWith(q) && b.label.toLowerCase().includes(q));
    return [...exact, ...starts, ...contains];
  }, [active, query]);

  const isUsable = (b: StagingBox) => !b.inUseByOrderId || b.inUseByOrderId === ownOrderId;

  useEffect(() => {
    setHighlight(Math.max(0, filtered.findIndex(isUsable)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (b: StagingBox) => {
    if (!isUsable(b)) return;
    onChange(b.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <input
        type="text"
        inputMode="numeric"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        value={open ? query : selected?.label ?? ""}
        placeholder={selected ? selected.label : "Choose box…"}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(filtered.length - 1, h + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const b = filtered[highlight];
            if (b) choose(b);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={`${inputClassName} disabled:cursor-not-allowed disabled:bg-zinc-100`}
      />
      {selected && !open && !disabled && (
        <button
          type="button"
          aria-label="Clear box"
          onClick={() => onChange(null)}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1.5 text-sm text-black hover:bg-zinc-100"
        >
          ×
        </button>
      )}
      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-zinc-300 bg-white py-1 text-sm shadow-lg"
        >
          {filtered.length === 0 && <li className="px-3 py-2 text-black">No matching box</li>}
          {filtered.map((b, i) => {
            const usable = isUsable(b);
            return (
              <li
                key={b.id}
                role="option"
                aria-selected={b.id === value}
                aria-disabled={!usable}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(b);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`px-3 py-2 ${
                  usable ? "cursor-pointer text-black" : "cursor-not-allowed bg-zinc-50 text-black opacity-60"
                } ${i === highlight && usable ? "bg-emerald-50" : ""}`}
              >
                {b.label}
                {!usable && ` (in use: ${b.inUseByOrderName ?? ""})`}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
