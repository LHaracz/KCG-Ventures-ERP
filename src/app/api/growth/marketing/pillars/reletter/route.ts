import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { reletterPillars } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Re-letter alphabetically: { apply: false } previews, { apply: true } applies in one transaction. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ plan: await reletterPillars(growthDb(), body.apply === true) });
  } catch (error) {
    return growthError(error);
  }
}
