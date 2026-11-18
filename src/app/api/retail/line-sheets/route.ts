import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createLineSheet, listLineSheets, loadLineSheetBuilder } from "@/lib/retail/lineSheetService";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Line sheets (?deleted=1 for deleted ones) and everything the builder needs. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const deleted = new URL(request.url).searchParams.get("deleted") === "1";
    const db = retailDb();
    const [rows, builder] = await Promise.all([listLineSheets(db, { deleted }), loadLineSheetBuilder(db)]);
    return NextResponse.json({ rows, builder });
  } catch (error) {
    return retailError(error);
  }
}

/** New line sheet (company and prices are saved with it). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await createLineSheet(retailDb(), await readJson(request), actorName(request)));
  } catch (error) {
    return retailError(error);
  }
}
