import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveThumbnail } from "@/lib/growth/marketingService";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** "Make thumbnails", step 2: check the uploaded JPG and link it to the photo. */
export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { assetId } = await params;
    return NextResponse.json(await saveThumbnail(growthDb(), assetId));
  } catch (error) {
    return growthError(error);
  }
}
