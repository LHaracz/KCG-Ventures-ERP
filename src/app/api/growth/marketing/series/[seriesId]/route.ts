import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveSeries } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit, archive or restore a subtopic. */
export async function POST(request: Request, { params }: { params: Promise<{ seriesId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { seriesId } = await params;
    return NextResponse.json(await saveSeries(growthDb(), seriesId, await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
