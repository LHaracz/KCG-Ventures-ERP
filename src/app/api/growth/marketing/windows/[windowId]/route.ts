import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updateWindow } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit a posting window (becomes own data). */
export async function POST(request: Request, { params }: { params: Promise<{ windowId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { windowId } = await params;
    await updateWindow(growthDb(), windowId, await readJson(request), actorName(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
