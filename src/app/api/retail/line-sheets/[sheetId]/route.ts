import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { getLineSheet, updateLineSheet } from "@/lib/retail/lineSheetService";
import { readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** One line sheet with its products. */
export async function GET(request: Request, { params }: { params: Promise<{ sheetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { sheetId } = await params;
    return NextResponse.json({ sheet: await getLineSheet(retailDb(), sheetId) });
  } catch (error) {
    return retailError(error);
  }
}

/** Save edits ({ refresh_prices: true } also refreshes the letterhead and the "prices saved" date). */
export async function POST(request: Request, { params }: { params: Promise<{ sheetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { sheetId } = await params;
    return NextResponse.json(await updateLineSheet(retailDb(), sheetId, await readJson(request)));
  } catch (error) {
    return retailError(error);
  }
}
