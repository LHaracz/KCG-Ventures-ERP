import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { submitClaim } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Submit a claim for review. */
export async function POST(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { claimId } = await params;
    return NextResponse.json({ claim: await submitClaim(growthDb(), claimId, actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
