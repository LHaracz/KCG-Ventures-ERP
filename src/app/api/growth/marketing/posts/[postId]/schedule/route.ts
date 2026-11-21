import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { editSchedule } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit schedule for the entry's group: { date, time, platforms } (or { date, time, platform } for an entry with no library post). */
export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { postId } = await params;
    return NextResponse.json(await editSchedule(growthDb(), postId, await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
