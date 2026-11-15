"use client";

/**
 * Shared Retail UI pieces (Admin only): field inputs, the payment terms
 * editor used by the retailer editor and the invoice form, address fields
 * and small badges. All text is black.
 */
import { type ReactNode } from "react";
import Link from "next/link";
import { btn, btnPrimary, btnDanger, linkBtn } from "@/components/procurement/ProcurementUi";
import {
  NET_DAY_CHOICES,
  DEFAULT_DAYS_TO_PAY,
  retailerSharePercent,
  termsLabel,
  type ConsignmentSchedule,
  type Terms,
  type TermsStart,
  type TermsType,
} from "@/lib/retail/terms";
import { CONSIGNMENT_EXTRA_HINT } from "@/lib/retail/types";
import type { Address } from "@/lib/retail/types";

export { btn, btnPrimary, btnDanger, linkBtn };
export { Dialog, ConfirmDialog } from "@/components/procurement/ProcurementForms";

export const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-600 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:bg-zinc-100";
export const labelCls = "mb-1 block text-xs font-medium text-black";
export const card = "rounded-md border border-zinc-200 bg-white p-4 text-black shadow-sm";
export const errorBox = "rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800";
export const warnBox = "rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-black";
export const infoBox = "rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs text-black";

export function FieldError({ msg }: { msg?: string | null }) {
  return msg ? (
    <p className="mt-1 text-[11px] text-red-700" role="alert">
      {msg}
    </p>
  ) : null;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] text-black">{children}</p>;
}

export function TextField({
  name,
  label,
  value,
  onChange,
  error,
  type = "text",
  required,
  placeholder,
  hint,
  disabled,
  inputMode,
  className,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  type?: string;
  required?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  disabled?: boolean;
  inputMode?: "decimal" | "numeric" | "text";
  className?: string;
}) {
  const id = `f-${name}`;
  return (
    <div className={className}>
      <label htmlFor={id} className={labelCls}>
        {label}
        {required ? <span className="text-red-700"> *</span> : null}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        aria-invalid={!!error}
        className={`${input} ${error ? "border-red-500" : ""}`}
      />
      {hint ? <Hint>{hint}</Hint> : null}
      <FieldError msg={error} />
    </div>
  );
}

export function TextArea({
  name,
  label,
  value,
  onChange,
  error,
  hint,
  rows = 3,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  hint?: ReactNode;
  rows?: number;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <textarea id={id} name={name} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} className={`${input} ${error ? "border-red-500" : ""}`} />
      {hint ? <Hint>{hint}</Hint> : null}
      <FieldError msg={error} />
    </div>
  );
}

export function Select({
  name,
  label,
  value,
  onChange,
  options,
  error,
  required,
  hint,
  disabled,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  error?: string | null;
  required?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
        {required ? <span className="text-red-700"> *</span> : null}
      </label>
      <select id={id} name={name} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-invalid={!!error} className={`${input} ${error ? "border-red-500" : ""}`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <Hint>{hint}</Hint> : null}
      <FieldError msg={error} />
    </div>
  );
}

