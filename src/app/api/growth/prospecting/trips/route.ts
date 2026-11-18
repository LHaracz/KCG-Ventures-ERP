import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createTrip } from "@/lib/growth/prospectingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Create a trip: { name, trip_date, notes }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ trip: await createTrip(growthDb(), await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
