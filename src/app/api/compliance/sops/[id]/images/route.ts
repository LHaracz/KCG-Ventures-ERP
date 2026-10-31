import { NextResponse } from "next/server";
import { jsonError, readJson, withSopApi } from "@/lib/sopApi";
import { MAX_SOP_IMAGE_BYTES, SOP_IMAGES_BUCKET, sniffImage } from "@/lib/sopImageStorage";

/**
 * Step 2 of 2: verifies the uploaded object (size from Storage metadata,
 * magic bytes over an HTTP Range read) and records it in sop_images.
 * A file that fails verification is removed from the bucket.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSopApi(request, async ({ admin }) => {
    const { id } = await params;
    const body = await readJson<{ path: string; originalFilename?: string }>(request);
    if (!body.path || !body.path.startsWith(`${id}/`)) return jsonError("Invalid image path.");

    const slash = body.path.lastIndexOf("/");
    const dir = body.path.slice(0, slash);
    const name = body.path.slice(slash + 1);
    const { data: listing, error: listError } = await admin.storage.from(SOP_IMAGES_BUCKET).list(dir, { search: name, limit: 1 });
    if (listError) return jsonError(listError.message, 500);
    const found = listing?.find((f) => f.name === name);
    if (!found) return jsonError("Uploaded image was not found.");
    const size = Number(found.metadata?.size ?? 0);
    if (!size || size > MAX_SOP_IMAGE_BYTES) {
      await admin.storage.from(SOP_IMAGES_BUCKET).remove([body.path]);
      return jsonError("Images must be 10 MB or smaller.");
    }

    const { data: signed } = await admin.storage.from(SOP_IMAGES_BUCKET).createSignedUrl(body.path, 60);
    let kind: string | null = null;
    if (signed?.signedUrl) {
      try {
        const res = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-15" } });
        kind = sniffImage(new Uint8Array(await res.arrayBuffer()));
      } catch {
        kind = null;
      }
    }
    if (!kind) {
      await admin.storage.from(SOP_IMAGES_BUCKET).remove([body.path]);
      return jsonError("This file is not a PNG, JPG or WebP image.");
    }

    const { error } = await admin.from("sop_images").insert({
      sop_id: id,
      path: body.path,
      original_filename: (body.originalFilename ?? "").slice(0, 200) || null,
      file_size_bytes: size,
    });
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ path: body.path });
  });
}
