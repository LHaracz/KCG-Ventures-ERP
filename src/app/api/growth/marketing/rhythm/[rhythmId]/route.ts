import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveRhythm } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit, archive or restore a rhythm row. */
export async function POST(request: Request, { params }: { params: Promise<{ rhythmId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { rhythmId } = await params;
    await saveRhythm(growthDb(), rhythmId, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
