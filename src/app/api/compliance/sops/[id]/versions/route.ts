import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { removeSopObject, verifyUploadedPdf } from "@/lib/sopStorage";

/**
 * Step 2 of 2 for "Upload New Version": the browser has already PUT its
 * file to the signed upload URL from /api/compliance/sops/upload-url
 * (called with this sop's id so the stored path is namespaced under it).
 * This re-verifies the object (size + "%PDF" magic bytes) and only then:
 *   1. flips the SOP's current version row to is_current = false
 *   2. inserts the new version row with is_current = true
 * Step 1 must happen before step 2 — idx_sop_versions_one_current_per_sop
 * (a partial unique index on sop_versions(sop_id) where is_current) would
 * reject inserting a second current row while the old one is still current.
 * If step 2 fails after step 1 succeeded, step 1 is rolled back so the SOP
 * never ends up with zero current versions.
 */

type CreateVersionRequestBody = {
  path: string;
  originalFilename: string;
  changeNote: string;
  effectiveDate?: string | null;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Lists every version for a SOP, newest first, with each uploader's email
 * resolved via the admin API — the browser's client can't read auth.users
 * directly, and this app has no separate public "profiles" table, so this
 * is the one place that needs the service-role key just to show "uploaded
 * by so-and-so" in the version selector.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: sopId } = await params;
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const { data: versions, error } = await supabaseAdmin
      .from("sop_versions")
      .select(
        "id, version_number, original_filename, file_size_bytes, effective_date, change_note, is_current, uploaded_by, uploaded_at",
      )
      .eq("sop_id", sopId)
      .order("version_number", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const uploaderIds = Array.from(new Set((versions ?? []).map((v) => v.uploaded_by).filter(Boolean))) as string[];
    const uploaderEmails: Record<string, string> = {};
    await Promise.all(
      uploaderIds.map(async (id) => {
        try {
          const { data } = await supabaseAdmin!.auth.admin.getUserById(id);
          if (data?.user?.email) uploaderEmails[id] = data.user.email;
        } catch {
          // A deleted/unknown user just falls back to no display name below.
        }
      }),
    );

    return NextResponse.json({ versions: versions ?? [], uploaderEmails });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: sopId } = await params;
    const user = await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as CreateVersionRequestBody;
    if (!body?.path) return badRequest("Missing uploaded file path.");
    if (!body?.originalFilename) return badRequest("Missing original file name.");
    if (!body?.changeNote?.trim()) return badRequest('"What changed?" is required.');

    const { data: sop, error: sopError } = await supabaseAdmin
      .from("sops")
      .select("id")
      .eq("id", sopId)
      .maybeSingle();
    if (sopError) return NextResponse.json({ error: sopError.message }, { status: 500 });
    if (!sop) return badRequest("SOP not found.");

    const { data: existingVersions, error: listError } = await supabaseAdmin
      .from("sop_versions")
      .select("id, version_number, is_current")
      .eq("sop_id", sopId)
      .order("version_number", { ascending: false })
      .limit(1);
    if (listError) return NextResponse.json({ error: listError.message }, { status: 500 });

    const previousCurrent = existingVersions?.find((v) => v.is_current) ?? existingVersions?.[0];
    const nextVersionNumber = (existingVersions?.[0]?.version_number ?? 0) + 1;

    const verified = await verifyUploadedPdf(body.path);
    if (!verified.ok) return badRequest(verified.error);

    // Step 1: demote the current version first (required by the partial
    // unique index before the new current row can be inserted).
    if (previousCurrent) {
      const { error: demoteError } = await supabaseAdmin
        .from("sop_versions")
        .update({ is_current: false })
        .eq("id", previousCurrent.id);
      if (demoteError) {
        await removeSopObject(body.path);
        return NextResponse.json({ error: demoteError.message }, { status: 500 });
      }
    }

    // Step 2: insert the new current version.
    const { data: version, error: versionError } = await supabaseAdmin
      .from("sop_versions")
      .insert({
        sop_id: sopId,
        version_number: nextVersionNumber,
        file_path: body.path,
        original_filename: body.originalFilename,
        file_size_bytes: verified.sizeBytes,
        effective_date: body.effectiveDate || null,
        change_note: body.changeNote.trim(),
        is_current: true,
        uploaded_by: user.id,
      })
      .select("id, version_number")
      .single();

    if (versionError || !version) {
      // Roll back step 1 so the SOP isn't left with no current version.
      if (previousCurrent) {
        await supabaseAdmin.from("sop_versions").update({ is_current: true }).eq("id", previousCurrent.id);
      }
      await removeSopObject(body.path);
      return NextResponse.json({ error: versionError?.message || "Failed to save the new version." }, { status: 500 });
    }

    return NextResponse.json({ versionId: version.id, versionNumber: version.version_number });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
