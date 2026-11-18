import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadTrip, updateTrip } from "@/lib/growth/prospectingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** A trip with its stops in order. */
export async function GET(request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { tripId } = await params;
    return NextResponse.json(await loadTrip(growthDb(), tripId));
  } catch (error) {
    return growthError(error);
  }
}

/** Edit a trip (name, date, notes, status). */
export async function POST(request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { tripId } = await params;
    return NextResponse.json({ trip: await updateTrip(growthDb(), tripId, await readJson(request)) });
  } catch (error) {
    return growthError(error);
  }
}
