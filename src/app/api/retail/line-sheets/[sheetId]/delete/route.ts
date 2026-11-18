import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { setLineSheetDeleted } from "@/lib/retail/lineSheetService";
import { readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Delete (soft) or { restore: true }. */
export async function POST(request: Request, { params }: { params: Promise<{ sheetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { sheetId } = await params;
    const body = await readJson(request);
    await setLineSheetDeleted(retailDb(), sheetId, body.restore !== true);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return retailError(error);
  }
}
