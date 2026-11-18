import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { tripStopsAction } from "@/lib/growth/prospectingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Stops: { action: "add", lead_ids } | { action: "remove", stop_id } | { action: "reorder", stop_ids } | { action: "sort_zip" }. */
export async function POST(request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { tripId } = await params;
    await tripStopsAction(growthDb(), tripId, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
