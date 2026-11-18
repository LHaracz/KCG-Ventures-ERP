import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createPremade } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New library item (reel or picture post). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await createPremade(growthDb(), await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
