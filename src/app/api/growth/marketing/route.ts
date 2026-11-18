import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadMarketing } from "@/lib/growth/marketingService";
import { loadLibraryData } from "@/lib/growth/libraryService";
import { actorAccountId, growthDb, growthError, isAdminCaller } from "@/lib/growth/routeHelpers";

/** Everything the Marketing Hub shows, including the Ad Library (never formula data). */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const db = growthDb();
    const [hub, library] = await Promise.all([loadMarketing(db), loadLibraryData(db)]);
    return NextResponse.json({ ...hub, ...library, is_admin: isAdminCaller(request), me: actorAccountId(request) });
  } catch (error) {
    return growthError(error);
  }
}
