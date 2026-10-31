import { NextResponse } from "next/server";
import { jsonError, readJson, withSopApi } from "@/lib/sopApi";
import { MAX_SOP_IMAGE_BYTES, SOP_IMAGES_BUCKET, buildSopImagePath, isAllowedImageMime } from "@/lib/sopImageStorage";

/** Step 1 of 2 for an image in a SOP document: a signed upload URL in the private bucket. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSopApi(request, async ({ admin }) => {
    const { id } = await params;
    const body = await readJson<{ mimeType: string; fileSize: number }>(request);
    if (!isAllowedImageMime(body.mimeType)) return jsonError("Images must be PNG, JPG or WebP.");
    if (!Number.isFinite(body.fileSize) || body.fileSize <= 0) return jsonError("Invalid file size.");
    if (body.fileSize > MAX_SOP_IMAGE_BYTES) return jsonError("Images must be 10 MB or smaller.");
    const { data: sop } = await admin.from("sops").select("id").eq("id", id).maybeSingle();
    if (!sop) return jsonError("SOP not found.", 404);
    const path = buildSopImagePath(id, body.mimeType);
    const { data, error } = await admin.storage.from(SOP_IMAGES_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return jsonError(error?.message || "Could not create an upload URL.", 500);
    return NextResponse.json({ path: data.path, token: data.token });
  });
}
