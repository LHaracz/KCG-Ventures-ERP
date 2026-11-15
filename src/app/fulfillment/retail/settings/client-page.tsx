"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { BackToRetail, ErrorSummary, Select, TextArea, TextField, btnPrimary, card, errorBox, infoBox } from "@/components/retail/RetailUi";
import { fetchRetail, saveSettingsApi, RetailApiError } from "@/lib/retail/client";
import { formatInvoiceNumber, nyYear } from "@/lib/retail/invoiceNumber";
import { NET_DAY_CHOICES } from "@/lib/retail/terms";
import { PAYMENT_INSTRUCTIONS_HINT, type Business, type InvoiceSettings } from "@/lib/retail/types";
import { validateSettings } from "@/lib/retail/validation";
import type { RetailBootstrap } from "@/lib/retail/service";

export default function RetailSettingsPage() {
  return (
    <AuthGuard>
      <SettingsInner />
    </AuthGuard>
  );
}

function SettingsInner() {
  const { user } = useSupabase();
  const [data, setData] = useState<RetailBootstrap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await fetchRetail();
      setData(next);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    void load();
  }, [user, load]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 text-black">
      <BackToRetail />
      <div>
        <h1 className="text-2xl font-semibold text-black">Invoice settings</h1>
        <p className="text-sm text-black">
          Invoice numbering, where retailers send payment, default terms and tax for each business. The letterhead (name, address, logo and accent color) comes from the business profile on{" "}
          <Link href="/inventory/purchase-orders/settings" className="text-black underline">
            Purchase Order settings
          </Link>
          .
        </p>
      </div>
      {loadError && (
        <p className={errorBox} role="alert">
          {loadError}
        </p>
      )}
      {!data && !loadError && <p className="text-xs text-black">Loading…</p>}
      {data &&
        data.businesses
          .filter((b) => !b.archived_at)
          .map((b) => {
            const s = data.settings.find((x) => x.company_profile_id === b.id);
            return s ? <BusinessSettings key={b.id} business={b} settings={s} onSaved={load} /> : null;
          })}
    </div>
  );
}

type Draft = Record<string, string>;
const toDraft = (s: InvoiceSettings): Draft => ({
  invoice_prefix: s.invoice_prefix,
  payable_to: s.payable_to ?? "",
  remit_line1: s.remit_line1 ?? "",
  remit_line2: s.remit_line2 ?? "",
  remit_city: s.remit_city ?? "",
  remit_state: s.remit_state ?? "",
  remit_zip: s.remit_zip ?? "",
  remit_country: s.remit_country ?? "",
  payment_instructions: s.payment_instructions ?? "",
  default_terms_type: s.default_terms_type,
  default_net_days: String(s.default_net_days),
  default_tax_rate_percent: String(Number(s.default_tax_rate_percent)),
  footer_note: s.footer_note ?? "",
  product_scope: s.product_scope,
});

