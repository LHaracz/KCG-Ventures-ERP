import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { premadeBulk } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Bulk actions on selected library items. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await premadeBulk(growthDb(), await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
