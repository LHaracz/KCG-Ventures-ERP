// @react-pdf/renderer and sharp need Node APIs, never the Edge runtime.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { getLineSheet, markLineSheetDownloaded, renderLineSheetPdf, retailerNameOf } from "@/lib/retail/lineSheetService";
import { lineSheetFilename } from "@/lib/retail/lineSheets";
import { pdfResponseHeaders } from "@/lib/retail/renderInvoicePdf";
import { asciiFilename } from "@/lib/retail/snapshots";
import { retailDb, retailError } from "@/lib/retail/routeHelpers";

/** The saved line sheet as a PDF. ?disposition=inline is the in-app viewer; anything else is a download and sets last_downloaded_at. */
export async function GET(request: Request, { params }: { params: Promise<{ sheetId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { sheetId } = await params;
    const inline = new URL(request.url).searchParams.get("disposition") === "inline";
    const db = retailDb();
    const sheet = await getLineSheet(db, sheetId);
    const buffer = await renderLineSheetPdf(db, sheet, { retailerName: await retailerNameOf(db, sheet.retailer_id) });
    if (!inline) {
      try {
        await markLineSheetDownloaded(db, sheet.id);
      } catch {
        // A failed timestamp never costs the user their file.
      }
    }
    const filename = lineSheetFilename(sheet.name);
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers: pdfResponseHeaders(filename, asciiFilename(filename), inline, buffer.length) });
  } catch (error) {
    return retailError(error);
  }
}
