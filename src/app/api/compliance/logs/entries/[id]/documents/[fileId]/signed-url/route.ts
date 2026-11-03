import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createSignedViewUrl, SIGNED_VIEW_URL_TTL_SECONDS } from "@/lib/logEntryDocsStorage";

/**
 * Short-lived signed URL for viewing or downloading one log entry file.
 * Never returns a permanent URL — every call mints a fresh one (~10 min).
 * Used by the entry detail page's Documents section and by the COAs page.
 * GET .../signed-url            -> inline viewing URL
 * GET .../signed-url?download=1 -> forces Content-Disposition: attachment
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  try {
    const { id: logEntryId, fileId } = await params;
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const { data: file, error } = await supabaseAdmin
      .from("log_entry_files")
      .select("id, log_entry_id, file_path, original_filename, document_type")
      .eq("id", fileId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!file || file.log_entry_id !== logEntryId) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }

    const url = new URL(request.url);
    const wantsDownload = url.searchParams.get("download") === "1";
    const signedUrl = await createSignedViewUrl(file.file_path, wantsDownload ? file.original_filename : undefined);

    return NextResponse.json({
      url: signedUrl,
      expiresInSeconds: SIGNED_VIEW_URL_TTL_SECONDS,
      originalFilename: file.original_filename,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
