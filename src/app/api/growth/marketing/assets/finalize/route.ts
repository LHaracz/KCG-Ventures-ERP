import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { finalizeUpload } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Upload step 2: check the uploaded file (size and signature) and save the asset. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ asset: await finalizeUpload(growthDb(), await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
