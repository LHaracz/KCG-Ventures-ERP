import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createSignedViewUrl, SIGNED_VIEW_URL_TTL_SECONDS } from "@/lib/sopStorage";

/**
 * Short-lived signed URL for viewing or downloading one version's file.
 * Never returns a permanent URL — every call mints a fresh one (~10 min).
 * GET .../signed-url            -> inline viewing URL
 * GET .../signed-url?download=1 -> forces Content-Disposition: attachment
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const { id: sopId, versionId } = await params;
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const { data: version, error } = await supabaseAdmin
      .from("sop_versions")
      .select("id, sop_id, file_path, original_filename")
      .eq("id", versionId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!version || version.sop_id !== sopId) {
      return NextResponse.json({ error: "Version not found." }, { status: 404 });
    }

    const url = new URL(request.url);
    const wantsDownload = url.searchParams.get("download") === "1";
    const signedUrl = await createSignedViewUrl(
      version.file_path,
      wantsDownload ? version.original_filename : undefined,
    );

    return NextResponse.json({ url: signedUrl, expiresInSeconds: SIGNED_VIEW_URL_TTL_SECONDS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
