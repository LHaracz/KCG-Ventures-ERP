import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveIngredientTag } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New ingredient tag. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await saveIngredientTag(growthDb(), null, await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
