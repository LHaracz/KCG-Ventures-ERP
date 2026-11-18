import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveRiskyWord } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson, requireAdminCaller } from "@/lib/growth/routeHelpers";

/** Admin only: add a word or phrase to the watch list. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    await saveRiskyWord(growthDb(), null, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
