import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveClosingLine } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit, archive or restore a closing line. */
export async function POST(request: Request, { params }: { params: Promise<{ lineId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { lineId } = await params;
    await saveClosingLine(growthDb(), lineId, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
