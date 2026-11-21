import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { listAssetPage } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** One page (20) of assets for the card picker: { page, category, kind, q, product }. Newest first. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await listAssetPage(growthDb(), await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
