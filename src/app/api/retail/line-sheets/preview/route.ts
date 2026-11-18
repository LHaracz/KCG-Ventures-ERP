// @react-pdf/renderer and sharp need Node APIs, never the Edge runtime.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { buildPreviewLineSheet, renderLineSheetPdf, retailerNameOf } from "@/lib/retail/lineSheetService";
import { lineSheetFilename } from "@/lib/retail/lineSheets";
import { pdfResponseHeaders } from "@/lib/retail/renderInvoicePdf";
import { asciiFilename } from "@/lib/retail/snapshots";
import { readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Preview PDF of the builder's current (unsaved) state: { sheet, existing_id }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    const db = retailDb();
    const sheet = await buildPreviewLineSheet(db, (body.sheet ?? {}) as Record<string, unknown>, body.existing_id ?? null);
    const buffer = await renderLineSheetPdf(db, sheet, { retailerName: await retailerNameOf(db, sheet.retailer_id) });
    const filename = lineSheetFilename(sheet.name);
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers: pdfResponseHeaders(filename, asciiFilename(filename), true, buffer.length) });
  } catch (error) {
    return retailError(error);
  }
}
