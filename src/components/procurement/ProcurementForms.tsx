"use client";

/**
 * Procurement forms and dialogs: the supplier fields, the supplier editor,
 * the add/edit supplier-for-an-ingredient modal, a confirm dialog and the
 * "Create PO for shortages" modal. Inputs are checked in the browser with
 * the same rules the server uses (src/lib/procurement/validation.ts), and
 * every save goes through /api/procurement.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  addEquipmentLinkApi,
  addLinkApi,
  archiveCategoryApi,
  archiveEquipmentApi,
  createCategoryApi,
  createEquipmentApi,
  createSupplierApi,
  ProcurementApiError,
  renameCategoryApi,
  reorderCategoriesApi,
  updateEquipmentApi,
  updateEquipmentLinkApi,
  updateLinkApi,
  updateSupplierApi,
} from "@/lib/procurement/client";
import {
  COA_POLICIES,
  NOTES_HINT,
  PAYMENT_METHODS,
  SUPPLIER_PAYMENT_TERMS,
  type EquipmentCategory,
  type EquipmentItem,
  type Supplier,
} from "@/lib/procurement/types";
import {
  validateCategoryName,
  validateEquipment,
  validateEquipmentLink,
  validateLink,
  validateSupplier,
  type EquipmentLinkValues,
  type Errors,
  type LinkValues,
  type SupplierValues,
} from "@/lib/procurement/validation";
import { formatQuantity } from "@/lib/procurement/stockAlert";
import { usageText, type EquipmentLinkWithSupplier, type LinkWithSupplier, type MaterialRow, type ShortageGroup } from "@/lib/procurement/view";
import { StockBadge, btn, btnPrimary, linkBtn } from "./ProcurementUi";

const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-600 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const label = "mb-1 block text-xs font-medium text-black";

export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={`my-8 w-full ${wide ? "max-w-3xl" : "max-w-md"} rounded-md border border-zinc-200 bg-white p-4 text-black shadow-lg`}>
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="text-sm font-semibold text-black">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-sm text-black hover:text-zinc-700">
            ✕
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="space-y-2 text-xs text-black">{children}</div>
      {error && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={btnPrimary} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

function FieldError({ msg }: { msg?: string }) {
  return msg ? (
    <p className="mt-1 text-[11px] text-red-700" role="alert">
      {msg}
    </p>
  ) : null;
}

function Text({
  name,
  text,
  value,
  onChange,
  error,
  type = "text",
  required,
  placeholder,
}: {
  name: string;
  text: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={label}>
        {text} {required && <span className="text-red-700">*</span>}
      </label>
      <input id={id} name={name} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={input} aria-invalid={!!error} />
      <FieldError msg={error} />
    </div>
  );
}

function Notes({ name, text, value, onChange, error }: { name: string; text: string; value: string; onChange: (v: string) => void; error?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={label}>
        {text}
      </label>
      <textarea id={id} name={name} rows={2} value={value} onChange={(e) => onChange(e.target.value)} className={input} aria-invalid={!!error} />
      <p className="mt-1 text-[11px] text-black">{NOTES_HINT}</p>
      <FieldError msg={error} />
    </div>
  );
}

// --- Supplier fields ------------------------------------------------------------
export type SupplierDraft = {
  name: string;
  website_url: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  account_number: string;
  payment_methods: string[];
  payment_notes: string;
  ordering_notes: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  default_po_payment_terms: string;
};

export function supplierToDraft(s?: Supplier | null): SupplierDraft {
  return {
    name: s?.name ?? "",
    website_url: s?.website_url ?? "",
    contact_name: s?.contact_name ?? "",
    contact_email: s?.contact_email ?? "",
    contact_phone: s?.contact_phone ?? "",
    account_number: s?.account_number ?? "",
    payment_methods: [...(s?.payment_methods ?? [])],
    payment_notes: s?.payment_notes ?? "",
    ordering_notes: s?.ordering_notes ?? "",
    address_line1: s?.address_line1 ?? "",
    address_line2: s?.address_line2 ?? "",
    city: s?.city ?? "",
    state: s?.state ?? "",
    zip: s?.zip ?? "",
    country: s?.country ?? "",
    default_po_payment_terms: s?.default_po_payment_terms ?? "",
  };
}

export function SupplierFields({ draft, onChange, errors }: { draft: SupplierDraft; onChange: (d: SupplierDraft) => void; errors: Errors }) {
  const set = (patch: Partial<SupplierDraft>) => onChange({ ...draft, ...patch });
  const addressHasError = ["address_line1", "address_line2", "city", "state", "zip", "country", "default_po_payment_terms"].some((k) => errors[k]);
  const [poOpen, setPoOpen] = useState(addressHasError);
  const toggleMethod = (m: string) =>
    set({ payment_methods: draft.payment_methods.includes(m) ? draft.payment_methods.filter((x) => x !== m) : [...draft.payment_methods, m] });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Text name="name" text="Supplier name" required value={draft.name} onChange={(v) => set({ name: v })} error={errors.name} />
        <Text name="website_url" text="Website" placeholder="https://" value={draft.website_url} onChange={(v) => set({ website_url: v })} error={errors.website_url} />
        <Text name="contact_name" text="Contact name" value={draft.contact_name} onChange={(v) => set({ contact_name: v })} error={errors.contact_name} />
        <Text name="contact_email" text="Contact email" type="email" value={draft.contact_email} onChange={(v) => set({ contact_email: v })} error={errors.contact_email} />
        <Text name="contact_phone" text="Contact phone" value={draft.contact_phone} onChange={(v) => set({ contact_phone: v })} error={errors.contact_phone} />
        <Text name="account_number" text="Account number" value={draft.account_number} onChange={(v) => set({ account_number: v })} error={errors.account_number} />
      </div>
      <fieldset>
        <legend className={label}>Payment methods</legend>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Payment methods">
          {PAYMENT_METHODS.map((m) => {
            const on = draft.payment_methods.includes(m.value);
            return (
              <button
                key={m.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggleMethod(m.value)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium text-black ring-1 ${on ? "bg-sky-200 ring-sky-500" : "bg-white ring-zinc-300 hover:bg-zinc-50"}`}
              >
                {on ? "✓ " : ""}
                {m.label}
              </button>
            );
          })}
        </div>
        <FieldError msg={errors.payment_methods} />
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Notes name="payment_notes" text="Payment notes" value={draft.payment_notes} onChange={(v) => set({ payment_notes: v })} error={errors.payment_notes} />
        <Notes name="ordering_notes" text="Ordering notes" value={draft.ordering_notes} onChange={(v) => set({ ordering_notes: v })} error={errors.ordering_notes} />
      </div>
      <div className="rounded-md border border-zinc-200">
        <button type="button" onClick={() => setPoOpen((o) => !o)} aria-expanded={poOpen || addressHasError} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-black">
          <span>Purchase order details</span>
          <span aria-hidden="true">{poOpen || addressHasError ? "▾" : "▸"}</span>
        </button>
        {(poOpen || addressHasError) && (
          <div className="space-y-3 border-t border-zinc-200 px-3 py-3">
            <p className="text-[11px] text-black">Filled in once, used to prefill Purchase Orders.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Text name="address_line1" text="Address line 1" value={draft.address_line1} onChange={(v) => set({ address_line1: v })} error={errors.address_line1} />
              <Text name="address_line2" text="Address line 2" value={draft.address_line2} onChange={(v) => set({ address_line2: v })} error={errors.address_line2} />
              <Text name="city" text="City" value={draft.city} onChange={(v) => set({ city: v })} error={errors.city} />
              <Text name="state" text="State or region" value={draft.state} onChange={(v) => set({ state: v })} error={errors.state} />
              <Text name="zip" text="ZIP or postal code" value={draft.zip} onChange={(v) => set({ zip: v })} error={errors.zip} />
              <Text name="country" text="Country" value={draft.country} onChange={(v) => set({ country: v })} error={errors.country} />
            </div>
            <div>
              <label className={label} htmlFor="default-po-terms">
                Default PO payment terms
              </label>
              <select id="default-po-terms" value={draft.default_po_payment_terms} onChange={(e) => set({ default_po_payment_terms: e.target.value })} className={input}>
                <option value="">Use the business default</option>
                {SUPPLIER_PAYMENT_TERMS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <FieldError msg={errors.default_po_payment_terms} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const supplierChanged = (a: SupplierDraft, b: SupplierDraft) => JSON.stringify(a) !== JSON.stringify(b);

function serverFail(e: unknown, setErrors: (e: Errors) => void, setError: (m: string) => void) {
  if (e instanceof ProcurementApiError && e.fields) setErrors(e.fields);
  setError(e instanceof Error ? e.message : "Something went wrong.");
}

// --- Supplier editor (Suppliers page, and supplier names on Procurement) ---------
export function SupplierEditorModal({
  supplier,
  usage,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  usage: SupplierUsage;
  onClose: () => void;
  onSaved: (s: Supplier) => void;
}) {
  const [draft, setDraft] = useState<SupplierDraft>(() => supplierToDraft(supplier));
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    const checked = validateSupplier(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      setError("Check the highlighted fields.");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const res = supplier ? await updateSupplierApi(supplier.id, checked.value) : await createSupplierApi(checked.value);
      onSaved(res.supplier);
    } catch (e) {
      serverFail(e, setErrors, setError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={supplier ? `Edit ${supplier.name}` : "Add supplier"} onClose={onClose} wide>
      {supplier && (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-black" role="note">
          {usageLine(usage, supplier.id)}
        </p>
      )}
      <SupplierFields draft={draft} onChange={setDraft} errors={errors} />
      {error && (
        <p className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className={btnPrimary} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save supplier"}
        </button>
      </div>
    </Dialog>
  );
}

// --- Add or edit a supplier for an ingredient ------------------------------------
type LinkDraft = { product_url: string; supplier_item: string; pack_info: string; coa_policy: string; notes: string; price: string; price_note: string };
type DraftSource = {
  product_url?: string | null;
  supplier_item?: string | null;
  pack_info?: string | null;
  coa_policy?: string | null;
  notes?: string | null;
  price?: number | string | null;
  price_note?: string | null;
};
const linkToDraft = (l?: DraftSource | null): LinkDraft => ({
  product_url: l?.product_url ?? "",
  supplier_item: l?.supplier_item ?? "",
  pack_info: l?.pack_info ?? "",
  coa_policy: l?.coa_policy ?? "unknown",
  notes: l?.notes ?? "",
  price: l?.price === null || l?.price === undefined ? "" : String(Number(l.price)),
  price_note: l?.price_note ?? "",
});

export type SupplierUsage = { materials: ReadonlyMap<string, number>; equipment: ReadonlyMap<string, number> };
const usageLine = (u: SupplierUsage, supplierId: string) => `${usageText(u.materials.get(supplierId) ?? 0, u.equipment.get(supplierId) ?? 0)}. Changes apply to all of them.`;

type AnyListing = LinkWithSupplier | EquipmentLinkWithSupplier;

/**
 * Add or edit a supplier listing, for a raw material or an equipment item.
 * Choosing a supplier lists every active supplier, whichever tab it was
 * first added from, or adds a new one. Raw materials have COA and pack
 * size; equipment has a model or part number and no COA. Both have a price.
 */
