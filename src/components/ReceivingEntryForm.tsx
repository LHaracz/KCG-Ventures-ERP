"use client";

/**
 * Dedicated form for the Receiving log (log_types.special_type ===
 * "receiving"). Rendered by /compliance/logs/[slug]/new in place of the
 * generic dynamic form. Handles the raw-material search + inline
 * "New raw material" creation, the supplier dropdown (Procurement
 * suppliers, pinned first), the two modes chosen by the COA policy of the
 * raw material's listing with that supplier (full: lot number, COA,
 * documents…; simple: quantity, optional expiry, invoice and notes), draft
 * saving, and submits everything through POST /api/compliance/logs/receiving,
 * the one atomic server-side transaction (submit_receiving_entry, which
 * derives the mode again and rejects a payload that doesn't match).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/components/InstantProvider";
import { YouName } from "@/components/access/People";
import { DOCUMENT_TYPES, type LogEntryFile, type LogType } from "@/lib/complianceLogs";
import { isMassUnit, convertGramsTo } from "@/lib/massUnits";
import { FeatureLink } from "@/components/access/FeatureLink";
import { useAccess } from "@/components/access/AccessProvider";
import { coaPolicyLabel, receivingModeFor, sortSuppliersForPicker, validSimpleQuantity, type EntryMode } from "@/lib/receivingMode";
import { draftKey, useFormDraft } from "@/lib/useFormDraft";
import { createSupplierApi } from "@/lib/procurement/client";
import { EMPTY_SUPPLIER } from "@/lib/procurement/validation";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2.5 text-sm text-black placeholder:text-zinc-600 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:bg-zinc-100 disabled:text-black";
const labelClassName = "mb-1 block text-sm font-medium text-black";

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fmtDraftTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

type RawMaterial = { id: string; name: string; unit: string; quantity_on_hand: number };
export type ReceivingSupplier = { id: string; name: string; is_pinned: boolean; listed_for: boolean };

type PendingFile = {
  localId: string;
  file: File;
  documentType: LogEntryFile["document_type"];
  label: string;
};

type OriginalReceiptInfo = {
  entryNumber: number;
  rawMaterialId: string;
  rawMaterialName: string;
  rawMaterialUnit: string;
  supplier: string;
  supplierLotNumber: string | null;
  internalLotId: string;
  quantityAdded: number;
  quantityReceivedGrams: number | null;
  expirationDate: string | null;
  poOrInvoiceNumber: string | null;
  packagingIntact: boolean | null;
  identityVerified: boolean | null;
  coaReceived: boolean | null;
  notes: string | null;
  entryMode: string | null;
  policyAtReceipt: string | null;
};

/** The values a draft keeps (never files). */
type DraftValues = {
  performedAt: string;
  correctionReason: string;
  rawMaterialId: string;
  addingNewMaterial: boolean;
  newMaterialName: string;
  newMaterialUnit: string;
  newMaterialCostPerUnit: string;
  newMaterialParLevel: string;
  supplierId: string;
  forcedFull: boolean;
  supplierLotNumber: string;
  quantityText: string;
  expirationDate: string;
  poOrInvoiceNumber: string;
  packagingIntact: boolean | null;
  identityVerified: boolean | null;
  coaReceived: boolean | null;
  notes: string;
};

