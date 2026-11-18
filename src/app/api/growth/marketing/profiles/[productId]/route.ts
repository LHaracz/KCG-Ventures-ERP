import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveProfile } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Save a product's marketing profile. */
export async function POST(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { productId } = await params;
    return NextResponse.json({ profile: await saveProfile(growthDb(), productId, await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
