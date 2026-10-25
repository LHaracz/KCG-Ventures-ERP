import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { removeSopObject, verifyUploadedPdf } from "@/lib/sopStorage";

/**
 * Step 2 of 2 for a brand-new SOP: the browser has already PUT its file to
 * the signed upload URL from /upload-url. This verifies that object is
 * really there (size + "%PDF" magic bytes re-checked from Storage itself,
 * never trusting the client) and only then creates the sops + v1
 * sop_versions rows. If the version insert fails after the SOP row was
 * created, the SOP row is rolled back so a verified-but-orphaned SOP (no
 * versions) never sticks around.
 */

type CreateSopRequestBody = {
  path: string;
  originalFilename: string;
  title: string;
  sopNumber?: string | null;
  description?: string | null;
  effectiveDate?: string | null;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as CreateSopRequestBody;
    if (!body?.path) return badRequest("Missing uploaded file path.");
    if (!body?.title?.trim()) return badRequest("Name is required.");
    if (!body?.originalFilename) return badRequest("Missing original file name.");

    const verified = await verifyUploadedPdf(body.path);
    if (!verified.ok) return badRequest(verified.error);

    const { data: sop, error: sopError } = await supabaseAdmin
      .from("sops")
      .insert({
        title: body.title.trim(),
        sop_number: body.sopNumber?.trim() || null,
        description: body.description?.trim() || null,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (sopError || !sop) {
      await removeSopObject(body.path);
      return NextResponse.json({ error: sopError?.message || "Failed to create the SOP." }, { status: 500 });
    }

    const { data: version, error: versionError } = await supabaseAdmin
      .from("sop_versions")
      .insert({
        sop_id: sop.id,
        version_number: 1,
        file_path: body.path,
        original_filename: body.originalFilename,
        file_size_bytes: verified.sizeBytes,
        effective_date: body.effectiveDate || null,
        change_note: null,
        is_current: true,
        uploaded_by: user.id,
      })
      .select("id")
      .single();
    if (versionError || !version) {
      // Roll back the SOP row so it never sits there with no versions.
      await supabaseAdmin.from("sops").delete().eq("id", sop.id);
      await removeSopObject(body.path);
      return NextResponse.json({ error: versionError?.message || "Failed to save the uploaded version." }, { status: 500 });
    }

    return NextResponse.json({ sopId: sop.id, versionId: version.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
