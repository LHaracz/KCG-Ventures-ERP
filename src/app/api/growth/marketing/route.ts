import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadMarketing } from "@/lib/growth/marketingService";
import { actorAccountId, growthDb, growthError, isAdminCaller } from "@/lib/growth/routeHelpers";

/** Everything the Marketing Hub shows (never formula data). */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ ...(await loadMarketing(growthDb())), is_admin: isAdminCaller(request), me: actorAccountId(request) });
  } catch (error) {
    return growthError(error);
  }
}