export function Checkbox({ name, label, checked, onChange, hint }: { name: string; label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <div>
      <label className="inline-flex items-center gap-2 text-xs text-black">
        <input type="checkbox" name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 rounded border-zinc-400 text-emerald-600" />
        {label}
      </label>
      {hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "amber" | "red" | "emerald" | "blue" }) {
  const ring = { zinc: "bg-zinc-100 ring-zinc-300", amber: "bg-amber-100 ring-amber-400", red: "bg-red-100 ring-red-400", emerald: "bg-emerald-100 ring-emerald-500", blue: "bg-sky-100 ring-sky-400" }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium text-black ring-1 ${ring}`}>{children}</span>;
}

export function RetailTabs({ tab }: { tab: "retailers" | "invoices" }) {
  const cls = (on: boolean) => `border-b-2 px-3 py-2 text-sm font-medium text-black ${on ? "border-emerald-600" : "border-transparent hover:border-zinc-300"}`;
  return (
    <div className="flex gap-1 border-b border-zinc-200" role="tablist">
      <Link href="/fulfillment/retail" role="tab" aria-selected={tab === "retailers"} className={cls(tab === "retailers")}>
        Retailers
      </Link>
      <Link href="/fulfillment/retail?tab=invoices" role="tab" aria-selected={tab === "invoices"} className={cls(tab === "invoices")}>
        Invoices
      </Link>
    </div>
  );
}

export function BackToRetail({ tab }: { tab?: "retailers" | "invoices" }) {
  return (
    <Link href={tab === "invoices" ? "/fulfillment/retail?tab=invoices" : "/fulfillment/retail"} className={linkBtn}>
      ← Back to Retail
    </Link>
  );
}

// --- Payment terms editor --------------------------------------------------------------------
/** Form state for terms. "default" (retailer editor only) means "use the business default". */
export type TermsDraft = {
  terms_type: TermsType | "default";
  net_days: string;
  terms_start: TermsStart;
  share: string;
  schedule: ConsignmentSchedule | "";
  days_to_pay: string;
  extra: string;
};

export const BLANK_TERMS_DRAFT: TermsDraft = { terms_type: "default", net_days: "30", terms_start: "invoice_date", share: "", schedule: "", days_to_pay: String(DEFAULT_DAYS_TO_PAY), extra: "" };

export function termsToDraft(t: Terms | null | undefined): TermsDraft {
  if (!t) return { ...BLANK_TERMS_DRAFT };
  return {
    terms_type: t.terms_type,
    net_days: t.net_days ? String(t.net_days) : "30",
    terms_start: t.terms_start ?? "invoice_date",
    share: t.consignment_our_share_percent === null || t.consignment_our_share_percent === undefined ? "" : String(Number(t.consignment_our_share_percent)),
    schedule: t.consignment_schedule ?? "",
    days_to_pay: t.consignment_days_to_pay ? String(t.consignment_days_to_pay) : String(DEFAULT_DAYS_TO_PAY),
    extra: t.consignment_extra_terms ?? "",
  };
}

/** What the server expects (validateTerms). "default" stays { terms_type: "default" }. */
export function draftToTerms(d: TermsDraft): Record<string, unknown> {
  if (d.terms_type === "default") return { terms_type: "default" };
  return {
    terms_type: d.terms_type,
    net_days: d.terms_type === "net" ? d.net_days : null,
    terms_start: d.terms_type === "net" ? d.terms_start : "invoice_date",
    consignment_our_share_percent: d.terms_type === "consignment" ? d.share : null,
    consignment_schedule: d.terms_type === "consignment" ? d.schedule || null : null,
    consignment_days_to_pay: d.terms_type === "consignment" ? d.days_to_pay : null,
    consignment_extra_terms: d.terms_type === "consignment" ? d.extra : null,
  };
}

const TYPE_OPTIONS: Array<{ value: TermsType; label: string }> = [
  { value: "net", label: "Net (days)" },
  { value: "due_on_receipt", label: "Due on receipt" },
  { value: "due_on_delivery", label: "Due on delivery" },
  { value: "prepaid", label: "Prepaid (payment due before delivery)" },
  { value: "consignment", label: "Consignment" },
];

/**
 * Terms fields. With defaultLabel, offers "Use business default (…)" first.
 * Errors are looked up as `${errorPrefix}${field}`.
 */
export function TermsFields({
  idPrefix,
  draft,
  onChange,
  errors,
  errorPrefix = "",
  defaultLabel,
}: {
  idPrefix: string;
  draft: TermsDraft;
  onChange: (d: TermsDraft) => void;
  errors: Record<string, string>;
  errorPrefix?: string;
  defaultLabel?: string;
}) {
  const set = (patch: Partial<TermsDraft>) => onChange({ ...draft, ...patch });
  const err = (k: string) => errors[`${errorPrefix}${k}`];
  const options = [...(defaultLabel ? [{ value: "default", label: `Use business default (${defaultLabel})` }] : []), ...TYPE_OPTIONS];
  const keeps = retailerSharePercent(/^\d+(\.\d{1,2})?$/.test(draft.share) && Number(draft.share) > 0 && Number(draft.share) < 100 ? draft.share : null);
  const netCustom = !NET_DAY_CHOICES.includes(Number(draft.net_days) as (typeof NET_DAY_CHOICES)[number]);
  return (
    <div className="space-y-2">
      <Select name={`${idPrefix}-type`} label="Payment terms" value={draft.terms_type} onChange={(v) => set({ terms_type: v as TermsDraft["terms_type"] })} options={options} error={err("terms_type")} />
      {draft.terms_type === "net" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor={`f-${idPrefix}-net`} className={labelCls}>
              Net days
            </label>
            <div className="flex gap-1">
              <select
                id={`f-${idPrefix}-net`}
                value={netCustom ? "custom" : draft.net_days}
                onChange={(e) => set({ net_days: e.target.value === "custom" ? "" : e.target.value })}
                className={input}
              >
                {NET_DAY_CHOICES.map((n) => (
                  <option key={n} value={String(n)}>
                    Net {n}
                  </option>
                ))}
                <option value="custom">Other…</option>
              </select>
              {netCustom && (
                <input
                  aria-label="Net days (1 to 180)"
                  value={draft.net_days}
                  onChange={(e) => set({ net_days: e.target.value.replace(/[^\d]/g, "") })}
                  inputMode="numeric"
                  placeholder="Days"
                  className={`${input} w-20`}
                />
              )}
            </div>
            <FieldError msg={err("net_days")} />
          </div>
          <Select
            name={`${idPrefix}-start`}
            label="Days count from"
            value={draft.terms_start}
            onChange={(v) => set({ terms_start: v as TermsStart })}
            options={[
              { value: "invoice_date", label: "Invoice date" },
              { value: "delivery_date", label: "Delivery date" },
            ]}
          />
        </div>
      )}
      {draft.terms_type === "consignment" && (
        <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <TextField
              name={`${idPrefix}-share`}
              label="Our share of retail price (%)"
              value={draft.share}
              onChange={(v) => set({ share: v.replace(/[^\d.]/g, "") })}
              inputMode="decimal"
              required
              error={err("consignment_our_share_percent")}
              hint={keeps ? <span className="font-medium">Retailer keeps {keeps}%</span> : "Greater than 0 and less than 100."}
            />
            <Select
              name={`${idPrefix}-schedule`}
              label="Settlement schedule"
              value={draft.schedule}
              onChange={(v) => set({ schedule: v as ConsignmentSchedule | "" })}
              required
              options={[
                { value: "", label: "Choose…" },
                { value: "biweekly", label: "Every two weeks" },
                { value: "monthly", label: "Monthly" },
              ]}
              error={err("consignment_schedule")}
            />
            <TextField
              name={`${idPrefix}-days`}
              label="Days to pay after each statement"
              value={draft.days_to_pay}
              onChange={(v) => set({ days_to_pay: v.replace(/[^\d]/g, "") })}
              inputMode="numeric"
              required
              error={err("consignment_days_to_pay")}
            />
          </div>
          <TextArea name={`${idPrefix}-extra`} label="Extra consignment terms (optional)" value={draft.extra} onChange={(v) => set({ extra: v })} rows={2} hint={CONSIGNMENT_EXTRA_HINT} error={err("consignment_extra_terms")} />
        </div>
      )}
    </div>
  );
}

export const termsDraftLabel = (d: TermsDraft) => (d.terms_type === "default" ? "Business default" : termsLabel({ terms_type: d.terms_type, net_days: Number(d.net_days) || null }));

// --- Addresses ----------------------------------------------------------------------------------
export function AddressFields({
  prefix,
  title,
  value,
  onChange,
  errors,
  withContact,
}: {
  prefix: string;
  title: string;
  value: Address;
  onChange: (a: Address) => void;
  errors: Record<string, string>;
  withContact?: boolean;
}) {
  const set = (patch: Partial<Address>) => onChange({ ...value, ...patch });
  const e = (k: string) => errors[`${prefix}.${k}`];
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-semibold text-black">{title}</legend>
      <TextField name={`${prefix}-name`} label="Name" value={value.name} onChange={(v) => set({ name: v })} required error={e("name")} />
      {withContact && <TextField name={`${prefix}-contact`} label="Attention (contact)" value={value.contact_name ?? ""} onChange={(v) => set({ contact_name: v })} error={e("contact_name")} />}
      <TextField name={`${prefix}-line1`} label="Address line 1" value={value.line1} onChange={(v) => set({ line1: v })} required error={e("line1")} />
      <TextField name={`${prefix}-line2`} label="Address line 2" value={value.line2} onChange={(v) => set({ line2: v })} error={e("line2")} />
      <div className="grid grid-cols-3 gap-2">
        <TextField name={`${prefix}-city`} label="City" value={value.city} onChange={(v) => set({ city: v })} required error={e("city")} />
        <TextField name={`${prefix}-state`} label="State" value={value.state} onChange={(v) => set({ state: v })} required error={e("state")} />
        <TextField name={`${prefix}-zip`} label="ZIP" value={value.zip} onChange={(v) => set({ zip: v })} required error={e("zip")} />
      </div>
      <TextField name={`${prefix}-country`} label="Country" value={value.country} onChange={(v) => set({ country: v })} error={e("country")} />
      {withContact && (
        <div className="grid grid-cols-2 gap-2">
          <TextField name={`${prefix}-phone`} label="Phone" value={value.phone ?? ""} onChange={(v) => set({ phone: v })} error={e("phone")} />
          <TextField name={`${prefix}-email`} label="Email" type="email" value={value.email ?? ""} onChange={(v) => set({ email: v })} error={e("email")} />
        </div>
      )}
    </fieldset>
  );
}

/** A list of field errors at the top of a form (each links to its field when it can). */
export function ErrorSummary({ message, errors }: { message?: string | null; errors: Record<string, string> }) {
  const entries = Object.entries(errors);
  if (!message && entries.length === 0) return null;
  return (
    <div className={errorBox} role="alert">
      {message ? <p className="font-medium">{message}</p> : null}
      {entries.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {entries.map(([k, m]) => (
            <li key={k}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
