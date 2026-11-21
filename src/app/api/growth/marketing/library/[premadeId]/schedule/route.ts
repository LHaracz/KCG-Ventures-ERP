import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { scheduleFromLibrary } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Schedule a library post: { date, time?, platforms, schedule_anyway? } (one entry per platform, one schedule group). */
export async function POST(request: Request, { params }: { params: Promise<{ premadeId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { premadeId } = await params;
    return NextResponse.json(await scheduleFromLibrary(growthDb(), premadeId, await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
