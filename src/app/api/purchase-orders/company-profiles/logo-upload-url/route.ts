import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  COMPANY_ASSETS_BUCKET,
  MAX_LOGO_FILE_BYTES,
  buildCompanyLogoStoragePath,
  isAllowedLogoFilename,
  isAllowedLogoMimeType,
} from "@/lib/companyLogoStorage";

/**
 * Step 1 of 2 for a profile logo upload: create a signed upload URL for the
 * browser to PUT the file to directly (mirrors
 * /api/compliance/sops/upload-url). The file never passes through this
 * route handler.
 */

type UploadUrlRequestBody = {
  fileName: string;
  fileSize: number;
  mimeType: string;
  profileId?: string;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
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
    if (!isAllowedLogoFilename(body.fileName)) return badRequest("Only PNG or JPG files are supported.");
    if (!isAllowedLogoMimeType(body.mimeType)) return badRequest("Only PNG or JPG files are supported.");
    if (!Number.isFinite(body.fileSize) || body.fileSize <= 0) return badRequest("Invalid file size.");
    if (body.fileSize > MAX_LOGO_FILE_BYTES) return badRequest("File exceeds the 2 MB limit.");

    const path = buildCompanyLogoStoragePath(body.fileName, body.profileId);
    const { data, error } = await supabaseAdmin.storage.from(COMPANY_ASSETS_BUCKET).createSignedUploadUrl(path);
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