function BusinessSettings({ business, settings, onSaved }: { business: Business; settings: InvoiceSettings; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (v: string) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const e = (k: string) => errors[k];

  const save = async () => {
    setMessage(null);
    const body = { ...draft, default_net_days: Number(draft.default_net_days) };
    const v = validateSettings(body);
    if (!v.ok) {
      setErrors(v.errors);
      setMessage("Please fix the highlighted fields.");
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await saveSettingsApi(business.id, body);
      setSaved(true);
      onSaved();
    } catch (err) {
      const x = err as RetailApiError;
      setMessage(x.message);
      if (x.fields) setErrors(x.fields);
    } finally {
      setBusy(false);
    }
  };

  const prefix = draft.invoice_prefix.toUpperCase();
  const example = /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(prefix) ? formatInvoiceNumber(prefix, nyYear(), 1) : "—";
  const netCustom = !NET_DAY_CHOICES.map(String).includes(draft.default_net_days);

  return (
    <section className={`${card} space-y-4`} aria-labelledby={`biz-${business.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`biz-${business.id}`} className="text-lg font-semibold">
            {business.display_name}
          </h2>
          <p className="text-xs">Legal name: {business.legal_name}</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs">Saved.</span>}
          <button type="button" className={btnPrimary} onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
      <ErrorSummary message={message} errors={errors} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          name={`${business.id}-prefix`}
          label="Invoice number prefix"
          value={draft.invoice_prefix}
          onChange={(v) => set("invoice_prefix")(v.toUpperCase())}
          required
          error={e("invoice_prefix")}
          hint={`Next numbers look like ${example}. Numbers count up per prefix and year and are never reused. Changing the prefix does not renumber old invoices.`}
        />
        <Select
          name={`${business.id}-scope`}
          label="Products offered on this business's invoices"
          value={draft.product_scope}
          onChange={set("product_scope")}
          options={[
            { value: "botaniqals", label: "BotanIQals products" },
            { value: "minileaf", label: "MiniLeaf products (microgreens)" },
            { value: "all", label: "All products" },
          ]}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Payment</legend>
        <TextField name={`${business.id}-payable`} label="Make checks payable to" value={draft.payable_to} onChange={set("payable_to")} error={e("payable_to")} hint={`Leave blank to use ${business.legal_name}.`} />
        <p className="text-xs font-medium">Mail checks to (leave blank to hide)</p>
        <TextField name={`${business.id}-r1`} label="Address line 1" value={draft.remit_line1} onChange={set("remit_line1")} error={e("remit_line1")} />
        <TextField name={`${business.id}-r2`} label="Address line 2" value={draft.remit_line2} onChange={set("remit_line2")} error={e("remit_line2")} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <TextField name={`${business.id}-rc`} label="City" value={draft.remit_city} onChange={set("remit_city")} error={e("remit_city")} />
          <TextField name={`${business.id}-rs`} label="State" value={draft.remit_state} onChange={set("remit_state")} error={e("remit_state")} />
          <TextField name={`${business.id}-rz`} label="ZIP" value={draft.remit_zip} onChange={set("remit_zip")} error={e("remit_zip")} />
          <TextField name={`${business.id}-rco`} label="Country" value={draft.remit_country} onChange={set("remit_country")} error={e("remit_country")} />
        </div>
        <TextArea name={`${business.id}-pi`} label="Payment instructions" value={draft.payment_instructions} onChange={set("payment_instructions")} rows={3} error={e("payment_instructions")} hint={PAYMENT_INSTRUCTIONS_HINT} />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Defaults for new invoices</legend>
        <p className={infoBox}>Used when a retailer has no terms of its own for {business.display_name}. Consignment is set per retailer, never as a business default.</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Select
            name={`${business.id}-dt`}
            label="Default payment terms"
            value={draft.default_terms_type}
            onChange={set("default_terms_type")}
            options={[
              { value: "net", label: "Net (days)" },
              { value: "due_on_receipt", label: "Due on receipt" },
              { value: "due_on_delivery", label: "Due on delivery" },
              { value: "prepaid", label: "Prepaid" },
            ]}
            error={e("default_terms_type")}
          />
          {draft.default_terms_type === "net" ? (
            <div>
              <Select
                name={`${business.id}-dn`}
                label="Default net days"
                value={netCustom ? "custom" : draft.default_net_days}
                onChange={(v) => set("default_net_days")(v === "custom" ? "" : v)}
                options={[...NET_DAY_CHOICES.map((n) => ({ value: String(n), label: `Net ${n}` })), { value: "custom", label: "Other…" }]}
                error={netCustom ? undefined : e("default_net_days")}
              />
              {netCustom && <TextField name={`${business.id}-dnc`} label="Days (1 to 180)" value={draft.default_net_days} onChange={(v) => set("default_net_days")(v.replace(/[^\d]/g, ""))} inputMode="numeric" error={e("default_net_days")} />}
            </div>
          ) : (
            <div />
          )}
          <TextField name={`${business.id}-tax`} label="Default sales tax rate (%)" value={draft.default_tax_rate_percent} onChange={set("default_tax_rate_percent")} inputMode="decimal" error={e("default_tax_rate_percent")} hint="Tax-exempt retailers and consignment invoices start at 0." />
        </div>
      </fieldset>

      <TextArea name={`${business.id}-footer`} label="Footer note (prints at the bottom of every page)" value={draft.footer_note} onChange={set("footer_note")} rows={2} error={e("footer_note")} hint="Optional. Prints under the “Questions about this invoice?” line, which uses the business email." />
    </section>
  );
}
