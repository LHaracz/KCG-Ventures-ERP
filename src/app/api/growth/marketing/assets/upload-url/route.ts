import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createAssetUploadUrl } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Upload step 1: a signed upload URL for { mime_type, size_bytes } (PNG, JPG, WebP, PDF; 25 MB). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await createAssetUploadUrl(growthDb(), await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
