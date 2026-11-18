import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { logActivity } from "@/lib/growth/prospectingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Log an activity: { activity, trip_stop_id? }. Outcomes can move the lead's status. */
export async function POST(request: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { leadId } = await params;
    const body = await readJson(request);
    const stop = typeof body.trip_stop_id === "string" ? body.trip_stop_id : null;
    return NextResponse.json({ activity: await logActivity(growthDb(), leadId, body.activity, actorName(request), { tripStopId: stop }) });
  } catch (error) {
    return growthError(error);
  }
}