/** Searchable supplier dropdown: pinned first, a "Listed" chip, and "Add new supplier" for Procurement users. */
export function SupplierPicker({
  suppliers,
  value,
  onChange,
  canAdd,
  onAddNew,
  error,
}: {
  suppliers: readonly ReceivingSupplier[];
  value: string;
  onChange: (id: string) => void;
  canAdd: boolean;
  onAddNew: () => void;
  error?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => sortSuppliersForPicker(suppliers), [suppliers]);
  const q = search.trim().toLowerCase();
  const shown = q ? sorted.filter((s) => s.name.toLowerCase().includes(q)) : sorted;
  const selected = suppliers.find((s) => s.id === value) ?? null;
  return (
    <div data-testid="supplier-picker">
      <label className={labelClassName} htmlFor="receiving-supplier-search">
        Supplier
      </label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="receiving-supplier-list"
        className={`${inputClassName} flex items-center justify-between text-left`}
        data-testid="supplier-button"
      >
        <span>{selected ? selected.name : "Choose a supplier…"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-zinc-300 bg-white p-2 shadow-sm">
          <input
            id="receiving-supplier-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search suppliers…"
            className={inputClassName}
            autoFocus
          />
          <ul id="receiving-supplier-list" role="listbox" aria-label="Suppliers" className="mt-1 max-h-60 overflow-y-auto">
            {shown.length === 0 && <li className="p-2 text-xs text-black">No suppliers match.</li>}
            {shown.map((s) => (
              <li key={s.id} role="option" aria-selected={s.id === value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(s.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`flex min-h-11 w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-black ${s.id === value ? "bg-emerald-50" : "hover:bg-zinc-50"}`}
                  data-testid="supplier-option"
                >
                  <span>{s.name}</span>
                  {s.listed_for && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-black">Listed</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-zinc-100 pt-2">
            {canAdd ? (
              <button type="button" onClick={onAddNew} className="text-xs font-medium text-emerald-700 underline" data-testid="add-supplier">
                + Add new supplier
              </button>
            ) : (
              <p className="text-[11px] text-black">Ask someone with Procurement access to add a missing supplier.</p>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="mt-1 text-[11px] text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AddSupplierModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return setError("Supplier name is required.");
    setSaving(true);
    setError(null);
    try {
      const { supplier } = await createSupplierApi({ ...EMPTY_SUPPLIER, name: name.trim(), website_url: website.trim() || null });
      onCreated(supplier.id);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Add new supplier">
      <div className="w-full max-w-sm space-y-3 rounded-md bg-white p-4 shadow-lg">
        <h2 className="text-sm font-semibold text-black">Add new supplier</h2>
        <div>
          <label className={labelClassName} htmlFor="new-supplier-name">
            Supplier name
          </label>
          <input id="new-supplier-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClassName} autoFocus />
        </div>
        <div>
          <label className={labelClassName} htmlFor="new-supplier-website">
            Website (optional)
          </label>
          <input id="new-supplier-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" className={inputClassName} />
        </div>
        {error && (
          <p className="text-xs text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-black">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving} className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {saving ? "Saving…" : "Add supplier"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReceivingEntryForm({
  logType,
  correctsEntryId,
  preselectRawMaterialId,
}: {
  logType: LogType;
  correctsEntryId: string | null;
  preselectRawMaterialId: string | null;
}) {
  const router = useRouter();
  const { user, supabase } = useSupabase();
  const userId = user?.id ?? null;
  const { has } = useAccess();
  const canViewLogs = has("compliance.logs");
  const canProcurement = has("inventory.purchase_orders");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [suppliers, setSuppliers] = useState<ReceivingSupplier[]>([]);
  const [suppliersError, setSuppliersError] = useState<string | null>(null);
  const [original, setOriginal] = useState<OriginalReceiptInfo | null>(null);

  const [performedAt, setPerformedAt] = useState(toDatetimeLocalValue(new Date().toISOString()));
  const [correctionReason, setCorrectionReason] = useState("");

  const [rawMaterialId, setRawMaterialId] = useState("");
  const [rawMaterialSearch, setRawMaterialSearch] = useState("");
  const [addingNewMaterial, setAddingNewMaterial] = useState(false);
  const [newMaterialName, setNewMaterialName] = useState("");
  const [newMaterialUnit, setNewMaterialUnit] = useState("g");
  const [newMaterialCostPerUnit, setNewMaterialCostPerUnit] = useState("");
  const [newMaterialParLevel, setNewMaterialParLevel] = useState("");

  const [supplierId, setSupplierId] = useState("");
  const [forcedFull, setForcedFull] = useState(false);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [policyLookup, setPolicyLookup] = useState<{ key: string; policy: string | null; error: boolean } | null>(null);

  const [supplierLotNumber, setSupplierLotNumber] = useState("");
  const [quantityText, setQuantityText] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [poOrInvoiceNumber, setPoOrInvoiceNumber] = useState("");
  const [packagingIntact, setPackagingIntact] = useState<boolean | null>(null);
  const [identityVerified, setIdentityVerified] = useState<boolean | null>(null);
  const [coaReceived, setCoaReceived] = useState<boolean | null>(null);
  const [notes, setNotes] = useState("");

  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [initialValues, setInitialValues] = useState<string | null>(null);

  // Loads once per signed-in user and form (not on every auth event), so a
  // tab regaining focus never reloads or resets what was typed.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const itemsResult = await supabase.from("inventory_items").select("id, name, unit, quantity_on_hand").order("name");
        if (cancelled) return;
        setRawMaterials((itemsResult.data ?? []) as RawMaterial[]);

        if (preselectRawMaterialId) setRawMaterialId(preselectRawMaterialId);

        if (correctsEntryId) {
          const [entryResult, detailsResult] = await Promise.all([
            supabase.from("log_entries").select("entry_number").eq("id", correctsEntryId).maybeSingle(),
            supabase.from("receiving_details").select("*").eq("log_entry_id", correctsEntryId).maybeSingle(),
          ]);
          if (cancelled) return;
          if (!detailsResult.data || !entryResult.data) throw new Error("The entry being corrected was not found.");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- receiving_details row
          const d = detailsResult.data as any;
          const material = ((itemsResult.data ?? []) as RawMaterial[]).find((m) => m.id === d.raw_material_id);
          const info: OriginalReceiptInfo = {
            entryNumber: entryResult.data.entry_number,
            rawMaterialId: d.raw_material_id,
            rawMaterialName: material?.name ?? "Unknown material",
            rawMaterialUnit: d.material_unit_at_receipt,
            supplier: d.supplier,
            supplierLotNumber: d.supplier_lot_number,
            internalLotId: d.internal_lot_id,
            quantityAdded: Number(d.quantity_added_in_material_unit),
            quantityReceivedGrams: d.quantity_received_grams != null ? Number(d.quantity_received_grams) : null,
            expirationDate: d.expiration_date,
            poOrInvoiceNumber: d.po_or_invoice_number,
            packagingIntact: d.packaging_intact,
            identityVerified: d.identity_verified,
            coaReceived: d.coa_received,
            notes: d.notes,
            entryMode: d.entry_mode ?? null,
            policyAtReceipt: d.coa_policy_at_receipt ?? null,
          };
          setOriginal(info);
          setRawMaterialId(info.rawMaterialId);
          setSupplierLotNumber(info.supplierLotNumber ?? "");
          setQuantityText(String(info.quantityReceivedGrams != null ? info.quantityReceivedGrams : info.quantityAdded));
          setExpirationDate(info.expirationDate ?? "");
          setPoOrInvoiceNumber(info.poOrInvoiceNumber ?? "");
          setPackagingIntact(info.packagingIntact);
          setIdentityVerified(info.identityVerified);
          setCoaReceived(info.coaReceived);
          setNotes(info.notes ?? "");
        }
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message || "Failed to load the receiving form.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [userId, correctsEntryId, preselectRawMaterialId, supabase]);

  // Suppliers (with the "Listed" flag for the chosen raw material). A refetch
  // only updates the list; the chosen supplier stays.
  const listMaterialId = addingNewMaterial ? "" : rawMaterialId;
  const [supplierListTick, setSupplierListTick] = useState(0);
  useEffect(() => {
    if (!userId || correctsEntryId) return;
    let cancelled = false;
    supabase
      .rpc("list_suppliers_for_receiving", { p_raw_material_id: listMaterialId || null })
      .then(({ data, error }: { data: ReceivingSupplier[] | null; error: { message: string } | null }) => {
        if (cancelled) return;
        if (error) setSuppliersError(error.message);
        else {
          setSuppliersError(null);
          setSuppliers(((data ?? []) as ReceivingSupplier[]).map((s) => ({ ...s, listed_for: !!s.listed_for })));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, correctsEntryId, listMaterialId, supabase, supplierListTick]);

  // The COA policy of the chosen pair.
  const pairKey = !correctsEntryId && !addingNewMaterial && rawMaterialId && supplierId ? `${rawMaterialId}|${supplierId}` : null;
  useEffect(() => {
    if (!pairKey) return;
    let cancelled = false;
    const [m, s] = pairKey.split("|");
    supabase.rpc("coa_policy_for", { p_raw_material_id: m, p_supplier_id: s }).then(({ data, error }: { data: string | null; error: unknown }) => {
      if (!cancelled) setPolicyLookup({ key: pairKey, policy: error ? null : (data as string | null) ?? null, error: !!error });
    });
    return () => {
      cancelled = true;
    };
  }, [pairKey, supabase]);

  const selectedMaterial = useMemo(() => rawMaterials.find((m) => m.id === rawMaterialId) ?? null, [rawMaterials, rawMaterialId]);
  const effectiveUnit = addingNewMaterial ? newMaterialUnit.trim() || "g" : selectedMaterial?.unit ?? original?.rawMaterialUnit ?? "";

  // Mode: a correction keeps the original's; otherwise by the pair's COA policy.
  const materialChosen = correctsEntryId ? !!original : addingNewMaterial ? !!newMaterialName.trim() : !!rawMaterialId;
  const modeInfo = useMemo(() => {
    if (correctsEntryId) return original ? receivingModeFor({ isCorrection: true, existingEntryMode: original.entryMode, policy: original.policyAtReceipt, hasListing: true }) : null;
    if (!materialChosen || !supplierId) return null;
    if (addingNewMaterial) return receivingModeFor({ policy: null, hasListing: false, forcedFull });
    if (!policyLookup || policyLookup.key !== pairKey) return null;
    return receivingModeFor({ policy: policyLookup.policy, hasListing: policyLookup.policy !== null, forcedFull });
  }, [correctsEntryId, original, materialChosen, supplierId, addingNewMaterial, forcedFull, policyLookup, pairKey]);
  const mode: EntryMode | null = modeInfo?.mode ?? null;
  const unitIsMass = mode === "full" && (effectiveUnit ? isMassUnit(effectiveUnit) : true);

  // When the mode changes, drop what the new mode doesn't use and keep the rest.
  const prevMode = useRef<EntryMode | null>(null);
  useEffect(() => {
    // While the policy is being looked up the mode is unknown; compare with the last known mode.
    if (!mode) return;
    const prev = prevMode.current;
    prevMode.current = mode;
    if (!prev || prev === mode) return;
    const massUnit = effectiveUnit ? isMassUnit(effectiveUnit) : true;
    if (mode === "simple") {
      setSupplierLotNumber("");
      setPackagingIntact(null);
      setIdentityVerified(null);
      setCoaReceived(null);
      setPendingFiles([]);
    }
    // Full mode takes grams for mass units; simple takes the material's own unit.
    if (massUnit) setQuantityText("");
  }, [mode, effectiveUnit]);

  const quantityAdded = useMemo(() => {
    if (!quantityText.trim()) return 0;
    if (mode === "simple") return validSimpleQuantity(quantityText) ?? 0;
    const n = Number(quantityText);
    if (!Number.isFinite(n)) return 0;
    return unitIsMass ? convertGramsTo(effectiveUnit, n) : n;
  }, [quantityText, mode, unitIsMass, effectiveUnit]);

  const filteredRawMaterials = useMemo(() => {
    const q = rawMaterialSearch.trim().toLowerCase();
    if (!q) return rawMaterials;
    return rawMaterials.filter((m) => m.name.toLowerCase().includes(q));
  }, [rawMaterials, rawMaterialSearch]);

  const materialDisplayName = addingNewMaterial ? newMaterialName.trim() || "the new material" : selectedMaterial?.name ?? original?.rawMaterialName ?? "—";
  const materialCurrentOnHand = addingNewMaterial ? 0 : selectedMaterial?.quantity_on_hand ?? 0;

  const coaFiles = pendingFiles.filter((f) => f.documentType === "coa");
  const showCoaMissingWarning = coaReceived === true && coaFiles.length === 0;

  // --- Draft saving -------------------------------------------------------------------------------------
  const draftValues: DraftValues = {
    performedAt,
    correctionReason,
    rawMaterialId,
    addingNewMaterial,
    newMaterialName,
    newMaterialUnit,
    newMaterialCostPerUnit,
    newMaterialParLevel,
    supplierId,
    forcedFull,
    supplierLotNumber,
    quantityText,
    expirationDate,
    poOrInvoiceNumber,
    packagingIntact,
    identityVerified,
    coaReceived,
    notes,
  };
  const draftJson = JSON.stringify({ ...draftValues, performedAt: "" });
  useEffect(() => {
    // The starting values, once the form has loaded (performedAt alone doesn't make a form dirty).
    if (!loading && !loadError && initialValues === null) setInitialValues(draftJson);
  }, [loading, loadError, initialValues, draftJson]);
  const dirty = initialValues !== null && (draftJson !== initialValues || pendingFiles.length > 0);
  const formKey = `receiving:${correctsEntryId ? `correct-${correctsEntryId}` : preselectRawMaterialId || "new"}`;
  const draft = useFormDraft<DraftValues>(userId && initialValues !== null ? draftKey(userId, formKey) : null, draftValues, {
    dirty,
    hasFiles: pendingFiles.length > 0,
    onRestore: (d) => {
      setPerformedAt(d.performedAt || performedAt);
      setCorrectionReason(d.correctionReason ?? "");
      if (!correctsEntryId) {
        setRawMaterialId(d.rawMaterialId ?? "");
        setAddingNewMaterial(!!d.addingNewMaterial);
        setNewMaterialName(d.newMaterialName ?? "");
        setNewMaterialUnit(d.newMaterialUnit || "g");
        setNewMaterialCostPerUnit(d.newMaterialCostPerUnit ?? "");
        setNewMaterialParLevel(d.newMaterialParLevel ?? "");
        setSupplierId(d.supplierId ?? "");
        setForcedFull(!!d.forcedFull);
      }
      // The restored values belong to the restored mode: don't reconcile them away.
      prevMode.current = null;
      setSupplierLotNumber(d.supplierLotNumber ?? "");
      setQuantityText(d.quantityText ?? "");
      setExpirationDate(d.expirationDate ?? "");
      setPoOrInvoiceNumber(d.poOrInvoiceNumber ?? "");
      setPackagingIntact(d.packagingIntact ?? null);
      setIdentityVerified(d.identityVerified ?? null);
      setCoaReceived(d.coaReceived ?? null);
      setNotes(d.notes ?? "");
    },
  });
  const discardDraft = () => {
    draft.clear();
    if (initialValues) {
      const d = JSON.parse(initialValues) as DraftValues;
      prevMode.current = null;
      setCorrectionReason(d.correctionReason);
      setRawMaterialId(d.rawMaterialId);
      setAddingNewMaterial(d.addingNewMaterial);
      setNewMaterialName(d.newMaterialName);
      setNewMaterialUnit(d.newMaterialUnit);
      setNewMaterialCostPerUnit(d.newMaterialCostPerUnit);
      setNewMaterialParLevel(d.newMaterialParLevel);
      setSupplierId(d.supplierId);
      setForcedFull(d.forcedFull);
      setSupplierLotNumber(d.supplierLotNumber);
      setQuantityText(d.quantityText);
      setExpirationDate(d.expirationDate);
      setPoOrInvoiceNumber(d.poOrInvoiceNumber);
      setPackagingIntact(d.packagingIntact);
      setIdentityVerified(d.identityVerified);
      setCoaReceived(d.coaReceived);
      setNotes(d.notes);
      setPendingFiles([]);
    }
  };

  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList) return;
    const additions: PendingFile[] = Array.from(fileList).map((file) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      documentType: "other",
      label: "",
    }));
    setPendingFiles((prev) => [...prev, ...additions]);
  };

  const updatePendingFile = (localId: string, patch: Partial<PendingFile>) => {
    setPendingFiles((prev) => prev.map((f) => (f.localId === localId ? { ...f, ...patch } : f)));
  };

  const removePendingFile = (localId: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.localId !== localId));
  };

  const getToken = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    return token;
  };

  const handleSubmit = async () => {
    setSubmitError(null);

    if (!correctsEntryId && !addingNewMaterial && !rawMaterialId) {
      setSubmitError("Choose a raw material, or add a new one.");
      return;
    }
    if (addingNewMaterial && !newMaterialName.trim()) {
      setSubmitError("New raw material: name is required.");
      return;
    }
    if (!correctsEntryId && !supplierId) {
      setSubmitError("Choose a supplier.");
      return;
    }
    if (!mode) {
      setSubmitError("Checking the COA policy for this supplier… try again in a moment.");
      return;
    }
    if (mode === "full") {
      if (!correctsEntryId && !supplierLotNumber.trim()) {
        setSubmitError("Supplier lot number is required.");
        return;
      }
      if (!quantityText.trim() || !(Number(quantityText) > 0)) {
        setSubmitError("Enter a quantity received greater than 0.");
        return;
      }
      if (packagingIntact === null || identityVerified === null || coaReceived === null) {
        setSubmitError("Answer packaging intact, identity verified, and COA received.");
        return;
      }
    } else if (validSimpleQuantity(quantityText) === null) {
      setSubmitError("Enter a quantity received greater than 0, with at most 3 decimals.");
      return;
    }
    if (correctsEntryId && !correctionReason.trim()) {
      setSubmitError("A correction reason is required.");
      return;
    }

    setSubmitting(true);
    try {
      const token = await getToken();

      // Upload every pending file to its own signed URL before calling the
      // atomic submit route — files only ever attach to the entry once the
      // whole submission succeeds (the server verifies each one again).
      const uploadedFiles: Array<{ path: string; originalFilename: string; documentType: string; label: string | null }> = [];
      const files = mode === "full" ? pendingFiles : [];
      for (let i = 0; i < files.length; i++) {
        const pf = files[i];
        setSubmitProgress(`Uploading ${i + 1} of ${files.length}…`);
        const uploadUrlRes = await fetch("/api/compliance/logs/documents/upload-url", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: pf.file.name, fileSize: pf.file.size, mimeType: pf.file.type }),
        });
        const uploadUrlPayload = await uploadUrlRes.json();
        if (!uploadUrlRes.ok) throw new Error(`"${pf.file.name}": ${uploadUrlPayload.error || "upload failed"}`);
        const { path, token: uploadToken } = uploadUrlPayload as { path: string; token: string };

        const { error: uploadError } = await supabase.storage.from("log-entry-docs").uploadToSignedUrl(path, uploadToken, pf.file);
        if (uploadError) throw new Error(`"${pf.file.name}": ${uploadError.message}`);

        uploadedFiles.push({
          path,
          originalFilename: pf.file.name,
          documentType: pf.documentType,
          label: pf.label.trim() || null,
        });
      }

      setSubmitProgress("Saving…");
      const performedAtIso = new Date(performedAt).toISOString();
      const common = {
        logTypeId: logType.id,
        performedAt: performedAtIso,
        rawMaterialId: correctsEntryId ? original?.rawMaterialId ?? null : addingNewMaterial ? null : rawMaterialId,
        rawMaterialName: addingNewMaterial ? null : selectedMaterial?.name ?? original?.rawMaterialName ?? null,
        newRawMaterial:
          !correctsEntryId && addingNewMaterial
            ? {
                name: newMaterialName.trim(),
                unit: newMaterialUnit.trim() || "g",
                costPerUnit: newMaterialCostPerUnit === "" ? 0 : Number(newMaterialCostPerUnit),
                parLevel: newMaterialParLevel === "" ? null : Number(newMaterialParLevel),
              }
            : null,
        supplierId: correctsEntryId ? null : supplierId,
        entryMode: mode,
        forcedFull,
        quantityAdded,
        materialUnitAtReceipt: effectiveUnit,
        expirationDate: expirationDate || null,
        poOrInvoiceNumber: poOrInvoiceNumber.trim() || null,
        notes: notes.trim() || null,
        correctsEntryId: correctsEntryId || null,
        correctionReason: correctsEntryId ? correctionReason.trim() : null,
      };
      const body =
        mode === "full"
          ? {
              ...common,
              supplierLotNumber: supplierLotNumber.trim(),
              quantityReceivedGrams: unitIsMass ? Number(quantityText) : null,
              packagingIntact,
              identityVerified,
              coaReceived,
              files: uploadedFiles,
            }
          : { ...common, supplierLotNumber: null, quantityReceivedGrams: null, packagingIntact: null, identityVerified: null, coaReceived: null, files: [] };
      const res = await fetch("/api/compliance/logs/receiving", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Failed to save this receiving entry.");
      draft.finish();
      // Raw Materials users without the Logs feature go back to Raw Materials.
      router.push(canViewLogs ? `/compliance/logs/entries/${payload.entryId}` : "/inventory");
    } catch (err) {
      setSubmitError((err as Error).message || "Failed to save this receiving entry.");
    } finally {
      setSubmitting(false);
      setSubmitProgress(null);
    }
  };

  if (loading) return <p className="text-xs text-black">Loading…</p>;
  if (loadError)
    return (
      <p className="text-xs text-red-700" role="alert">
        {loadError}
      </p>
    );

  const policyLine =
    modeInfo && modeInfo.reason === "no_listing" ? (
      <>
        No COA policy set for this supplier and ingredient.{" "}
        {canProcurement && rawMaterialId ? (
          <FeatureLink feature="inventory.purchase_orders" href={`/inventory/procurement?material=${encodeURIComponent(rawMaterialId)}`} className="underline">
            Set it in Procurement.
          </FeatureLink>
        ) : (
          "Set it in Procurement."
        )}
      </>
    ) : (
      <>COA policy: {coaPolicyLabel(modeInfo?.policy)}. Receiving without a lot number or COA.</>
    );

  return (
    <div>
      <div>
        <h1 className="text-2xl font-semibold text-black">
          {correctsEntryId ? `Correct Receiving Entry${original ? ` #${original.entryNumber}` : ""}` : "New Receiving Entry"}
        </h1>
        {logType.linked_sop_id && (
          <FeatureLink feature="compliance.sops" href={`/compliance/sops/${logType.linked_sop_id}`} className="mt-1 inline-block text-xs font-medium text-emerald-700 underline">
            View SOP
          </FeatureLink>
        )}
      </div>

      {draft.restoredAt && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-black" role="status" data-testid="draft-banner">
          <span>
            Restored your unsaved draft from {fmtDraftTime(draft.restoredAt)}.{draft.hadFiles ? " Re-attach your documents." : ""}
          </span>
          <button type="button" onClick={discardDraft} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black">
            Discard draft
          </button>
        </div>
      )}

      <div className="mt-4 space-y-4 rounded-md border border-zinc-200 bg-white p-4">
        {correctsEntryId && original && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-medium text-black">
              This creates a new entry linked to the original — the original stays visible and is marked &ldquo;Corrected&rdquo;. Inventory adjusts by the difference between
              the new and original quantity. Material, supplier, and lot number are kept from the original receipt (same physical shipment); lot ID stays{" "}
              <span className="font-mono">{original.internalLotId}</span>.
            </p>
            <label className="mt-2 block text-sm font-medium text-black">Correction reason (required)</label>
            <textarea value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} rows={2} className={`${inputClassName} mt-1`} />
          </div>
        )}

        <div>
          <label className={labelClassName}>Date/time received</label>
          <input type="datetime-local" value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} className={inputClassName} />
        </div>

        <YouName label="Received by" />

        <div className="border-t border-zinc-100 pt-4">
          <label className={labelClassName}>Raw material</label>
          {correctsEntryId ? (
            <input value={original?.rawMaterialName ?? ""} disabled className={inputClassName} />
          ) : addingNewMaterial ? (
            <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-black">New raw material</p>
                <button type="button" onClick={() => setAddingNewMaterial(false)} className="text-xs text-emerald-700 underline">
                  Choose existing instead
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClassName}>Name</label>
                  <input value={newMaterialName} onChange={(e) => setNewMaterialName(e.target.value)} className={inputClassName} />
                </div>
                <div>
                  <label className={labelClassName}>Unit</label>
                  <input value={newMaterialUnit} onChange={(e) => setNewMaterialUnit(e.target.value)} className={inputClassName} />
                </div>
                <div>
                  <label className={labelClassName}>Cost per unit</label>
                  <input type="number" value={newMaterialCostPerUnit} onChange={(e) => setNewMaterialCostPerUnit(e.target.value)} className={inputClassName} />
                </div>
                <div>
                  <label className={labelClassName}>Par level (optional)</label>
                  <input type="number" value={newMaterialParLevel} onChange={(e) => setNewMaterialParLevel(e.target.value)} className={inputClassName} />
                </div>
              </div>
              <p className="text-[11px] text-black">
                Quantity on hand starts at 0 — the quantity received below becomes its starting stock once this receipt is submitted. Nothing is created in Raw Materials until
                then.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <input value={rawMaterialSearch} onChange={(e) => setRawMaterialSearch(e.target.value)} placeholder="Search raw materials…" className={inputClassName} />
              <select value={rawMaterialId} onChange={(e) => setRawMaterialId(e.target.value)} className={inputClassName} aria-label="Raw material">
                <option value="">Select…</option>
                {filteredRawMaterials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.unit}) — {m.quantity_on_hand} on hand
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setAddingNewMaterial(true)} className="text-xs text-emerald-700 underline">
                + New raw material
              </button>
            </div>
          )}
        </div>

        {correctsEntryId ? (
          <div>
            <label className={labelClassName}>Supplier</label>
            <input value={original?.supplier ?? ""} disabled className={inputClassName} />
          </div>
        ) : (
          <SupplierPicker
            suppliers={suppliers}
            value={supplierId}
            onChange={(id) => {
              setSupplierId(id);
              setForcedFull(false);
            }}
            canAdd={canProcurement}
            onAddNew={() => setAddingSupplier(true)}
            error={suppliersError}
          />
        )}

        {!correctsEntryId && (!materialChosen || !supplierId) && (
          <p className="text-xs text-black" data-testid="choose-first">
            Choose the raw material and the supplier to continue.
          </p>
        )}
        {materialChosen && (correctsEntryId || supplierId) && !mode && <p className="text-xs text-black">Checking the COA policy…</p>}

        {mode === "full" && (
          <div className="space-y-4" data-testid="full-fields">
            {modeInfo?.reason === "forced_full" && (
              <button type="button" onClick={() => setForcedFull(false)} className="text-xs text-emerald-700 underline">
                Use the simple form instead
              </button>
            )}
            <div>
              <label className={labelClassName} htmlFor="receiving-lot">
                Supplier lot number
              </label>
              <input id="receiving-lot" value={supplierLotNumber} onChange={(e) => setSupplierLotNumber(e.target.value)} className={inputClassName} disabled={!!correctsEntryId} />
            </div>

            <div>
              <label className={labelClassName} htmlFor="receiving-qty">
                {unitIsMass ? "Quantity received (grams)" : `Quantity received (${effectiveUnit || "unit"})`}
              </label>
              <input id="receiving-qty" type="number" inputMode="decimal" value={quantityText} onChange={(e) => setQuantityText(e.target.value)} className={inputClassName} />
              <p className="mt-1 text-[11px] font-medium text-black" data-testid="qty-preview">
                Will add {quantityAdded.toLocaleString(undefined, { maximumFractionDigits: 3 })} {effectiveUnit || "unit"} to {materialDisplayName} (currently{" "}
                {materialCurrentOnHand.toLocaleString(undefined, { maximumFractionDigits: 3 })})
                {correctsEntryId && original ? ` — replacing the original ${original.quantityAdded} ${original.rawMaterialUnit}` : ""}
              </p>
            </div>

            <div>
              <label className={labelClassName} htmlFor="receiving-exp">
                Expiration / retest date
              </label>
              <input id="receiving-exp" type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} className={inputClassName} />
              {!expirationDate && <p className="mt-1 text-[11px] text-amber-800">Supplement ingredients should carry an expiration or retest date.</p>}
            </div>

            <div>
              <label className={labelClassName} htmlFor="receiving-po">
                PO / invoice number
              </label>
              <input id="receiving-po" value={poOrInvoiceNumber} onChange={(e) => setPoOrInvoiceNumber(e.target.value)} className={inputClassName} />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {(
                [
                  ["Packaging intact", packagingIntact, setPackagingIntact],
                  ["Identity verified against COA/label", identityVerified, setIdentityVerified],
                  ["COA received", coaReceived, setCoaReceived],
                ] as const
              ).map(([label, value, setValue]) => (
                <div key={label}>
                  <label className={labelClassName}>{label}</label>
                  <div className="flex gap-2">
                    {([true, false] as const).map((opt) => (
                      <button
                        key={String(opt)}
                        type="button"
                        aria-pressed={value === opt}
                        aria-label={`${label}: ${opt ? "Yes" : "No"}`}
                        onClick={() => setValue(opt)}
                        className={`flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
                          value === opt ? (opt ? "border-emerald-600 bg-emerald-600 text-white" : "border-red-600 bg-red-600 text-white") : "border-zinc-300 bg-white text-black hover:bg-zinc-50"
                        }`}
                      >
                        {opt ? "Yes" : "No"}
                      </button>
                    ))}
                  </div>
                  {value === false && <p className="mt-1 text-[11px] text-amber-800">This is flagged for review but does not block saving.</p>}
                </div>
              ))}
            </div>

            <div>
              <label className={labelClassName} htmlFor="receiving-notes">
                Notes
              </label>
              <textarea id="receiving-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputClassName} />
            </div>

            <div className="border-t border-zinc-100 pt-4">
              <label className={labelClassName}>Documents</label>
              <input
                type="file"
                multiple
                accept="application/pdf,image/png,image/jpeg"
                onChange={(e) => {
                  handleFilesSelected(e.target.files);
                  e.target.value = "";
                }}
                className="block w-full text-sm text-black"
                aria-label="Documents"
              />
              <p className="mt-1 text-[11px] text-black">PDF, PNG, or JPG, up to 25 MB each.</p>

              {pendingFiles.length > 0 && (
                <div className="mt-3 space-y-2">
                  {pendingFiles.map((pf) => (
                    <div key={pf.localId} className="grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 sm:grid-cols-[1fr_auto_auto]">
                      <p className="truncate text-xs text-black" title={pf.file.name}>
                        {pf.file.name}
                      </p>
                      <select
                        value={pf.documentType}
                        onChange={(e) => updatePendingFile(pf.localId, { documentType: e.target.value as LogEntryFile["document_type"] })}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
                      >
                        {DOCUMENT_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-2">
                        <input
                          value={pf.label}
                          onChange={(e) => updatePendingFile(pf.localId, { label: e.target.value })}
                          placeholder="Label (optional)"
                          className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
                        />
                        <button type="button" onClick={() => removePendingFile(pf.localId)} className="text-xs text-red-700 underline">
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {showCoaMissingWarning && <p className="mt-2 text-[11px] text-amber-800">COA received is marked Yes, but no COA-type file is attached.</p>}
            </div>
          </div>
        )}

        {mode === "simple" && (
          <div className="space-y-4" data-testid="simple-fields">
            <div>
              <label className={labelClassName} htmlFor="receiving-simple-qty">
                Quantity received
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="receiving-simple-qty"
                  inputMode="decimal"
                  value={quantityText}
                  onChange={(e) => setQuantityText(e.target.value)}
                  className={inputClassName}
                  aria-describedby="receiving-simple-unit"
                />
                <span id="receiving-simple-unit" className="shrink-0 text-sm text-black">
                  {effectiveUnit || "unit"}
                </span>
              </div>
              <p className="mt-1 text-[11px] font-medium text-black" data-testid="qty-preview">
                Will add {quantityAdded.toLocaleString(undefined, { maximumFractionDigits: 3 })} {effectiveUnit || "unit"} to {materialDisplayName} (currently{" "}
                {materialCurrentOnHand.toLocaleString(undefined, { maximumFractionDigits: 3 })})
                {correctsEntryId && original ? ` — replacing the original ${original.quantityAdded} ${original.rawMaterialUnit}` : ""}
              </p>
            </div>
            <div>
              <label className={labelClassName} htmlFor="receiving-simple-exp">
                Expiration date (optional)
              </label>
              <input id="receiving-simple-exp" type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} className={inputClassName} />
            </div>
            <div>
              <label className={labelClassName} htmlFor="receiving-simple-invoice">
                Invoice number (optional)
              </label>
              <input id="receiving-simple-invoice" value={poOrInvoiceNumber} onChange={(e) => setPoOrInvoiceNumber(e.target.value)} className={inputClassName} />
            </div>
            <div>
              <label className={labelClassName} htmlFor="receiving-simple-notes">
                Notes (optional)
              </label>
              <textarea id="receiving-simple-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputClassName} />
            </div>
            {!correctsEntryId && (
              <div className="space-y-1 text-[11px] text-black" data-testid="policy-line">
                <p>{policyLine}</p>
                <button type="button" onClick={() => setForcedFull(true)} className="text-emerald-700 underline">
                  Need to record a lot number or COA? Use the full form
                </button>
              </div>
            )}
          </div>
        )}

        {submitError && (
          <p className="text-sm text-red-700" role="alert">
            {submitError}
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !mode}
          className="w-full rounded-md bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? submitProgress || "Saving…" : "Save Entry"}
        </button>
      </div>

      {addingSupplier && (
        <AddSupplierModal
          onClose={() => setAddingSupplier(false)}
          onCreated={(id) => {
            setAddingSupplier(false);
            setSupplierId(id);
            setForcedFull(false);
            setSupplierListTick((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
