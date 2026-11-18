import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { premadeAction } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Duplicate, pause, reactivate, archive, restore, sign-offs and flag dismissal. */
export async function POST(request: Request, { params }: { params: Promise<{ premadeId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { premadeId } = await params;
    return NextResponse.json(await premadeAction(growthDb(), premadeId, await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
