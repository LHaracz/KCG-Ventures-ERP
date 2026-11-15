"use client";

/**
 * Add or edit a retailer: name and contact, billing and shipping addresses,
 * tax status, notes, and payment terms for each business (including
 * consignment). Checked in the browser with the server's rules first.
 */
import { useMemo, useState } from "react";
import { createRetailerApi, RetailApiError, updateRetailerApi } from "@/lib/retail/client";
import { termsLabel } from "@/lib/retail/terms";
import { RETAIL_NOTES_HINT, type Business, type InvoiceSettings, type Retailer, type RetailerTermsRow } from "@/lib/retail/types";
import { validateRetailer, validateTermsByBusiness } from "@/lib/retail/validation";
import {
  Checkbox,
  Dialog,
  ErrorSummary,
  TermsFields,
  TextArea,
  TextField,
  btn,
  btnPrimary,
  draftToTerms,
  termsToDraft,
  type TermsDraft,
} from "./RetailUi";

type Draft = Record<string, string | boolean>;

const TEXT_KEYS = [
  "name", "legal_name", "description", "website_url", "contact_name", "contact_email", "contact_phone",
  "billing_line1", "billing_line2", "billing_city", "billing_state", "billing_zip", "billing_country",
  "shipping_name", "shipping_line1", "shipping_line2", "shipping_city", "shipping_state", "shipping_zip", "shipping_country",
  "resale_certificate_number", "notes",
] as const;

function toDraft(r: Retailer | null): Draft {
  const d: Draft = { shipping_same_as_billing: r ? r.shipping_same_as_billing : true, tax_exempt: r ? r.tax_exempt : false };
  for (const k of TEXT_KEYS) d[k] = (r?.[k] as string | null | undefined) ?? "";
  if (!r) d.billing_country = "United States";
  return d;
}

export function defaultTermsText(s: InvoiceSettings | undefined): string {
  if (!s) return "Net 30";
  return termsLabel({ terms_type: s.default_terms_type, net_days: s.default_net_days });
}

