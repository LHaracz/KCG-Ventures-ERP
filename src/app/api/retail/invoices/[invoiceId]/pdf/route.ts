// @react-pdf/renderer needs Node APIs (fonts, logo), never the Edge runtime.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { getInvoice, markDownloaded } from "@/lib/retail/service";
import { asciiFilename, invoiceFilename } from "@/lib/retail/snapshots";
import { pdfResponseHeaders, renderInvoicePdf } from "@/lib/retail/renderInvoicePdf";
import { retailDb, retailError } from "@/lib/retail/routeHelpers";

/**
 * The invoice PDF. ?disposition=inline is the in-app viewer and does not
 * count as a download; anything else is a download and sets
 * last_downloaded_at (best effort).
 */
export async function GET(request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { invoiceId } = await params;
    const inline = new URL(request.url).searchParams.get("disposition") === "inline";
    const db = retailDb();
    const invoice = await getInvoice(db, invoiceId);
    const buffer = await renderInvoicePdf(invoice);
    if (!inline) {
      try {
        await markDownloaded(db, invoice.id);
      } catch {
        // A failed timestamp never costs the user their file.
      }
    }
    const filename = invoiceFilename(invoice.invoice_number, invoice.order_number, invoice.retailer_snapshot.name);
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers: pdfResponseHeaders(filename, asciiFilename(filename), inline, buffer.length) });
  } catch (error) {
    return retailError(error);
  }
}
