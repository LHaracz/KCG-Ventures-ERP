import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createThumbnailUploadUrl } from "@/lib/growth/marketingService";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** "Make thumbnails", step 1: a signed upload URL for this photo's small grid JPG. */
export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { assetId } = await params;
    return NextResponse.json(await createThumbnailUploadUrl(growthDb(), assetId));
  } catch (error) {
    return growthError(error);
  }
}