export function RetailerEditor({
  retailer,
  businesses,
  settings,
  terms,
  onClose,
  onSaved,
}: {
  retailer: Retailer | null;
  businesses: Business[];
  settings: InvoiceSettings[];
  terms: RetailerTermsRow[];
  onClose: () => void;
  onSaved: (r: Retailer) => void;
}) {
  const active = useMemo(() => businesses.filter((b) => !b.archived_at), [businesses]);
  const [draft, setDraft] = useState<Draft>(() => toDraft(retailer));
  const [termsDrafts, setTermsDrafts] = useState<Record<string, TermsDraft>>(() =>
    Object.fromEntries(active.map((b) => [b.id, termsToDraft(terms.find((t) => t.company_profile_id === b.id) ?? null)])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const s = (k: string) => String(draft[k] ?? "");
  const set = (k: string) => (v: string | boolean) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    setMessage(null);
    const termsPayload = Object.fromEntries(Object.entries(termsDrafts).map(([id, d]) => [id, draftToTerms(d)]));
    const r = validateRetailer(draft);
    const t = validateTermsByBusiness(termsPayload, active.map((b) => b.id));
    const errs = { ...(r.ok ? {} : r.errors), ...(t.ok ? {} : t.errors) };
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      setMessage("Please fix the highlighted fields.");
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = retailer ? await updateRetailerApi(retailer.id, draft, termsPayload) : await createRetailerApi(draft, termsPayload);
      onSaved(res.retailer);
    } catch (e) {
      const err = e as RetailApiError;
      setMessage(err.message);
      if (err.fields) setErrors(err.fields);
    } finally {
      setBusy(false);
    }
  };

  const same = draft.shipping_same_as_billing === true;
  const e = (k: string) => errors[k];
  return (
    <Dialog title={retailer ? `Edit ${retailer.name}` : "Add retailer"} onClose={onClose} wide>
      <div className="space-y-4 text-xs text-black">
        <ErrorSummary message={message} errors={errors} />
        <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <TextField name="name" label="Retailer name" value={s("name")} onChange={set("name")} required error={e("name")} />
          <TextField name="legal_name" label="Legal name (for Bill to)" value={s("legal_name")} onChange={set("legal_name")} error={e("legal_name")} hint="Leave blank to use the retailer name." />
          <TextField name="website_url" label="Website" value={s("website_url")} onChange={set("website_url")} placeholder="https://" error={e("website_url")} />
          <TextField name="contact_name" label="Contact name" value={s("contact_name")} onChange={set("contact_name")} error={e("contact_name")} />
          <TextField name="contact_email" label="Contact email" type="email" value={s("contact_email")} onChange={set("contact_email")} error={e("contact_email")} />
          <TextField name="contact_phone" label="Contact phone" value={s("contact_phone")} onChange={set("contact_phone")} error={e("contact_phone")} />
        </section>
        <TextArea name="description" label="Description" value={s("description")} onChange={set("description")} rows={2} error={e("description")} />

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-black">Billing address</legend>
            <TextField name="billing_line1" label="Address line 1" value={s("billing_line1")} onChange={set("billing_line1")} required error={e("billing_line1")} />
            <TextField name="billing_line2" label="Address line 2" value={s("billing_line2")} onChange={set("billing_line2")} error={e("billing_line2")} />
            <div className="grid grid-cols-3 gap-2">
              <TextField name="billing_city" label="City" value={s("billing_city")} onChange={set("billing_city")} required error={e("billing_city")} />
              <TextField name="billing_state" label="State" value={s("billing_state")} onChange={set("billing_state")} required error={e("billing_state")} />
              <TextField name="billing_zip" label="ZIP" value={s("billing_zip")} onChange={set("billing_zip")} required error={e("billing_zip")} />
            </div>
            <TextField name="billing_country" label="Country" value={s("billing_country")} onChange={set("billing_country")} error={e("billing_country")} />
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-black">Shipping address</legend>
            <Checkbox name="shipping_same_as_billing" label="Same as billing" checked={same} onChange={set("shipping_same_as_billing")} />
            {!same && (
              <>
                <TextField name="shipping_name" label="Ship to name (e.g. receiving dock)" value={s("shipping_name")} onChange={set("shipping_name")} error={e("shipping_name")} />
                <TextField name="shipping_line1" label="Address line 1" value={s("shipping_line1")} onChange={set("shipping_line1")} required error={e("shipping_line1")} />
                <TextField name="shipping_line2" label="Address line 2" value={s("shipping_line2")} onChange={set("shipping_line2")} error={e("shipping_line2")} />
                <div className="grid grid-cols-3 gap-2">
                  <TextField name="shipping_city" label="City" value={s("shipping_city")} onChange={set("shipping_city")} required error={e("shipping_city")} />
                  <TextField name="shipping_state" label="State" value={s("shipping_state")} onChange={set("shipping_state")} required error={e("shipping_state")} />
                  <TextField name="shipping_zip" label="ZIP" value={s("shipping_zip")} onChange={set("shipping_zip")} required error={e("shipping_zip")} />
                </div>
                <TextField name="shipping_country" label="Country" value={s("shipping_country")} onChange={set("shipping_country")} error={e("shipping_country")} />
              </>
            )}
          </fieldset>
        </section>

        <section className="space-y-2">
          <Checkbox name="tax_exempt" label="Tax exempt (resale)" checked={draft.tax_exempt === true} onChange={set("tax_exempt")} hint="New invoices for this retailer start with tax off." />
          {draft.tax_exempt === true && (
            <TextField name="resale_certificate_number" label="Resale certificate number" value={s("resale_certificate_number")} onChange={set("resale_certificate_number")} error={e("resale_certificate_number")} />
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-black">Payment terms by business</h3>
          {active.length === 0 && <p className="text-xs text-black">No businesses yet. Add one on Purchase Order settings.</p>}
          {active.map((b) => (
            <div key={b.id} className="rounded-md border border-zinc-200 p-2">
              <p className="mb-2 text-xs font-medium text-black">{b.display_name}</p>
              <TermsFields
                idPrefix={`terms-${b.id}`}
                draft={termsDrafts[b.id]}
                onChange={(d) => setTermsDrafts((all) => ({ ...all, [b.id]: d }))}
                errors={errors}
                errorPrefix={`terms.${b.id}.`}
                defaultLabel={defaultTermsText(settings.find((x) => x.company_profile_id === b.id))}
              />
            </div>
          ))}
          <p className="text-[11px] text-black">Consignment terms only print on invoices. The ERP does not track consignment stock, sales or settlements.</p>
        </section>

        <TextArea name="notes" label="Internal notes" value={s("notes")} onChange={set("notes")} rows={2} hint={RETAIL_NOTES_HINT} error={e("notes")} />

        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} onClick={save} disabled={busy}>
            {busy ? "Saving…" : retailer ? "Save changes" : "Add retailer"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
