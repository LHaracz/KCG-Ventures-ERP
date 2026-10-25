"use client";

/**
 * Dedicated form for the Receiving log (log_types.special_type ===
 * "receiving"). Rendered by /compliance/logs/[slug]/new in place of the
 * generic dynamic form. Handles the raw-material search + inline
 * "New raw material" creation, the grams-vs-native-unit quantity field,
 * multi-file document upload, and submits everything through
 * POST /api/compliance/logs/receiving — the one atomic server-side
 * transaction (see submit_receiving_entry in
 * supabase-migrations/compliance_logs_receiving.sql).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/components/InstantProvider";
import { fetchActiveEmployees, type Employee } from "@/lib/employees";
import { DOCUMENT_TYPES, type LogEntryFile, type LogType } from "@/lib/complianceLogs";
import { isMassUnit, convertGramsTo } from "@/lib/massUnits";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2.5 text-sm text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:bg-zinc-100 disabled:text-zinc-500";
const labelClassName = "mb-1 block text-sm font-medium text-zinc-800";

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type RawMaterial = { id: string; name: string; unit: string; quantity_on_hand: number };

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
  supplierLotNumber: string;
  internalLotId: string;
  quantityAdded: number;
  quantityReceivedGrams: number | null;
  expirationDate: string | null;
  poOrInvoiceNumber: string | null;
  packagingIntact: boolean;
  identityVerified: boolean;
  coaReceived: boolean;
  notes: string | null;
};

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

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [pastSuppliers, setPastSuppliers] = useState<string[]>([]);
  const [original, setOriginal] = useState<OriginalReceiptInfo | null>(null);

  const [performedByEmployeeId, setPerformedByEmployeeId] = useState("");
  const [performedAt, setPerformedAt] = useState(toDatetimeLocalValue(new Date().toISOString()));
  const [correctionReason, setCorrectionReason] = useState("");

  const [rawMaterialId, setRawMaterialId] = useState("");
  const [rawMaterialSearch, setRawMaterialSearch] = useState("");
  const [addingNewMaterial, setAddingNewMaterial] = useState(false);
  const [newMaterialName, setNewMaterialName] = useState("");
  const [newMaterialUnit, setNewMaterialUnit] = useState("g");
  const [newMaterialCostPerUnit, setNewMaterialCostPerUnit] = useState<number | "">("");
  const [newMaterialParLevel, setNewMaterialParLevel] = useState<number | "">("");

  const [supplier, setSupplier] = useState("");
  const [supplierLotNumber, setSupplierLotNumber] = useState("");
  const [quantityInput, setQuantityInput] = useState<number | "">("");
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

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [employeesResult, itemsResult, suppliersResult] = await Promise.all([
          fetchActiveEmployees(supabase),
          supabase.from("inventory_items").select("id, name, unit, quantity_on_hand").order("name"),
          supabase.from("receiving_details").select("supplier").order("supplier"),
        ]);
        if (cancelled) return;
        setEmployees(employeesResult);
        setRawMaterials((itemsResult.data ?? []) as RawMaterial[]);
        const uniqueSuppliers = Array.from(
          new Set(((suppliersResult.data ?? []) as any[]).map((r) => r.supplier).filter(Boolean)),
        ).sort((a, b) => a.localeCompare(b));
        setPastSuppliers(uniqueSuppliers);

        if (preselectRawMaterialId) setRawMaterialId(preselectRawMaterialId);

        if (correctsEntryId) {
          const [entryResult, detailsResult] = await Promise.all([
            supabase.from("log_entries").select("entry_number").eq("id", correctsEntryId).maybeSingle(),
            supabase.from("receiving_details").select("*").eq("log_entry_id", correctsEntryId).maybeSingle(),
          ]);
          if (cancelled) return;
          if (!detailsResult.data || !entryResult.data) throw new Error("The entry being corrected was not found.");
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
          };
          setOriginal(info);
          setRawMaterialId(info.rawMaterialId);
          setSupplier(info.supplier);
          setSupplierLotNumber(info.supplierLotNumber);
          setQuantityInput(
            info.quantityReceivedGrams != null ? info.quantityReceivedGrams : info.quantityAdded,
          );
          setExpirationDate(info.expirationDate ?? "");
          setPoOrInvoiceNumber(info.poOrInvoiceNumber ?? "");
          setPackagingIntact(info.packagingIntact);
          setIdentityVerified(info.identityVerified);
          setCoaReceived(info.coaReceived);
          setNotes(info.notes ?? "");
        }
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message || "Failed to load the receiving form.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, correctsEntryId, preselectRawMaterialId]);

  const selectedMaterial = useMemo(
    () => rawMaterials.find((m) => m.id === rawMaterialId) ?? null,
    [rawMaterials, rawMaterialId],
  );

  const effectiveUnit = addingNewMaterial ? newMaterialUnit.trim() || "g" : selectedMaterial?.unit ?? "";
  const unitIsMass = effectiveUnit ? isMassUnit(effectiveUnit) : true;

  const quantityAdded = useMemo(() => {
    if (quantityInput === "") return 0;
    if (unitIsMass) return convertGramsTo(effectiveUnit, Number(quantityInput));
    return Number(quantityInput);
  }, [quantityInput, unitIsMass, effectiveUnit]);

  const filteredRawMaterials = useMemo(() => {
    const q = rawMaterialSearch.trim().toLowerCase();
    if (!q) return rawMaterials;
    return rawMaterials.filter((m) => m.name.toLowerCase().includes(q));
  }, [rawMaterials, rawMaterialSearch]);

  const materialDisplayName = addingNewMaterial ? newMaterialName.trim() || "the new material" : selectedMaterial?.name ?? "—";
  const materialCurrentOnHand = addingNewMaterial ? 0 : selectedMaterial?.quantity_on_hand ?? 0;

  const coaFiles = pendingFiles.filter((f) => f.documentType === "coa");
  const showCoaMissingWarning = coaReceived === true && coaFiles.length === 0;

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

    if (!performedByEmployeeId) {
      setSubmitError('"Received by" is required.');
      return;
    }
    const employee = employees.find((e) => e.id === performedByEmployeeId);
    if (!employee) {
      setSubmitError("Selected employee not found.");
      return;
    }
    if (!addingNewMaterial && !rawMaterialId) {
      setSubmitError("Choose a raw material, or add a new one.");
      return;
    }
    if (addingNewMaterial && !newMaterialName.trim()) {
      setSubmitError("New raw material: name is required.");
      return;
    }
    if (!supplier.trim()) {
      setSubmitError("Supplier is required.");
      return;
    }
    if (!supplierLotNumber.trim()) {
      setSubmitError("Supplier lot number is required.");
      return;
    }
    if (quantityInput === "" || Number(quantityInput) <= 0) {
      setSubmitError("Enter a quantity received greater than 0.");
      return;
    }
    if (packagingIntact === null || identityVerified === null || coaReceived === null) {
      setSubmitError("Answer packaging intact, identity verified, and COA received.");
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
      for (let i = 0; i < pendingFiles.length; i++) {
        const pf = pendingFiles[i];
        setSubmitProgress(`Uploading ${i + 1} of ${pendingFiles.length}…`);
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
      const res = await fetch("/api/compliance/logs/receiving", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          logTypeId: logType.id,
          performedAt: performedAtIso,
          performedByEmployeeId: employee.id,
          performedByName: employee.full_name,
          rawMaterialId: addingNewMaterial ? null : rawMaterialId,
          rawMaterialName: addingNewMaterial ? null : selectedMaterial?.name ?? null,
          newRawMaterial: addingNewMaterial
            ? {
                name: newMaterialName.trim(),
                unit: newMaterialUnit.trim() || "g",
                costPerUnit: newMaterialCostPerUnit === "" ? 0 : Number(newMaterialCostPerUnit),
                parLevel: newMaterialParLevel === "" ? null : Number(newMaterialParLevel),
              }
            : null,
          supplier: supplier.trim(),
          supplierLotNumber: supplierLotNumber.trim(),
          quantityReceivedGrams: unitIsMass ? Number(quantityInput) : null,
          quantityAdded,
          materialUnitAtReceipt: effectiveUnit,
          expirationDate: expirationDate || null,
          poOrInvoiceNumber: poOrInvoiceNumber.trim() || null,
          packagingIntact,
          identityVerified,
          coaReceived,
          notes: notes.trim() || null,
          files: uploadedFiles,
          correctsEntryId: correctsEntryId || null,
          correctionReason: correctsEntryId ? correctionReason.trim() : null,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Failed to save this receiving entry.");
      router.push(`/compliance/logs/entries/${payload.entryId}`);
    } catch (err: any) {
      setSubmitError(err.message || "Failed to save this receiving entry.");
    } finally {
      setSubmitting(false);
      setSubmitProgress(null);
    }
  };

  if (loading) return <p className="text-xs text-black">Loading…</p>;
  if (loadError)
    return (
      <p className="text-xs text-red-600" role="alert">
        {loadError}
      </p>
    );

  return (
    <div>
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">
          {correctsEntryId ? `Correct Receiving Entry${original ? ` #${original.entryNumber}` : ""}` : "New Receiving Entry"}
        </h1>
        {logType.linked_sop_id && (
          <Link href={`/compliance/sops/${logType.linked_sop_id}`} className="mt-1 inline-block text-xs font-medium text-emerald-700 underline">
            View SOP
          </Link>
        )}
      </div>

      <div className="mt-4 space-y-4 rounded-md border border-zinc-200 bg-white p-4">
        {correctsEntryId && original && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-900">
              This creates a new entry linked to the original — the original stays visible and is
              marked &ldquo;Corrected&rdquo;. Inventory adjusts by the difference between the new
              and original quantity. Material, supplier, and lot number are kept from the original
              receipt (same physical shipment); lot ID stays <span className="font-mono">{original.internalLotId}</span>.
            </p>
            <label className="mt-2 block text-sm font-medium text-amber-900">Correction reason (required)</label>
            <textarea
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
              rows={2}
              className={`${inputClassName} mt-1`}
            />
          </div>
        )}

        <div>
          <label className={labelClassName}>Received by</label>
          <select value={performedByEmployeeId} onChange={(e) => setPerformedByEmployeeId(e.target.value)} className={inputClassName}>
            <option value="">Select…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.full_name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-zinc-500">A name selection from the roster, not a login or signature.</p>
        </div>

        <div>
          <label className={labelClassName}>Date/time received</label>
          <input type="datetime-local" value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} className={inputClassName} />
        </div>

        <div className="border-t border-zinc-100 pt-4">
          <label className={labelClassName}>Raw material</label>
          {correctsEntryId ? (
            <input value={original?.rawMaterialName ?? ""} disabled className={inputClassName} />
          ) : addingNewMaterial ? (
            <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-700">New raw material</p>
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
                  <input
                    type="number"
                    value={newMaterialCostPerUnit}
                    onChange={(e) => setNewMaterialCostPerUnit(e.target.value === "" ? "" : Number(e.target.value))}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className={labelClassName}>Par level (optional)</label>
                  <input
                    type="number"
                    value={newMaterialParLevel}
                    onChange={(e) => setNewMaterialParLevel(e.target.value === "" ? "" : Number(e.target.value))}
                    className={inputClassName}
                  />
                </div>
              </div>
              <p className="text-[11px] text-zinc-500">
                Quantity on hand starts at 0 — the quantity received below becomes its starting
                stock once this receipt is submitted. Nothing is created in Raw Materials until then.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                value={rawMaterialSearch}
                onChange={(e) => setRawMaterialSearch(e.target.value)}
                placeholder="Search raw materials…"
                className={inputClassName}
              />
              <select value={rawMaterialId} onChange={(e) => setRawMaterialId(e.target.value)} className={inputClassName}>
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

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClassName}>Supplier</label>
            <input
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              list="receiving-past-suppliers"
              className={inputClassName}
              disabled={!!correctsEntryId}
            />
            <datalist id="receiving-past-suppliers">
              {pastSuppliers.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div>
            <label className={labelClassName}>Supplier lot number</label>
            <input value={supplierLotNumber} onChange={(e) => setSupplierLotNumber(e.target.value)} className={inputClassName} disabled={!!correctsEntryId} />
          </div>
        </div>

        <div>
          <label className={labelClassName}>
            {unitIsMass ? "Quantity received (grams)" : `Quantity received (${effectiveUnit || "unit"})`}
          </label>
          <input
            type="number"
            inputMode="decimal"
            value={quantityInput}
            onChange={(e) => setQuantityInput(e.target.value === "" ? "" : Number(e.target.value))}
            className={inputClassName}
          />
          <p className="mt-1 text-[11px] font-medium text-emerald-700">
            Will add {quantityAdded.toLocaleString(undefined, { maximumFractionDigits: 3 })} {effectiveUnit || "unit"} to{" "}
            {materialDisplayName} (currently {materialCurrentOnHand.toLocaleString(undefined, { maximumFractionDigits: 3 })})
            {correctsEntryId && original ? ` — replacing the original ${original.quantityAdded} ${original.rawMaterialUnit}` : ""}
          </p>
        </div>

        <div>
          <label className={labelClassName}>Expiration / retest date</label>
          <input type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} className={inputClassName} />
          {!expirationDate && (
            <p className="mt-1 text-[11px] text-amber-700">
              Supplement ingredients should carry an expiration or retest date.
            </p>
          )}
        </div>

        <div>
          <label className={labelClassName}>PO / invoice number</label>
          <input value={poOrInvoiceNumber} onChange={(e) => setPoOrInvoiceNumber(e.target.value)} className={inputClassName} />
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
                    onClick={() => setValue(opt)}
                    className={`flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
                      value === opt
                        ? opt
                          ? "border-emerald-600 bg-emerald-600 text-white"
                          : "border-red-600 bg-red-600 text-white"
                        : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
                    }`}
                  >
                    {opt ? "Yes" : "No"}
                  </button>
                ))}
              </div>
              {value === false && (
                <p className="mt-1 text-[11px] text-amber-700">This is flagged for review but does not block saving.</p>
              )}
            </div>
          ))}
        </div>

        <div>
          <label className={labelClassName}>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputClassName} />
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
          />
          <p className="mt-1 text-[11px] text-zinc-500">PDF, PNG, or JPG, up to 25 MB each.</p>

          {pendingFiles.length > 0 && (
            <div className="mt-3 space-y-2">
              {pendingFiles.map((pf) => (
                <div key={pf.localId} className="grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 sm:grid-cols-[1fr_auto_auto]">
                  <p className="truncate text-xs text-zinc-700" title={pf.file.name}>
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
                    <button type="button" onClick={() => removePendingFile(pf.localId)} className="text-xs text-red-600 underline">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {showCoaMissingWarning && (
            <p className="mt-2 text-[11px] text-amber-700">
              COA received is marked Yes, but no COA-type file is attached.
            </p>
          )}
        </div>

        {submitError && (
          <p className="text-sm text-red-600" role="alert">
            {submitError}
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full rounded-md bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? submitProgress || "Saving…" : "Save Entry"}
        </button>
      </div>
    </div>
  );
}
