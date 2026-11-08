import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { removeLogEntryDocObject, verifyUploadedLogEntryDoc } from "@/lib/logEntryDocsStorage";
import { DOCUMENT_TYPES, type LogEntryFile } from "@/lib/complianceLogs";
import { callerOf, guardApi } from "@/lib/access/api";

/**
 * "Add documents later" (entry detail page): the only change allowed on a
 * submitted log entry, and it never alters the entry's own values. Each
 * file must already be uploaded to its signed upload URL before this is
 * called; this re-verifies every file server-side (size + magic bytes)
 * and only then inserts log_entry_files rows with added_after_submit =
 * true. Requires a roster name, since this is a name selection, not an
 * authenticated identity.
 */

type AddDocumentsRequestBody = {
  /** Ignored: "Added by" is the signed-in employee. */
  addedByName?: string;
  files: Array<{
    path: string;
    originalFilename: string;
    documentType: LogEntryFile["document_type"];
    label?: string | null;
  }>;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

const VALID_DOCUMENT_TYPES = new Set(DOCUMENT_TYPES.map((t) => t.value));

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { id: logEntryId } = await params;
  const verifiedPaths: string[] = [];
  try {
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as AddDocumentsRequestBody;
    // "Added by" is the signed-in employee, from the session.
    const { access } = callerOf(request);
    if (!access.fullName || !access.accountId) return badRequest("Your name isn't set. Reload and try again.");
    if (!Array.isArray(body.files) || body.files.length === 0) return badRequest("No files to add.");
    for (const file of body.files) {
      if (!file.path || !file.originalFilename) return badRequest("Missing file path or name.");
      if (!VALID_DOCUMENT_TYPES.has(file.documentType)) return badRequest("Invalid document type.");
    }

    const { data: entry, error: entryError } = await supabaseAdmin
      .from("log_entries")
      .select("id")
      .eq("id", logEntryId)
      .maybeSingle();
    if (entryError) return NextResponse.json({ error: entryError.message }, { status: 500 });
    if (!entry) return badRequest("Log entry not found.");

    const rows = [];
    for (const file of body.files) {
      const verified = await verifyUploadedLogEntryDoc(file.path);
      if (!verified.ok) {
        // Roll back any files already verified/accepted in this same call.
        await Promise.all(verifiedPaths.map((p) => removeLogEntryDocObject(p)));
        return badRequest(`"${file.originalFilename}": ${verified.error}`);
      }
      verifiedPaths.push(file.path);
      rows.push({
        log_entry_id: logEntryId,
        file_path: file.path,
        original_filename: file.originalFilename,
        file_size_bytes: verified.sizeBytes,
        document_type: file.documentType,
        label: file.label?.trim() || null,
        added_by_name: access.fullName,
        added_by_account_id: access.accountId,
        added_after_submit: true,
      });
    }

    const { data: inserted, error: insertError } = await supabaseAdmin.from("log_entry_files").insert(rows).select("*");
    if (insertError) {
      await Promise.all(verifiedPaths.map((p) => removeLogEntryDocObject(p)));
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ files: inserted ?? [] });
  } catch (error) {
    await Promise.all(verifiedPaths.map((p) => removeLogEntryDocObject(p)));
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
