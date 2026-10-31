import { NextResponse } from "next/server";
import { jsonError, readJson, withSopApi } from "@/lib/sopApi";
import { SOP_IMAGES_BUCKET, SOP_IMAGE_URL_TTL_SECONDS } from "@/lib/sopImageStorage";

/** Resolves image bucket paths to short-lived signed URLs at render time. Only recorded SOP images. */
export async function POST(request: Request) {
  return withSopApi(request, async ({ admin }) => {
    const body = await readJson<{ paths: string[] }>(request);
    const paths = Array.from(new Set((body.paths ?? []).filter((p) => typeof p === "string" && p))).slice(0, 200);
    if (paths.length === 0) return NextResponse.json({ urls: {} });
    const { data: known, error } = await admin.from("sop_images").select("path").in("path", paths);
    if (error) return jsonError(error.message, 500);
    const allowed = ((known ?? []) as { path: string }[]).map((k) => k.path);
    const urls: Record<string, string> = {};
    if (allowed.length) {
      const { data, error: signError } = await admin.storage.from(SOP_IMAGES_BUCKET).createSignedUrls(allowed, SOP_IMAGE_URL_TTL_SECONDS);
      if (signError) return jsonError(signError.message, 500);
      for (const d of data ?? []) if (d.path && d.signedUrl) urls[d.path] = d.signedUrl;
    }
    return NextResponse.json({ urls, expiresInSeconds: SOP_IMAGE_URL_TTL_SECONDS });
  });
}
