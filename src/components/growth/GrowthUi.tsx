"use client";

/**
 * Shared Marketing & Sales UI: re-uses the Retail form controls and adds
 * URL tabs, risk badges and a date formatter. All text is black.
 */
import Link from "next/link";
import { type ReactNode } from "react";
import { formatLongDate, formatShortDate } from "@/lib/retail/format";
import { RISK_LABEL, type LaunchRisk } from "@/lib/growth/tasks";

export {
  Badge,
  Checkbox,
  ConfirmDialog,
  Dialog,
  ErrorSummary,
  FieldError,
  Hint,
  Select,
  TextArea,
  TextField,
  btn,
  btnDanger,
  btnPrimary,
  card,
  errorBox,
  infoBox,
  input,
  labelCls,
  linkBtn,
  warnBox,
} from "@/components/retail/RetailUi";

export const fmtDate = (d: string | null | undefined) => (d ? formatShortDate(d) : "—");
export const fmtLongDate = (d: string | null | undefined) => (d ? formatLongDate(d) : "—");

export function UrlTabs<T extends string>({ base, tabs, current, param = "tab" }: { base: string; tabs: Array<{ key: T; label: string }>; current: T; param?: string }) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-zinc-200" role="tablist">
      {tabs.map((t, i) => (
        <Link
          key={t.key}
          href={i === 0 ? base : `${base}${base.includes("?") ? "&" : "?"}${param}=${t.key}`}
          role="tab"
          aria-selected={current === t.key}
          data-testid={`tab-${t.key}`}
          className={`border-b-2 px-3 py-2 text-sm font-medium text-black ${current === t.key ? "border-emerald-600" : "border-transparent hover:border-zinc-300"}`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

export function RiskBadge({ risk }: { risk: LaunchRisk }) {
  const cls = { on_track: "bg-emerald-100 ring-emerald-500", at_risk: "bg-amber-100 ring-amber-400", late: "bg-red-100 ring-red-400" }[risk];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium text-black ring-1 ${cls}`} data-testid="risk-badge">{RISK_LABEL[risk]}</span>;
}

export function Chip({ tone, children }: { tone: "green" | "amber" | "red" | "blue" | "zinc"; children: ReactNode }) {
  const cls = { green: "bg-emerald-100 ring-emerald-500", amber: "bg-amber-100 ring-amber-400", red: "bg-red-100 ring-red-400", blue: "bg-sky-100 ring-sky-400", zinc: "bg-zinc-100 ring-zinc-300" }[tone];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium text-black ring-1 ${cls}`}>{children}</span>;
}

/** A plain fixed-height scrollable card for Dashboard widgets. */
export function WidgetCard({ title, href, children }: { title: string; href: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 text-black shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-black">{title}</h2>
        <Link href={href} className="text-xs font-medium text-black underline">
          Open
        </Link>
      </div>
      <div className="h-[320px] overflow-y-auto">{children}</div>
    </section>
  );
}
