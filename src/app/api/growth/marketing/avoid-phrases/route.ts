import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveAvoidPhrase } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson, requireAdminCaller } from "@/lib/growth/routeHelpers";

/** Admin only: add an avoid-list phrase. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    await saveAvoidPhrase(growthDb(), null, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
