import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { voidActivity } from "@/lib/growth/prospectingService";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Void an activity (kept, shown crossed out). */
export async function POST(request: Request, { params }: { params: Promise<{ leadId: string; activityId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { leadId, activityId } = await params;
    return NextResponse.json({ activity: await voidActivity(growthDb(), leadId, activityId) });
  } catch (error) {
    return growthError(error);
  }
}
