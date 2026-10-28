"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/components/InstantProvider";
import {
  fetchActiveCompanyProfiles,
  type CompanyProfile,
} from "@/lib/companyProfiles";
import {
  createPurchaseOrder,
  updatePurchaseOrder,
  previewTotals,
  formatMoney,
  fetchPurchaseOrderPdfBlob,
  triggerBrowserDownload,
  EMPTY_SHIP_TO,
  EMPTY_PO_LINE,
  PAYMENT_TERMS_OPTIONS,
  SHIPPING_METHOD_OPTIONS,
  FREIGHT_TERMS_OPTIONS,
  type ShipTo,
  type PoLineInput,
  type PoFormPayload,
  type PurchaseOrderWithLines,
} from "@/lib/purchaseOrders";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const labelClassName = "mb-1 block text-xs font-medium text-zinc-800";
const sectionHeadingClassName = "text-xs font-semibold uppercase tracking-wide text-zinc-500";

type Draft = {
  company_profile_id: string;
  order_date: string;
  needed_by_date: string;
  vendor_name: string;
  vendor_contact_name: string;
  vendor_email: string;
  vendor_phone: string;
  vendor_account_number: string;
  vendor_address_line1: string;
  vendor_address_line2: string;
  vendor_city: string;
  vendor_state: string;
  vendor_zip: string;
  vendor_country: string;
  ship_to: ShipTo;
  payment_terms: string;
  shipping_method: string;
  freight_terms: string;
  reference_number: string;
  prepared_by_name: string;
  authorized_by_name: string;
  authorized_by_title: string;
  buyer_phone: string;
  buyer_email: string;
  shipping_cost: string;
  tax_exempt: boolean;
  tax_rate_percent: string;
  special_instructions: string;
  terms_text: string;
  notes_to_vendor: string;
  internal_notes: string;
  lines: PoLineInput[];
  refresh_company_snapshot: boolean;
};

const today = () => new Date().toISOString().slice(0, 10);

function emptyDraft(): Draft {
  return {
    company_profile_id: "",
    order_date: today(),
    needed_by_date: "",
    vendor_name: "",
    vendor_contact_name: "",
    vendor_email: "",
    vendor_phone: "",
    vendor_account_number: "",
    vendor_address_line1: "",
    vendor_address_line2: "",
    vendor_city: "",
    vendor_state: "",
    vendor_zip: "",
    vendor_country: "",
    ship_to: { ...EMPTY_SHIP_TO },
    payment_terms: "",
    shipping_method: "",
    freight_terms: "",
    reference_number: "",
    prepared_by_name: "",
    authorized_by_name: "",
    authorized_by_title: "",
    buyer_phone: "",
    buyer_email: "",
    shipping_cost: "0",
    tax_exempt: false,
    tax_rate_percent: "0",
    special_instructions: "",
    terms_text: "",
    notes_to_vendor: "",
    internal_notes: "",
    lines: [{ ...EMPTY_PO_LINE }],
    refresh_company_snapshot: false,
  };
}

/** Applies a business profile's defaults onto a draft — used on initial load (new PO) and when the user confirms re-applying after switching businesses. Vendor info, dates, and line items are never touched. */
function applyProfileDefaults(draft: Draft, profile: CompanyProfile): Draft {
  return {
    ...draft,
    company_profile_id: profile.id,
    payment_terms: profile.default_payment_terms ?? draft.payment_terms,
    shipping_method: profile.default_shipping_method ?? draft.shipping_method,
    freight_terms: profile.default_freight_terms ?? draft.freight_terms,
    prepared_by_name: profile.default_buyer_name ?? draft.prepared_by_name,
    authorized_by_name: profile.default_buyer_name ?? draft.authorized_by_name,
    authorized_by_title: profile.default_buyer_title ?? draft.authorized_by_title,
    buyer_phone: profile.default_buyer_phone ?? draft.buyer_phone,
    buyer_email: profile.default_buyer_email ?? draft.buyer_email,
    special_instructions: profile.default_special_instructions ?? draft.special_instructions,
    terms_text: profile.default_terms_text ?? draft.terms_text,
    ship_to: { ...EMPTY_SHIP_TO, ...profile.ship_to_default },
  };
}

