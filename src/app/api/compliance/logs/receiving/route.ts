import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { removeLogEntryDocObject, verifyUploadedLogEntryDoc } from "@/lib/logEntryDocsStorage";
import { DOCUMENT_TYPES, type LogEntryFile } from "@/lib/complianceLogs";
import { callerOf, guardApi } from "@/lib/access/api";

/**
 * The ONE-transaction path for submitting (or correcting) a Receiving log
 * entry — safety rule: roll back everything on any failure. Every uploaded
 * file has already been PUT to its signed upload URL before this is
 * called; this route re-verifies each one server-side (size + magic
 * bytes), then calls the `submit_receiving_entry` Postgres function via
 * RPC, which does the new-raw-material creation, the log_entries +
 * receiving_details + log_entry_files inserts, and the inventory increase
 * (through the same inventory_adjustments/inventory_items mechanism the
 * Raw Materials page itself uses) as a single database transaction. The
 * form is full or simple by the COA policy of the raw material's listing
 * with the chosen supplier; the database derives the mode again and rejects
 * a payload that doesn't match (receiving_coa_modes.sql). If
 * that RPC call fails for any reason, the already-uploaded files are
 * removed from Storage so nothing orphaned is left behind.
 */

type NewRawMaterialPayload = {
  name: string;
  unit: string;
  costPerUnit?: number | null;
  parLevel?: number | null;
};

type ReceivingFilePayload = {
  path: string;
  originalFilename: string;
  documentType: LogEntryFile["document_type"];
  label?: string | null;
};

