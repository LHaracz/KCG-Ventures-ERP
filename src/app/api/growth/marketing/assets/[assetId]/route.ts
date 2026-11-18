import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updateAsset } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit an asset, or { status } alone (Mark ready, Archive, Restore). */
export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { assetId } = await params;
    return NextResponse.json({ asset: await updateAsset(growthDb(), assetId, await readJson(request)) });
  } catch (error) {
    return growthError(error);
  }
}