function draftFromExistingPo(po: PurchaseOrderWithLines): Draft {
  return {
    company_profile_id: po.company_profile_id,
    order_date: po.order_date,
    needed_by_date: po.needed_by_date,
    vendor_name: po.vendor_name,
    vendor_contact_name: po.vendor_contact_name ?? "",
    vendor_email: po.vendor_email ?? "",
    vendor_phone: po.vendor_phone ?? "",
    vendor_account_number: po.vendor_account_number ?? "",
    vendor_address_line1: po.vendor_address_line1,
    vendor_address_line2: po.vendor_address_line2 ?? "",
    vendor_city: po.vendor_city,
    vendor_state: po.vendor_state,
    vendor_zip: po.vendor_zip,
    vendor_country: po.vendor_country,
    ship_to: { ...EMPTY_SHIP_TO, ...po.ship_to },
    payment_terms: po.payment_terms,
    shipping_method: po.shipping_method,
    freight_terms: po.freight_terms,
    reference_number: po.reference_number ?? "",
    prepared_by_name: po.prepared_by_name,
    authorized_by_name: po.authorized_by_name,
    authorized_by_title: po.authorized_by_title,
    buyer_phone: po.buyer_phone,
    buyer_email: po.buyer_email,
    shipping_cost: String(po.shipping_cost ?? 0),
    tax_exempt: po.tax_exempt,
    tax_rate_percent: String(po.tax_rate_percent ?? 0),
    special_instructions: po.special_instructions ?? "",
    terms_text: po.terms_text,
    notes_to_vendor: po.notes_to_vendor ?? "",
    internal_notes: po.internal_notes ?? "",
    lines:
      po.po_lines.length > 0
        ? po.po_lines.map((l) => ({
            item_number: l.item_number ?? "",
            description: l.description,
            quantity: String(l.quantity),
            unit: l.unit,
            unit_price: String(l.unit_price),
          }))
        : [{ ...EMPTY_PO_LINE }],
    refresh_company_snapshot: false,
  };
}

/** Pre-fills a new PO from an existing one for "Duplicate" — same business/vendor/lines/terms, but today's order date and a blank needed-by date and reference number, since those are specific to the new order. */
function draftFromDuplicateSource(source: PurchaseOrderWithLines): Draft {
  const base = draftFromExistingPo(source);
  return { ...base, order_date: today(), needed_by_date: "", reference_number: "" };
}

function draftToPayload(draft: Draft): PoFormPayload {
  return {
    company_profile_id: draft.company_profile_id,
    order_date: draft.order_date,
    needed_by_date: draft.needed_by_date,
    vendor_name: draft.vendor_name.trim(),
    vendor_contact_name: draft.vendor_contact_name.trim(),
    vendor_email: draft.vendor_email.trim(),
    vendor_phone: draft.vendor_phone.trim(),
    vendor_account_number: draft.vendor_account_number.trim(),
    vendor_address_line1: draft.vendor_address_line1.trim(),
    vendor_address_line2: draft.vendor_address_line2.trim(),
    vendor_city: draft.vendor_city.trim(),
    vendor_state: draft.vendor_state.trim(),
    vendor_zip: draft.vendor_zip.trim(),
    vendor_country: draft.vendor_country.trim(),
    ship_to: draft.ship_to,
    payment_terms: draft.payment_terms.trim(),
    shipping_method: draft.shipping_method.trim(),
    freight_terms: draft.freight_terms.trim(),
    reference_number: draft.reference_number.trim(),
    prepared_by_name: draft.prepared_by_name.trim(),
    authorized_by_name: draft.authorized_by_name.trim(),
    authorized_by_title: draft.authorized_by_title.trim(),
    buyer_phone: draft.buyer_phone.trim(),
    buyer_email: draft.buyer_email.trim(),
    shipping_cost: draft.shipping_cost,
    tax_exempt: draft.tax_exempt,
    tax_rate_percent: draft.tax_rate_percent,
    special_instructions: draft.special_instructions.trim(),
    terms_text: draft.terms_text,
    notes_to_vendor: draft.notes_to_vendor.trim(),
    internal_notes: draft.internal_notes.trim(),
    lines: draft.lines.map((l) => ({ ...l, item_number: l.item_number.trim(), description: l.description.trim(), unit: l.unit.trim() })),
    refresh_company_snapshot: draft.refresh_company_snapshot,
  };
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className={labelClassName}>
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClassName}
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <div>
      <label className={labelClassName}>{label}</label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className={`${inputClassName} leading-relaxed`} />
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