type SubmitReceivingRequestBody = {
  logTypeId: string;
  performedAt: string;
  /** Ignored: "Received by" is the signed-in employee. */
  performedByEmployeeId?: string | null;
  /** Ignored: "Received by" is the signed-in employee. */
  performedByName?: string;
  rawMaterialId?: string | null;
  rawMaterialName?: string | null;
  newRawMaterial?: NewRawMaterialPayload | null;
  /** Required for a new receipt (corrections keep the original's supplier). */
  supplierId?: string | null;
  /** The mode the form used; the database derives it again and must agree. */
  entryMode?: "full" | "simple";
  /** "Use the full form" was chosen for a pair that would be simple. */
  forcedFull?: boolean;
  supplierLotNumber?: string | null;
  quantityReceivedGrams?: number | null;
  quantityAdded: number;
  materialUnitAtReceipt: string;
  expirationDate?: string | null;
  poOrInvoiceNumber?: string | null;
  packagingIntact?: boolean | null;
  identityVerified?: boolean | null;
  coaReceived?: boolean | null;
  notes?: string | null;
  files?: ReceivingFilePayload[];
  correctsEntryId?: string | null;
  correctionReason?: string | null;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

const VALID_DOCUMENT_TYPES = new Set(DOCUMENT_TYPES.map((t) => t.value));

export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const verifiedPaths: string[] = [];
  try {
    const user = await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as SubmitReceivingRequestBody;

    if (!body?.logTypeId) return badRequest("Missing log type.");
    // "Received by" is the signed-in employee, from the session.
    const { access } = callerOf(request);
    if (!access.fullName) return badRequest("Your name isn't set. Reload and try again.");
    if (!body.rawMaterialId && !body.newRawMaterial) return badRequest("A raw material is required.");
    if (body.newRawMaterial) {
      if (!body.newRawMaterial.name?.trim()) return badRequest("New raw material: name is required.");
      if (!body.newRawMaterial.unit?.trim()) return badRequest("New raw material: unit is required.");
      // Same duplicate-name guard the Raw Materials "New inventory item"
      // form applies client-side — enforced here too since this path
      // creates the row itself, inside the atomic RPC.
      const { data: existing, error: existingError } = await supabaseAdmin
        .from("inventory_items")
        .select("id")
        .ilike("name", body.newRawMaterial.name.trim())
        .maybeSingle();
      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
      if (existing) return badRequest("An inventory item with this name already exists.");
    }
    const mode = body.entryMode === "simple" ? "simple" : "full";
    if (!body.correctsEntryId && !body.supplierId) return badRequest("Choose a supplier.");
    if (!Number.isFinite(body.quantityAdded) || body.quantityAdded <= 0) {
      return badRequest("Quantity received must be greater than 0.");
    }
    if (!body.materialUnitAtReceipt?.trim()) return badRequest("Missing material unit.");
    if (mode === "full") {
      if (!body.correctsEntryId && !body.supplierLotNumber?.trim()) return badRequest("Supplier lot number is required.");
      if (typeof body.packagingIntact !== "boolean" || typeof body.identityVerified !== "boolean" || typeof body.coaReceived !== "boolean") {
        return badRequest("Packaging intact, identity verified, and COA received must each be answered.");
      }
    } else {
      if (Math.abs(Math.round(body.quantityAdded * 1000) - body.quantityAdded * 1000) > 1e-6) return badRequest("Use at most 3 decimals for the quantity.");
      if (body.supplierLotNumber?.trim() || body.files?.length || body.packagingIntact != null || body.identityVerified != null || body.coaReceived != null || body.quantityReceivedGrams != null) {
        return badRequest("A simple receipt has no lot number, grams, packaging, identity, COA or documents.");
      }
    }
    if (body.correctsEntryId && !body.correctionReason?.trim()) return badRequest("A correction reason is required.");
    for (const file of body.files ?? []) {
      if (!file.path || !file.originalFilename) return badRequest("Missing file path or name.");
      if (!VALID_DOCUMENT_TYPES.has(file.documentType)) return badRequest("Invalid document type.");
    }

    // Server-derived, never trusted from the client: when correcting, the
    // original quantity comes from the original receipt's own row, not
    // whatever the form happened to send.
    let originalQuantityAdded: number | null = null;
    if (body.correctsEntryId) {
      const { data: originalDetails, error: originalError } = await supabaseAdmin
        .from("receiving_details")
        .select("quantity_added_in_material_unit")
        .eq("log_entry_id", body.correctsEntryId)
        .maybeSingle();
      if (originalError) return NextResponse.json({ error: originalError.message }, { status: 500 });
      if (!originalDetails) return badRequest("The entry being corrected was not found.");
      originalQuantityAdded = Number(originalDetails.quantity_added_in_material_unit);
    }

    // Authoritative post-upload verification for every file, before any
    // DB write happens.
    const verifiedFiles: Array<{
      path: string;
      original_filename: string;
      file_size_bytes: number;
      document_type: string;
      label: string | null;
    }> = [];
    for (const file of body.files ?? []) {
      const verified = await verifyUploadedLogEntryDoc(file.path);
      if (!verified.ok) {
        await Promise.all(verifiedPaths.map((p) => removeLogEntryDocObject(p)));
        return badRequest(`"${file.originalFilename}": ${verified.error}`);
      }
      verifiedPaths.push(file.path);
      verifiedFiles.push({
        path: file.path,
        original_filename: file.originalFilename,
        file_size_bytes: verified.sizeBytes,
        document_type: file.documentType,
        label: file.label?.trim() || null,
      });
    }

    // Note: "COA received = yes" with no COA-type file attached is a
    // non-blocking warning shown inline by the form itself (per spec) —
    // the server never rejects a submission over it.

    // The receiving form's fields are code-defined (not from log_fields,
    // which is for the generic dynamic-form log types), but entries still
    // get a values/template_snapshot pair so the generic entries table,
    // entry detail page, and CSV export all work without special-casing
    // receiving entries.
    const field = (key: string, label: string, field_type: string, required: boolean, unit: string | null = null) => ({
      key, label, field_type, required, options: null, min_value: null, max_value: null, unit, help_text: null,
    });
    const templateSnapshot = {
      logTypeName: "Receiving Log",
      entryMode: mode,
      fields:
        mode === "full"
          ? [
              field("raw_material", "Raw material", "text", true),
              field("supplier", "Supplier", "text", true),
              field("supplier_lot_number", "Supplier lot number", "text", true),
              field("internal_lot_id", "Internal lot ID", "text", false),
              field("quantity_added", "Quantity received", "number", true, body.materialUnitAtReceipt),
              field("expiration_date", "Expiration / retest date", "date", false),
              field("po_or_invoice_number", "PO / invoice number", "text", false),
              field("packaging_intact", "Packaging intact", "yes_no", true),
              field("identity_verified", "Identity verified against COA/label", "yes_no", true),
              field("coa_received", "COA received", "yes_no", true),
              field("notes", "Notes", "longtext", false),
            ]
          : [
              field("raw_material", "Raw material", "text", true),
              field("supplier", "Supplier", "text", true),
              field("internal_lot_id", "Internal lot ID", "text", false),
              field("quantity_added", "Quantity received", "number", true, body.materialUnitAtReceipt),
              field("expiration_date", "Expiration date", "date", false),
              field("po_or_invoice_number", "Invoice number", "text", false),
              field("notes", "Notes", "longtext", false),
            ],
    };

    const rawMaterialName = body.newRawMaterial?.name?.trim() || body.rawMaterialName?.trim() || null;
    // The supplier name is filled in by the database from the chosen supplier.
    const values: Record<string, unknown> =
      mode === "full"
        ? {
            raw_material: rawMaterialName,
            supplier_lot_number: body.supplierLotNumber?.trim() ?? "",
            quantity_added: body.quantityAdded,
            expiration_date: body.expirationDate || "",
            po_or_invoice_number: body.poOrInvoiceNumber || "",
            packaging_intact: body.packagingIntact ? "yes" : "no",
            identity_verified: body.identityVerified ? "yes" : "no",
            coa_received: body.coaReceived ? "yes" : "no",
            notes: body.notes || "",
          }
        : {
            raw_material: rawMaterialName,
            quantity_added: body.quantityAdded,
            expiration_date: body.expirationDate || "",
            po_or_invoice_number: body.poOrInvoiceNumber || "",
            notes: body.notes || "",
          };

    const payload = {
      log_type_id: body.logTypeId,
      raw_material_id: body.rawMaterialId || null,
      new_raw_material: body.newRawMaterial
        ? {
            name: body.newRawMaterial.name.trim(),
            unit: body.newRawMaterial.unit.trim(),
            cost_per_unit: body.newRawMaterial.costPerUnit ?? 0,
            par_level: body.newRawMaterial.parLevel ?? null,
          }
        : null,
      corrects_entry_id: body.correctsEntryId || null,
      quantity_added: body.quantityAdded,
      original_quantity_added: originalQuantityAdded,
      performed_at: body.performedAt,
      performed_by_employee_id: null,
      performed_by_name: access.fullName,
      values,
      template_snapshot: templateSnapshot,
      correction_reason: body.correctsEntryId ? body.correctionReason?.trim() : null,
      created_by_account: user.id,
      supplier_id: body.correctsEntryId ? null : body.supplierId,
      entry_mode: mode,
      forced_full: body.forcedFull === true,
      supplier_lot_number: mode === "full" ? body.supplierLotNumber?.trim() || null : null,
      quantity_received_grams: mode === "full" ? body.quantityReceivedGrams ?? null : null,
      material_unit_at_receipt: body.materialUnitAtReceipt.trim(),
      expiration_date: body.expirationDate || null,
      po_or_invoice_number: body.poOrInvoiceNumber?.trim() || null,
      packaging_intact: mode === "full" ? body.packagingIntact : null,
      identity_verified: mode === "full" ? body.identityVerified : null,
      coa_received: mode === "full" ? body.coaReceived : null,
      notes: body.notes?.trim() || null,
      files: verifiedFiles,
    };

    const { data, error } = await supabaseAdmin.rpc("submit_receiving_entry", { payload });
    if (error) {
      await Promise.all(verifiedPaths.map((p) => removeLogEntryDocObject(p)));
      return NextResponse.json({ error: error.message || "Failed to save this receiving entry." }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    await Promise.all(verifiedPaths.map((p) => removeLogEntryDocObject(p)));
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
