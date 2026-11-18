import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { reviewClaim } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson, requireAdminCaller } from "@/lib/growth/routeHelpers";

/** Admin only: { action: "approve" | "reject" | "retire", note, review_again_on }. */
export async function POST(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    const { claimId } = await params;
    return NextResponse.json({ claim: await reviewClaim(growthDb(), claimId, await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