/** A <select> seeded with a standard option list, always including the current value even if custom, plus "Other" to type a one-off value. */
function SelectWithOther({
  label,
  value,
  onChange,
  options,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  required?: boolean;
}) {
  const OTHER = "__other__";
  const isKnown = options.includes(value) || value === "";
  const [customMode, setCustomMode] = useState(!isKnown);

  const selectValue = customMode ? OTHER : value || "";

  return (
    <div>
      <label className={labelClassName}>
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      {!customMode ? (
        <select
          value={selectValue}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setCustomMode(true);
              onChange("");
            } else {
              onChange(e.target.value);
            }
          }}
          className={inputClassName}
        >
          <option value="" disabled>
            Select…
          </option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
      ) : (
        <div className="flex gap-1">
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Custom value" className={inputClassName} />
          <button
            type="button"
            onClick={() => setCustomMode(false)}
            className="whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Choose from list
          </button>
        </div>
      )}
    </div>
  );
}

export function PurchaseOrderForm({
  mode,
  poId,
  initialPo,
  duplicateFromPo,
}: {
  mode: "create" | "edit";
  poId?: string;
  initialPo?: PurchaseOrderWithLines | null;
  duplicateFromPo?: PurchaseOrderWithLines | null;
}) {
  const router = useRouter();
  const { supabase } = useSupabase();
  const [profiles, setProfiles] = useState<CompanyProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingProfileSwitch, setPendingProfileSwitch] = useState<CompanyProfile | null>(null);
  const [saving, setSaving] = useState<"save" | "save-download" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchActiveCompanyProfiles(supabase);
        setProfiles(data);
        if (mode === "edit" && initialPo) {
          setDraft(draftFromExistingPo(initialPo));
        } else if (mode === "create" && duplicateFromPo) {
          setDraft(draftFromDuplicateSource(duplicateFromPo));
        } else if (data.length > 0) {
          setDraft(applyProfileDefaults(emptyDraft(), data[0]));
        } else {
          setDraft(emptyDraft());
        }
      } catch (err: any) {
        setSaveError(err.message || "Failed to load business profiles.");
        setDraft(emptyDraft());
      } finally {
        setLoadingProfiles(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(
    () => (draft ? previewTotals(draft.lines, draft.shipping_cost, draft.tax_exempt, draft.tax_rate_percent) : { subtotal: 0, taxAmount: 0, total: 0 }),
    [draft],
  );

  const hasAnyEnteredDetails = (d: Draft) =>
    d.vendor_name.trim() !== "" ||
    d.payment_terms.trim() !== "" ||
    d.shipping_method.trim() !== "" ||
    d.freight_terms.trim() !== "" ||
    d.prepared_by_name.trim() !== "" ||
    d.lines.some((l) => l.description.trim() !== "");

  const handleBusinessChange = (profileId: string) => {
    if (!draft) return;
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    if (hasAnyEnteredDetails(draft) && profile.id !== draft.company_profile_id) {
      setPendingProfileSwitch(profile);
    } else {
      setDraft(applyProfileDefaults(draft, profile));
    }
  };

  const confirmApplyDefaults = () => {
    if (!draft || !pendingProfileSwitch) return;
    setDraft(applyProfileDefaults(draft, pendingProfileSwitch));
    setPendingProfileSwitch(null);
  };

  const keepCurrentJustSwitchBusiness = () => {
    if (!draft || !pendingProfileSwitch) return;
    setDraft({ ...draft, company_profile_id: pendingProfileSwitch.id });
    setPendingProfileSwitch(null);
  };

  const updateLine = (index: number, patch: Partial<PoLineInput>) => {
    setDraft((d) => (d ? { ...d, lines: d.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) } : d));
  };
  const addLine = () => setDraft((d) => (d && d.lines.length < 100 ? { ...d, lines: [...d.lines, { ...EMPTY_PO_LINE }] } : d));
  const removeLine = (index: number) =>
    setDraft((d) => (d && d.lines.length > 1 ? { ...d, lines: d.lines.filter((_, i) => i !== index) } : d));

  const updateShipTo = (patch: Partial<ShipTo>) => setDraft((d) => (d ? { ...d, ship_to: { ...d.ship_to, ...patch } } : d));

  const validate = (d: Draft): string | null => {
    if (!d.company_profile_id) return "A business is required.";
    if (!d.order_date) return "Order date is required.";
    if (!d.needed_by_date) return "Needed-by date is required.";
    if (!d.vendor_name.trim()) return "Vendor name is required.";
    if (!d.vendor_address_line1.trim()) return "Vendor address is required.";
    if (!d.vendor_city.trim()) return "Vendor city is required.";
    if (!d.vendor_state.trim()) return "Vendor state/region is required.";
    if (!d.vendor_zip.trim()) return "Vendor zip/postal code is required.";
    if (!d.vendor_country.trim()) return "Vendor country is required.";
    if (!d.payment_terms.trim()) return "Payment terms are required.";
    if (!d.shipping_method.trim()) return "Shipping method is required.";
    if (!d.freight_terms.trim()) return "Freight terms are required.";
    if (!d.prepared_by_name.trim()) return "Prepared by is required.";
    if (!d.authorized_by_name.trim()) return "Authorized by is required.";
    if (!d.authorized_by_title.trim()) return "Authorized-by title is required.";
    if (!d.buyer_phone.trim()) return "Buyer phone is required.";
    if (!d.buyer_email.trim()) return "Buyer email is required.";
    if (!d.ship_to.name.trim()) return "Ship-to name is required.";
    if (!d.ship_to.address_line1.trim()) return "Ship-to address is required.";
    if (!d.ship_to.city.trim()) return "Ship-to city is required.";
    if (!d.ship_to.state.trim()) return "Ship-to state is required.";
    if (!d.ship_to.zip.trim()) return "Ship-to zip is required.";
    if (!d.ship_to.country.trim()) return "Ship-to country is required.";
    if (d.lines.length === 0) return "At least one line item is required.";
    for (let i = 0; i < d.lines.length; i++) {
      const line = d.lines[i];
      if (!line.description.trim()) return `Line ${i + 1}: description is required.`;
      if (!line.unit.trim()) return `Line ${i + 1}: unit is required.`;
      const qty = Number(line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) return `Line ${i + 1}: quantity must be greater than 0.`;
      const price = Number(line.unit_price);
      if (!Number.isFinite(price) || price <= 0) return `Line ${i + 1}: unit price must be greater than 0.`;
    }
    return null;
  };

  const handleSave = async (alsoDownload: boolean) => {
    if (!draft) return;
    setSaveError(null);
    const validationError = validate(draft);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(alsoDownload ? "save-download" : "save");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Unable to verify your session.");

      const payload = draftToPayload(draft);
      const result =
        mode === "edit" && poId ? await updatePurchaseOrder(token, poId, payload) : await createPurchaseOrder(token, payload);

      if (alsoDownload) {
        try {
          const blob = await fetchPurchaseOrderPdfBlob(token, result.id, "attachment");
          triggerBrowserDownload(blob, `${result.po_number}.pdf`);
        } catch (downloadErr: any) {
          // The save itself already succeeded — stay put and say so rather than silently navigating past the error.
          setSaving(null);
          setSaveError(
            `Saved as ${result.po_number}, but generating the PDF failed (${downloadErr.message || "unknown error"}). You can download it from the purchase order's page.`,
          );
          return;
        }
      }
      router.push(`/inventory/purchase-orders/${result.id}`);
    } catch (err: any) {
      setSaveError(err.message || "Failed to save this purchase order.");
      setSaving(null);
    }
  };

  if (loadingProfiles || !draft) {
    return <p className="text-xs text-black">Loading…</p>;
  }

  if (profiles.length === 0) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
        No business profiles are set up yet.{" "}
        <a href="/inventory/purchase-orders/settings" className="underline">
          Add one in Purchase Order settings
        </a>{" "}
        before creating a PO.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {saveError && (
        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700" role="alert">
          {saveError}
        </p>
      )}

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <p className={sectionHeadingClassName}>Business &amp; dates</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className={labelClassName}>
              Business <span className="text-red-600">*</span>
            </label>
            <select value={draft.company_profile_id} onChange={(e) => handleBusinessChange(e.target.value)} className={inputClassName}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </div>
          <Field label="Order date" type="date" required value={draft.order_date} onChange={(v) => setDraft((d) => (d ? { ...d, order_date: v } : d))} />
          <Field
            label="Needed-by date"
            type="date"
            required
            value={draft.needed_by_date}
            onChange={(v) => setDraft((d) => (d ? { ...d, needed_by_date: v } : d))}
          />
        </div>
        {mode === "edit" && (
          <label className="mt-3 flex items-center gap-1.5 text-xs text-black">
            <input
              type="checkbox"
              checked={draft.refresh_company_snapshot}
              onChange={(e) => setDraft((d) => (d ? { ...d, refresh_company_snapshot: e.target.checked } : d))}
              className="h-3.5 w-3.5"
            />
            Update company details (logo, address, accent color) from the current business profile
          </label>
        )}
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <p className={sectionHeadingClassName}>Vendor</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Vendor name" required value={draft.vendor_name} onChange={(v) => setDraft((d) => (d ? { ...d, vendor_name: v } : d))} />
          <Field
            label="Vendor account #"
            value={draft.vendor_account_number}
            onChange={(v) => setDraft((d) => (d ? { ...d, vendor_account_number: v } : d))}
          />
          <Field
            label="Contact name"
            value={draft.vendor_contact_name}
            onChange={(v) => setDraft((d) => (d ? { ...d, vendor_contact_name: v } : d))}
          />
          <Field label="Phone" value={draft.vendor_phone} onChange={(v) => setDraft((d) => (d ? { ...d, vendor_phone: v } : d))} />
          <Field label="Email" value={draft.vendor_email} onChange={(v) => setDraft((d) => (d ? { ...d, vendor_email: v } : d))} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            label="Address line 1"
            required
            value={draft.vendor_address_line1}
            onChange={(v) => setDraft((d) => (d ? { ...d, vendor_address_line1: v } : d))}
          />
          <Field
            label="Address line 2"
            value={draft.vendor_address_line2}
            onChange={(v) => setDraft((d) => (d ? { ...d, vendor_address_line2: v } : d))}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label="City" required value={draft.vendor_city} onChange={(v) => setDraft((d) => (d ? { ...d, vendor_city: v } : d))} />
          <Field label="State" required value={draft.vendor_state} onChange={(v) => setDraft((d) => (d ? { ...d, vendor_state: v } : d))} />
          <Field label="ZIP" required value={draft.vendor_zip} onChange={(v) => setDraft((d) => (d ? { ...d, vendor_zip: v } : d))} />
          <Field label="Country" required value={draft.vendor_country} onChange={(v) => setDraft((d) => (d ? { ...d, vendor_country: v } : d))} />
        </div>
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <p className={sectionHeadingClassName}>Ship to</p>
        <label className="mt-3 flex items-center gap-1.5 text-xs text-black">
          <input
            type="checkbox"
            checked={draft.ship_to.same_as_bill_to}
            onChange={(e) => updateShipTo({ same_as_bill_to: e.target.checked })}
            className="h-3.5 w-3.5"
          />
          Ship to the business's own letterhead address
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Ship-to name" required value={draft.ship_to.name} onChange={(v) => updateShipTo({ name: v })} />
          <Field label="Contact name" value={draft.ship_to.contact_name} onChange={(v) => updateShipTo({ contact_name: v })} />
          <Field label="Phone" value={draft.ship_to.phone} onChange={(v) => updateShipTo({ phone: v })} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Address line 1" required value={draft.ship_to.address_line1} onChange={(v) => updateShipTo({ address_line1: v })} />
          <Field label="Address line 2" value={draft.ship_to.address_line2} onChange={(v) => updateShipTo({ address_line2: v })} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label="City" required value={draft.ship_to.city} onChange={(v) => updateShipTo({ city: v })} />
          <Field label="State" required value={draft.ship_to.state} onChange={(v) => updateShipTo({ state: v })} />
          <Field label="ZIP" required value={draft.ship_to.zip} onChange={(v) => updateShipTo({ zip: v })} />
          <Field label="Country" required value={draft.ship_to.country} onChange={(v) => updateShipTo({ country: v })} />
        </div>
        <div className="mt-3">
          <TextAreaField
            label="Delivery instructions"
            rows={2}
            value={draft.ship_to.delivery_instructions}
            onChange={(v) => updateShipTo({ delivery_instructions: v })}
          />
        </div>
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <p className={sectionHeadingClassName}>Terms &amp; reference</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <SelectWithOther
            label="Payment terms"
            required
            value={draft.payment_terms}
            onChange={(v) => setDraft((d) => (d ? { ...d, payment_terms: v } : d))}
            options={PAYMENT_TERMS_OPTIONS}
          />
          <SelectWithOther
            label="Shipping method"
            required
            value={draft.shipping_method}
            onChange={(v) => setDraft((d) => (d ? { ...d, shipping_method: v } : d))}
            options={SHIPPING_METHOD_OPTIONS}
          />
          <SelectWithOther
            label="Freight terms"
            required
            value={draft.freight_terms}
            onChange={(v) => setDraft((d) => (d ? { ...d, freight_terms: v } : d))}
            options={FREIGHT_TERMS_OPTIONS}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field
            label="Reference # (vendor quote, etc.)"
            value={draft.reference_number}
            onChange={(v) => setDraft((d) => (d ? { ...d, reference_number: v } : d))}
          />
          <Field
            label="Shipping cost"
            type="number"
            value={draft.shipping_cost}
            onChange={(v) => setDraft((d) => (d ? { ...d, shipping_cost: v } : d))}
          />
          <div>
            <label className={labelClassName}>Tax rate %</label>
            <input
              type="number"
              disabled={draft.tax_exempt}
              value={draft.tax_rate_percent}
              onChange={(e) => setDraft((d) => (d ? { ...d, tax_rate_percent: e.target.value } : d))}
              className={`${inputClassName} disabled:bg-zinc-100 disabled:text-zinc-400`}
            />
          </div>
        </div>
        <label className="mt-3 flex items-center gap-1.5 text-xs text-black">
          <input
            type="checkbox"
            checked={draft.tax_exempt}
            onChange={(e) => setDraft((d) => (d ? { ...d, tax_exempt: e.target.checked } : d))}
            className="h-3.5 w-3.5"
          />
          Tax exempt
        </label>
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <p className={sectionHeadingClassName}>Prepared &amp; authorized by</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Prepared by" required value={draft.prepared_by_name} onChange={(v) => setDraft((d) => (d ? { ...d, prepared_by_name: v } : d))} />
          <Field
            label="Authorized by"
            required
            value={draft.authorized_by_name}
            onChange={(v) => setDraft((d) => (d ? { ...d, authorized_by_name: v } : d))}
          />
          <Field
            label="Authorized-by title"
            required
            value={draft.authorized_by_title}
            onChange={(v) => setDraft((d) => (d ? { ...d, authorized_by_title: v } : d))}
          />
          <Field label="Buyer phone" required value={draft.buyer_phone} onChange={(v) => setDraft((d) => (d ? { ...d, buyer_phone: v } : d))} />
          <Field label="Buyer email" required value={draft.buyer_email} onChange={(v) => setDraft((d) => (d ? { ...d, buyer_email: v } : d))} />
        </div>
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <p className={sectionHeadingClassName}>Line items</p>
          <button
            type="button"
            onClick={addLine}
            disabled={draft.lines.length >= 100}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Add line
          </button>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-zinc-50 text-[11px] text-zinc-500">
              <tr>
                <th className="px-2 py-1 font-medium">Item #</th>
                <th className="px-2 py-1 font-medium">Description</th>
                <th className="px-2 py-1 font-medium">Qty</th>
                <th className="px-2 py-1 font-medium">Unit</th>
                <th className="px-2 py-1 font-medium">Unit price</th>
                <th className="px-2 py-1 font-medium">Line total</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((line, i) => {
                const qty = Number(line.quantity);
                const price = Number(line.unit_price);
                const lineTotal = Number.isFinite(qty) && Number.isFinite(price) && qty > 0 && price > 0 ? qty * price : 0;
                return (
                  <tr key={i} className="border-b border-zinc-100">
                    <td className="px-2 py-1">
                      <input value={line.item_number} onChange={(e) => updateLine(i, { item_number: e.target.value })} className={`${inputClassName} w-24`} />
                    </td>
                    <td className="px-2 py-1 min-w-[180px]">
                      <input value={line.description} onChange={(e) => updateLine(i, { description: e.target.value })} className={inputClassName} />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={line.quantity}
                        onChange={(e) => updateLine(i, { quantity: e.target.value })}
                        className={`${inputClassName} w-20`}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input value={line.unit} onChange={(e) => updateLine(i, { unit: e.target.value })} className={`${inputClassName} w-20`} placeholder="ea, lb…" />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={line.unit_price}
                        onChange={(e) => updateLine(i, { unit_price: e.target.value })}
                        className={`${inputClassName} w-24`}
                      />
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-zinc-700">{formatMoney(lineTotal)}</td>
                    <td className="px-2 py-1">
                      <button
                        type="button"
                        onClick={() => removeLine(i)}
                        disabled={draft.lines.length <= 1}
                        className="text-red-600 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="Remove line"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 ml-auto max-w-xs space-y-1 text-xs text-zinc-700">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatMoney(totals.subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span>Shipping</span>
            <span>{formatMoney(Number(draft.shipping_cost) || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Tax{draft.tax_exempt ? " (exempt)" : ""}</span>
            <span>{formatMoney(totals.taxAmount)}</span>
          </div>
          <div className="flex justify-between border-t border-zinc-200 pt-1 text-sm font-semibold text-zinc-900">
            <span>Total</span>
            <span>{formatMoney(totals.total)}</span>
          </div>
          <p className="text-[10px] text-zinc-400">Preview only — the saved total is always recomputed server-side.</p>
        </div>
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <div className="space-y-4">
          <TextAreaField
            label="Special instructions"
            rows={4}
            value={draft.special_instructions}
            onChange={(v) => setDraft((d) => (d ? { ...d, special_instructions: v } : d))}
          />
          <TextAreaField
            label="Terms &amp; conditions"
            rows={6}
            value={draft.terms_text}
            onChange={(v) => setDraft((d) => (d ? { ...d, terms_text: v } : d))}
          />
          <TextAreaField
            label="Notes to vendor (printed on the PO)"
            rows={2}
            value={draft.notes_to_vendor}
            onChange={(v) => setDraft((d) => (d ? { ...d, notes_to_vendor: v } : d))}
          />
          <TextAreaField
            label="Internal notes (not printed on the PO)"
            rows={2}
            value={draft.internal_notes}
            onChange={(v) => setDraft((d) => (d ? { ...d, internal_notes: v } : d))}
          />
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push("/inventory/purchase-orders")}
          disabled={saving !== null}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => handleSave(true)}
          disabled={saving !== null}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving === "save-download" ? "Saving…" : "Save & Download"}
        </button>
        <button
          type="button"
          onClick={() => handleSave(false)}
          disabled={saving !== null}
          className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving === "save" ? "Saving…" : mode === "edit" ? "Save changes" : "Create purchase order"}
        </button>
      </div>

      {pendingProfileSwitch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPendingProfileSwitch(null)}>
          <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-zinc-900">Apply {pendingProfileSwitch.display_name}'s defaults?</h2>
            <p className="mt-2 text-xs text-zinc-700">
              This will overwrite payment/shipping/freight terms, buyer info, ship-to, special instructions, and terms &amp; conditions with{" "}
              {pendingProfileSwitch.display_name}'s defaults. Vendor info and line items are never touched.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={keepCurrentJustSwitchBusiness}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
              >
                Keep current values
              </button>
              <button
                type="button"
                onClick={confirmApplyDefaults}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Apply defaults
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
