import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { removeCompanyAssetObject, verifyUploadedLogo } from "@/lib/companyLogoStorage";

/**
 * Step 2 of 2 for a profile logo upload: the browser has already PUT its
 * file to the signed upload URL from /logo-upload-url. This verifies that
 * object is really there (size + magic-byte re-checked from Storage itself,
 * never trusting the client) and only then points this profile's
 * `logo_path` at it.
 *
 * Deliberately never deletes the profile's *previous* logo_path — only a
 * rejected/failed upload's object gets cleaned up (see
 * companyLogoStorage.ts's comment). Older POs' company_snapshot can still
 * reference the old file.
 */

type ConfirmLogoRequestBody = {
  path: string;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: profileId } = await params;
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as ConfirmLogoRequestBody;
    if (!body?.path) return badRequest("Missing uploaded file path.");

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("company_profiles")
      .select("id")
      .eq("id", profileId)
      .maybeSingle();
    if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });
    if (!profile) {
      await removeCompanyAssetObject(body.path);
      return NextResponse.json({ error: "Business profile not found." }, { status: 404 });
    }

    const verified = await verifyUploadedLogo(body.path);
    if (!verified.ok) return badRequest(verified.error);

    const { error: updateError } = await supabaseAdmin
      .from("company_profiles")
      .update({ logo_path: body.path })
      .eq("id", profileId);
    if (updateError) {
      await removeCompanyAssetObject(body.path);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ path: body.path });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
