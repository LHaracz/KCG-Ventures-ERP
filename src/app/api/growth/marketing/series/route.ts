import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveSeries } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New subtopic: { pillar_id, name }. The letter is assigned in the database. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await saveSeries(growthDb(), null, await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
