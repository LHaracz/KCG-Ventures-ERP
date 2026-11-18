import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { duplicateLineSheet } from "@/lib/retail/lineSheetService";
import { actorName, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Copy a line sheet (same products and saved prices). */
export async function POST(request: Request, { params }: { params: Promise<{ sheetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { sheetId } = await params;
    return NextResponse.json(await duplicateLineSheet(retailDb(), sheetId, actorName(request)));
  } catch (error) {
    return retailError(error);
  }
}
