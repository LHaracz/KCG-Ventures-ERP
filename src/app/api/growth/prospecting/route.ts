import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadProspecting } from "@/lib/growth/prospectingService";
import { growthDb, growthError, isAdminCaller } from "@/lib/growth/routeHelpers";

/** Leads, trips, the funnel, follow-ups, the goal and assignable people. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ ...(await loadProspecting(growthDb())), is_admin: isAdminCaller(request) });
  } catch (error) {
    return growthError(error);
  }
}
