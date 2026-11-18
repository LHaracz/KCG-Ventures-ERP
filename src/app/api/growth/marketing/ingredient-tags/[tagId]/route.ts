import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveIngredientTag } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Rename, archive or restore an ingredient tag. */
export async function POST(request: Request, { params }: { params: Promise<{ tagId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { tagId } = await params;
    return NextResponse.json(await saveIngredientTag(growthDb(), tagId, await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
