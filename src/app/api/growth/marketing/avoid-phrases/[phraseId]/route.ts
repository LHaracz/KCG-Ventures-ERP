import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveAvoidPhrase } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson, requireAdminCaller } from "@/lib/growth/routeHelpers";

/** Admin only: edit, archive or restore an avoid-list phrase. */
export async function POST(request: Request, { params }: { params: Promise<{ phraseId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    const { phraseId } = await params;
    await saveAvoidPhrase(growthDb(), phraseId, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
