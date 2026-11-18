import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createLinkAsset } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Add a link asset (videos and anything stored elsewhere). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ asset: await createLinkAsset(growthDb(), await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
