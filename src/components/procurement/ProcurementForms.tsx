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
  addLinkApi,
  createSupplierApi,
  ProcurementApiError,
  updateLinkApi,
  updateSupplierApi,
} from "@/lib/procurement/client";
import { COA_POLICIES, NOTES_HINT, PAYMENT_METHODS, SUPPLIER_PAYMENT_TERMS, type Supplier } from "@/lib/procurement/types";
import {
  EMPTY_LINK,
  validateLink,
  validateSupplier,
  type Errors,
  type LinkValues,
  type SupplierValues,
} from "@/lib/procurement/validation";
import { formatQuantity } from "@/lib/procurement/stockAlert";
import type { LinkWithSupplier, MaterialRow, ShortageGroup } from "@/lib/procurement/view";
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
  usedFor,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  usedFor: number;
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
      {supplier && usedFor > 0 && (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-black" role="note">
          Used for {usedFor} {usedFor === 1 ? "ingredient" : "ingredients"}. Changes apply to all of them.
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
type LinkDraft = { product_url: string; supplier_item: string; pack_info: string; coa_policy: string; notes: string };
const linkToDraft = (l?: LinkValues | null): LinkDraft => ({
  product_url: l?.product_url ?? "",
  supplier_item: l?.supplier_item ?? "",
  pack_info: l?.pack_info ?? "",
  coa_policy: l?.coa_policy ?? "unknown",
  notes: l?.notes ?? "",
});

export function LinkModal({
  row,
  link,
  suppliers,
  usage,
  onClose,
  onSaved,
}: {
  row: MaterialRow;
  /** Editing this link; null to add a supplier. */
  link: LinkWithSupplier | null;
  /** Every supplier (archived ones are hidden from the picker). */
  suppliers: readonly Supplier[];
  usage: ReadonlyMap<string, number>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!link;
  const taken = useMemo(() => new Set(row.links.map((l) => l.supplier_id)), [row.links]);
  const choices = useMemo(
    () => suppliers.filter((s) => !s.archived_at && !taken.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
    [suppliers, taken],
  );
  const [mode, setMode] = useState<"existing" | "new">(choices.length === 0 ? "new" : "existing");
  const [search, setSearch] = useState("");
  const [supplierId, setSupplierId] = useState<string>("");
  const original = useMemo(() => supplierToDraft(link?.supplier ?? null), [link]);
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft>(original);
  const [editSupplier, setEditSupplier] = useState(false);
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(() => linkToDraft(link ?? EMPTY_LINK));
  const [makePreferred, setMakePreferred] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const filtered = choices.filter((s) => s.name.toLowerCase().includes(search.trim().toLowerCase()));
  const setLink = (p: Partial<LinkDraft>) => setLinkDraft((d) => ({ ...d, ...p }));
  const n = link ? (usage.get(link.supplier_id) ?? 0) : 0;

  const save = async () => {
    setError(null);
    const lc = validateLink(linkDraft);
    const needSupplier = editing ? editSupplier && supplierChanged(supplierDraft, original) : mode === "new";
    const sc = needSupplier ? validateSupplier(supplierDraft) : null;
    const errs: Errors = { ...(lc.ok ? {} : lc.errors), ...(sc && !sc.ok ? sc.errors : {}) };
    if (!editing && mode === "existing" && !supplierId) errs.supplier_id = "Choose a supplier, or add a new one.";
    if (Object.keys(errs).length > 0 || !lc.ok) {
      setErrors(errs);
      setError("Check the highlighted fields.");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const supplierValues: SupplierValues | undefined = sc && sc.ok ? sc.value : undefined;
      if (editing) {
        await updateLinkApi(link!.id, { link: lc.value, supplier: supplierValues, make_preferred: makePreferred });
      } else {
        await addLinkApi({
          raw_material_id: row.material.id,
          ...(mode === "new" ? { new_supplier: supplierValues } : { supplier_id: supplierId }),
          link: lc.value,
          make_preferred: makePreferred,
        });
      }
      onSaved();
    } catch (e) {
      serverFail(e, setErrors, setError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={editing ? `${link!.supplier.name} for ${row.name}` : `Add a supplier for ${row.name}`} onClose={onClose} wide>
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
                        <span className="ml-1 text-[11px]">({usage.get(s.id) ?? 0} ingredients)</span>
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
                  Used for {n} {n === 1 ? "ingredient" : "ingredients"}. Changes apply to all of them.
                </p>
                <SupplierFields draft={supplierDraft} onChange={setSupplierDraft} errors={errors} />
              </>
            )}
          </section>
        )}

        <section className="space-y-3">
          <p className="text-xs font-semibold text-black">{editing ? "For this ingredient" : `2. For ${row.name}`}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Text name="product_url" text="Product link" placeholder="https://" value={linkDraft.product_url} onChange={(v) => setLink({ product_url: v })} error={errors.product_url} />
            <Text name="supplier_item" text="Supplier item name" value={linkDraft.supplier_item} onChange={(v) => setLink({ supplier_item: v })} error={errors.supplier_item} />
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
          </div>
          <Notes name="notes" text="Notes" value={linkDraft.notes} onChange={(v) => setLink({ notes: v })} error={errors.notes} />
          {link?.is_preferred ? (
            <p className="text-xs text-black">★ This is the preferred supplier for {row.name}.</p>
          ) : (
            <label className="flex items-center gap-1.5 text-xs text-black">
              <input type="checkbox" checked={makePreferred} onChange={(e) => setMakePreferred(e.target.checked)} />
              Make this the preferred supplier
              {!editing && row.links.length === 0 && <span>(the first supplier is preferred automatically)</span>}
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
            Cancel
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
