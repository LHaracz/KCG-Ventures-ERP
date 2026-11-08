import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  LOG_ENTRY_DOCS_BUCKET,
  MAX_LOG_ENTRY_DOC_FILE_BYTES,
  buildLogEntryDocStoragePath,
  isAllowedDocFilename,
  isAllowedDocMimeType,
} from "@/lib/logEntryDocsStorage";
import { guardApi } from "@/lib/access/api";

/**
 * Step 1 of 2 for every log-entry document upload (a new receiving
 * submission's files, or "Add documents" on an existing entry): create a
 * signed upload URL for the browser to PUT the file to directly. The file
 * never passes through this (or any) Next.js route handler, so Vercel's
 * request body limit never applies.
 */

type UploadUrlRequestBody = {
  fileName: string;
  fileSize: number;
  mimeType: string;
  logEntryId?: string;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as UploadUrlRequestBody;
    if (!body?.fileName?.trim()) return badRequest("Missing file name.");
    if (!isAllowedDocFilename(body.fileName)) return badRequest("Only PDF, PNG, or JPG files are supported.");
    if (!isAllowedDocMimeType(body.mimeType)) return badRequest("Only PDF, PNG, or JPG files are supported.");
    if (!Number.isFinite(body.fileSize) || body.fileSize <= 0) return badRequest("Invalid file size.");
    if (body.fileSize > MAX_LOG_ENTRY_DOC_FILE_BYTES) return badRequest("File exceeds the 25 MB limit.");

    const path = buildLogEntryDocStoragePath(body.fileName, body.logEntryId);
    const { data, error } = await supabaseAdmin.storage.from(LOG_ENTRY_DOCS_BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      return NextResponse.json({ error: error?.message || "Could not create an upload URL." }, { status: 500 });
    }

    return NextResponse.json({ path: data.path, token: data.token, signedUrl: data.signedUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
