import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updatePillar } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit a pillar, or { archive } / { restore } / { move_items_to }. */
export async function POST(request: Request, { params }: { params: Promise<{ pillarId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { pillarId } = await params;
    return NextResponse.json(await updatePillar(growthDb(), pillarId, await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
