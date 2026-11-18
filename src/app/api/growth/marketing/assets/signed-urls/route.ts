import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { signedAssetUrls } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Short-lived signed URLs: { ids, download? }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ urls: await signedAssetUrls(growthDb(), body.ids, { download: body.download === true }) });
  } catch (error) {
    return growthError(error);
  }
}
