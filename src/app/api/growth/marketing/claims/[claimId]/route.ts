import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updateClaim } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit a claim. Editing an approved claim's text resets it to draft. */
export async function POST(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { claimId } = await params;
    return NextResponse.json({ claim: await updateClaim(growthDb(), claimId, await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
