import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveRiskyWord } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson, requireAdminCaller } from "@/lib/growth/routeHelpers";

/** Admin only: edit, archive or restore a watch-list word. */
export async function POST(request: Request, { params }: { params: Promise<{ wordId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    const { wordId } = await params;
    await saveRiskyWord(growthDb(), wordId, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