export function LinkModal({
  kind,
  target,
  link,
  suppliers,
  usage,
  onClose,
  onSaved,
  cancelLabel = "Cancel",
}: {
  kind: "raw" | "equipment";
  /** The raw material or equipment item, and the suppliers already listed for it. */
  target: { id: string; name: string; takenSupplierIds: readonly string[]; hasListings: boolean };
  /** Editing this listing; null to add a supplier. */
  link: AnyListing | null;
  /** Every supplier (archived ones are hidden from the picker). */
  suppliers: readonly Supplier[];
  usage: SupplierUsage;
  onClose: () => void;
  onSaved: () => void;
  /** "Skip for now" right after adding a new equipment item. */
  cancelLabel?: string;
}) {
  const editing = !!link;
  const taken = useMemo(() => new Set(target.takenSupplierIds), [target.takenSupplierIds]);
  const choices = useMemo(
    () => suppliers.filter((s) => !s.archived_at).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
    [suppliers],
  );
  const [mode, setMode] = useState<"existing" | "new">(choices.length === 0 ? "new" : "existing");
  const [search, setSearch] = useState("");
  const [supplierId, setSupplierId] = useState<string>("");
  const original = useMemo(() => supplierToDraft(link?.supplier ?? null), [link]);
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft>(original);
  const [editSupplier, setEditSupplier] = useState(false);
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(() => linkToDraft(link));
  const [makePreferred, setMakePreferred] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const filtered = choices.filter((s) => s.name.toLowerCase().includes(search.trim().toLowerCase()));
  const setLink = (p: Partial<LinkDraft>) => setLinkDraft((d) => ({ ...d, ...p }));
  const noun = kind === "raw" ? "ingredient" : "equipment item";

  const save = async () => {
    setError(null);
    const lc = kind === "raw" ? validateLink(linkDraft) : validateEquipmentLink(linkDraft);
    const needSupplier = editing ? editSupplier && supplierChanged(supplierDraft, original) : mode === "new";
    const sc = needSupplier ? validateSupplier(supplierDraft) : null;
    const errs: Errors = { ...(lc.ok ? {} : lc.errors), ...(sc && !sc.ok ? sc.errors : {}) };
    if (!editing && mode === "existing" && !supplierId) errs.supplier_id = "Choose a supplier, or add a new one.";
    if (!editing && mode === "existing" && supplierId && taken.has(supplierId)) {
      errs.supplier_id = `This supplier is already listed for this ${noun}. Edit that listing instead.`;
    }
    if (Object.keys(errs).length > 0 || !lc.ok) {
      setErrors(errs);
      setError(errs.supplier_id && Object.keys(errs).length === 1 ? errs.supplier_id : "Check the highlighted fields.");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const supplierValues: SupplierValues | undefined = sc && sc.ok ? sc.value : undefined;
      const supplierPart = mode === "new" ? { new_supplier: supplierValues } : { supplier_id: supplierId };
      if (kind === "raw") {
        const value = lc.value as LinkValues;
        if (editing) await updateLinkApi(link!.id, { link: value, supplier: supplierValues, make_preferred: makePreferred });
        else await addLinkApi({ raw_material_id: target.id, ...supplierPart, link: value, make_preferred: makePreferred });
      } else {
        const value = lc.value as EquipmentLinkValues;
        if (editing) await updateEquipmentLinkApi(link!.id, { link: value, supplier: supplierValues, make_preferred: makePreferred });
        else await addEquipmentLinkApi({ equipment_id: target.id, ...supplierPart, link: value, make_preferred: makePreferred });
      }
      onSaved();
    } catch (e) {
      serverFail(e, setErrors, setError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={editing ? `${link!.supplier.name} for ${target.name}` : `Add a supplier for ${target.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        {!editing && (
          <section className="space-y-2">
            <p className="text-xs font-semibold text-black">1. Supplier</p>
            <div className="flex gap-3 text-xs text-black">
              <label className="flex items-center gap-1">
                <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} disabled={choices.length === 0} />
                Existing supplier
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
                New supplier
              </label>
            </div>
            {mode === "existing" ? (
              <div className="space-y-1">
                <input className={input} placeholder="Search suppliers" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search suppliers" />
                <div className="max-h-40 overflow-y-auto rounded-md border border-zinc-200" role="listbox" aria-label="Suppliers">
                  {filtered.length === 0 ? (
                    <p className="p-2 text-xs text-black">No suppliers match. Choose “New supplier” to add one.</p>
                  ) : (
                    filtered.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        role="option"
                        aria-selected={supplierId === s.id}
                        onClick={() => setSupplierId(s.id)}
                        className={`block w-full px-2 py-1.5 text-left text-xs text-black ${supplierId === s.id ? "bg-emerald-100" : "hover:bg-zinc-50"}`}
                      >
                        {s.name}
                        <span className="ml-1 text-[11px]">({usageText(usage.materials.get(s.id) ?? 0, usage.equipment.get(s.id) ?? 0).replace(/^Used for /, "")})</span>
                        {taken.has(s.id) && <span className="ml-1 text-[11px] font-semibold">Already listed</span>}
                      </button>
                    ))
                  )}
                </div>
                <FieldError msg={errors.supplier_id} />
              </div>
            ) : (
              <SupplierFields draft={supplierDraft} onChange={setSupplierDraft} errors={errors} />
            )}
          </section>
        )}

        {editing && (
          <section className="space-y-2 rounded-md border border-zinc-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-black">Supplier details (shared)</p>
              <button type="button" className={linkBtn} onClick={() => setEditSupplier((v) => !v)} aria-expanded={editSupplier}>
                {editSupplier ? "Hide supplier details" : "Edit supplier details"}
              </button>
            </div>
            {editSupplier && (
              <>
                <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-black" role="note">
                  {usageLine(usage, link!.supplier_id)}
                </p>
                <SupplierFields draft={supplierDraft} onChange={setSupplierDraft} errors={errors} />
              </>
            )}
          </section>
        )}

        <section className="space-y-3">
          <p className="text-xs font-semibold text-black">{editing ? `For this ${noun}` : `2. For ${target.name}`}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Text name="product_url" text="Product link" placeholder="https://" value={linkDraft.product_url} onChange={(v) => setLink({ product_url: v })} error={errors.product_url} />
            <Text
              name="supplier_item"
              text={kind === "raw" ? "Supplier item name" : "Model or part number"}
              value={linkDraft.supplier_item}
              onChange={(v) => setLink({ supplier_item: v })}
              error={errors.supplier_item}
            />
            {kind === "raw" && (
              <>
                <Text name="pack_info" text="Pack size or price note" value={linkDraft.pack_info} onChange={(v) => setLink({ pack_info: v })} error={errors.pack_info} />
                <div>
                  <label className={label} htmlFor="coa-policy">
                    COA policy
                  </label>
                  <select id="coa-policy" className={input} value={linkDraft.coa_policy} onChange={(e) => setLink({ coa_policy: e.target.value })}>
                    {COA_POLICIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <FieldError msg={errors.coa_policy} />
                </div>
              </>
            )}
            <Text name="price" text="Price (USD)" placeholder="12.50" value={linkDraft.price} onChange={(v) => setLink({ price: v })} error={errors.price} />
            <Text name="price_note" text="Price note" placeholder="per 25 kg bag, each" value={linkDraft.price_note} onChange={(v) => setLink({ price_note: v })} error={errors.price_note} />
          </div>
          <Notes name="notes" text="Notes" value={linkDraft.notes} onChange={(v) => setLink({ notes: v })} error={errors.notes} />
          {link?.is_preferred ? (
            <p className="text-xs text-black">★ This is the preferred supplier for {target.name}.</p>
          ) : (
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={makePreferred} onChange={(e) => setMakePreferred(e.target.checked)} />
              Make this the preferred supplier
              {!editing && !target.hasListings && <span>(the first supplier is preferred automatically)</span>}
            </label>
          )}
        </section>

        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose} disabled={saving}>
            {cancelLabel}
          </button>
          <button type="button" className={btnPrimary} onClick={save} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save" : "Add supplier"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Create PO for shortages ------------------------------------------------------
export function ShortagesModal({
  groups,
  noSupplier,
  onCreatePo,
  onAddSupplier,
  onClose,
}: {
  groups: readonly ShortageGroup[];
  noSupplier: readonly MaterialRow[];
  onCreatePo: (supplierId: string, materialIds: string[]) => void;
  onAddSupplier: (row: MaterialRow) => void;
  onClose: () => void;
}) {
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Dialog title="Create PO for shortages" onClose={onClose} wide>
      <p className="mb-3 text-xs text-black">One Purchase Order per supplier. Suggested quantities refill to par and can be changed on the PO form.</p>
      {groups.length === 0 && noSupplier.length === 0 && <p className="text-xs text-black">Nothing is out of stock or below par.</p>}
      <div className="space-y-4">
        {groups.map((g) => {
          const checked = g.items.filter((i) => !unchecked.has(i.row.material.id)).map((i) => i.row.material.id);
          return (
            <section key={g.supplier.id} className="rounded-md border border-zinc-200" data-testid="shortage-group" data-supplier-id={g.supplier.id}>
              <div className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2">
                <p className="text-sm font-semibold text-black">{g.supplier.name}</p>
                <button type="button" className={btnPrimary} disabled={checked.length === 0} onClick={() => onCreatePo(g.supplier.id, checked)}>
                  Create PO
                </button>
              </div>
              <table className="min-w-full text-left text-xs text-black">
                <thead className="text-[11px]">
                  <tr>
                    <th className="w-8 px-3 py-1" aria-label="Include" />
                    <th className="px-2 py-1 font-semibold">Ingredient</th>
                    <th className="px-2 py-1 font-semibold">Stock alert</th>
                    <th className="px-2 py-1 font-semibold">On hand</th>
                    <th className="px-2 py-1 font-semibold">Par</th>
                    <th className="px-2 py-1 font-semibold">Suggested</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map(({ row, suggested }) => (
                    <tr key={row.material.id} className="border-t border-zinc-100">
                      <td className="px-3 py-1">
                        <input
                          type="checkbox"
                          aria-label={`Include ${row.name}`}
                          checked={!unchecked.has(row.material.id)}
                          onChange={() => toggle(row.material.id)}
                        />
                      </td>
                      <td className="px-2 py-1">{row.name}</td>
                      <td className="px-2 py-1">
                        <StockBadge alert={row.alert} />
                      </td>
                      <td className="px-2 py-1">
                        {formatQuantity(row.quantity_on_hand ?? 0)} {row.unit}
                      </td>
                      <td className="px-2 py-1">
                        {formatQuantity(row.par_level) || "—"} {row.par_level ? row.unit : ""}
                      </td>
                      <td className="px-2 py-1">{suggested ? `${suggested} ${row.unit}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
        {noSupplier.length > 0 && (
          <section className="rounded-md border border-amber-300" data-testid="shortage-no-supplier">
            <div className="border-b border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-sm font-semibold text-black">No supplier yet</p>
            </div>
            <ul className="divide-y divide-zinc-100 text-xs text-black">
              {noSupplier.map((row) => (
                <li key={row.material.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="flex items-center gap-2">
                    {row.name} <StockBadge alert={row.alert} />
                  </span>
                  <button type="button" className={linkBtn} onClick={() => onAddSupplier(row)}>
                    {row.links.length === 0 ? "Add supplier" : "Choose a preferred supplier"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" className={btn} onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

// --- Add or edit equipment --------------------------------------------------------------
const NEW_CATEGORY = "__new__";

/**
 * Name, category (with "New category" inline) and description. Edit also
 * offers Archive (the item and its supplier listings; nothing is deleted).
 */
export function EquipmentModal({
  item,
  categories,
  onClose,
  onSaved,
  onArchived,
}: {
  item: EquipmentItem | null;
  /** Active categories, in order. */
  categories: readonly EquipmentCategory[];
  onClose: () => void;
  onSaved: (item: EquipmentItem, created: boolean) => void;
  onArchived: () => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [categoryId, setCategoryId] = useState(item?.category_id ?? categories[0]?.id ?? NEW_CATEGORY);
  const [newCategory, setNewCategory] = useState("");
  const [description, setDescription] = useState(item?.description ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const save = async () => {
    setError(null);
    const errs: Errors = {};
    let catId = categoryId;
    if (categoryId === NEW_CATEGORY) {
      const c = validateCategoryName(newCategory);
      if (!c.ok) errs.category = c.error;
    }
    const checked = validateEquipment({ name, category_id: categoryId === NEW_CATEGORY ? "00000000-0000-4000-8000-000000000000" : categoryId, description });
    if (!checked.ok) Object.assign(errs, checked.errors);
    if (Object.keys(errs).length > 0 || !checked.ok) {
      setErrors(errs);
      setError("Check the highlighted fields.");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (categoryId === NEW_CATEGORY) {
        catId = (await createCategoryApi(newCategory.trim())).category.id;
        setCategoryId(catId);
        setNewCategory("");
      }
      const values = { ...checked.value, category_id: catId };
      const res = item ? await updateEquipmentApi(item.id, values) : await createEquipmentApi(values);
      onSaved(res.equipment, !item);
    } catch (e) {
      serverFail(e, setErrors, setError);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!item) return;
    setSaving(true);
    setError(null);
    try {
      await archiveEquipmentApi(item.id);
      onArchived();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not archive the item.");
      setConfirmArchive(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={item ? `Edit ${item.name}` : "Add equipment"} onClose={onClose}>
      {confirmArchive ? (
        <div className="space-y-3 text-xs text-black">
          <p>Archive {item?.name}? It is hidden from the Equipment tab, and its supplier listings are archived too. Nothing is deleted, and you can restore it with “Show archived”.</p>
          {error && (
            <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={() => setConfirmArchive(false)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className={btnPrimary} onClick={archive} disabled={saving}>
              {saving ? "Working…" : "Archive item"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Text name="name" text="Equipment name" required value={name} onChange={setName} error={errors.name} />
          <div>
            <label className={label} htmlFor="equipment-category">
              Category <span className="text-red-700">*</span>
            </label>
            <select id="equipment-category" className={input} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={NEW_CATEGORY}>+ New category…</option>
            </select>
            <FieldError msg={errors.category_id} />
          </div>
          {categoryId === NEW_CATEGORY && <Text name="new_category" text="New category name" value={newCategory} onChange={setNewCategory} error={errors.category} />}
          <Notes name="description" text="Description or model notes" value={description} onChange={setDescription} error={errors.description} />
          {error && (
            <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            {item ? (
              <button type="button" className={btn} onClick={() => setConfirmArchive(true)} disabled={saving}>
                Archive…
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button type="button" className={btn} onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="button" className={btnPrimary} onClick={save} disabled={saving}>
                {saving ? "Saving…" : item ? "Save" : "Add equipment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// --- Manage categories -------------------------------------------------------------------
export function CategoriesModal({
  categories,
  onClose,
  onChanged,
}: {
  /** Active categories with their active equipment counts, in order. */
  categories: readonly { category: EquipmentCategory; count: number }[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const v = validateCategoryName(adding);
    if (!v.ok) return setError(v.error);
    if (await run(() => createCategoryApi(v.value))) setAdding("");
  };
  const rename = async () => {
    if (!editing) return;
    const v = validateCategoryName(editing.name);
    if (!v.ok) return setError(v.error);
    if (await run(() => renameCategoryApi(editing.id, v.value))) setEditing(null);
  };
  const move = (index: number, delta: number) => {
    const ids = categories.map((c) => c.category.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    void run(() => reorderCategoriesApi(ids));
  };

  return (
    <Dialog title="Manage categories" onClose={onClose}>
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200" data-testid="categories-list">
        {categories.map(({ category: c, count }, i) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5 text-xs text-black" data-testid="category-row">
            {editing?.id === c.id ? (
              <span className="flex flex-1 items-center gap-1">
                <input className={input} value={editing.name} onChange={(e) => setEditing({ id: c.id, name: e.target.value })} aria-label={`New name for ${c.name}`} />
                <button type="button" className={btnPrimary} onClick={rename} disabled={busy}>
                  Save
                </button>
                <button type="button" className={btn} onClick={() => setEditing(null)} disabled={busy}>
                  Cancel
                </button>
              </span>
            ) : (
              <>
                <span>
                  <span className="font-medium">{c.name}</span> <span className="text-[11px]">({count} {count === 1 ? "item" : "items"})</span>
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" className={btn} onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={`Move ${c.name} up`}>
                    ↑
                  </button>
                  <button type="button" className={btn} onClick={() => move(i, 1)} disabled={busy || i === categories.length - 1} aria-label={`Move ${c.name} down`}>
                    ↓
                  </button>
                  <button type="button" className={btn} onClick={() => setEditing({ id: c.id, name: c.name })} disabled={busy}>
                    Rename
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={busy || count > 0}
                    title={count > 0 ? `${count} ${count === 1 ? "item uses" : "items use"} this category. Move them to another category first.` : "Archive this category"}
                    onClick={() => void run(() => archiveCategoryApi(c.id))}
                  >
                    Archive
                  </button>
                </span>
                {count > 0 && (
                  <span className="w-full text-[11px]">
                    {count} {count === 1 ? "item uses" : "items use"} this category
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <input className={input} placeholder="New category name" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="New category name" />
        <button type="button" className={btnPrimary} onClick={add} disabled={busy}>
          Add
        </button>
      </div>
      {error && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <button type="button" className={btn} onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
