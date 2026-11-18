import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { scheduleFromLibrary } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Add a library item to the calendar (one entry per platform). */
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
