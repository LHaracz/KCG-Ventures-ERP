import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveClosingLine } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New closing line. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await saveClosingLine(growthDb(), null, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
