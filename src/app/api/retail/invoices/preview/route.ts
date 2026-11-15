// @react-pdf/renderer needs Node APIs (fonts, logo), never the Edge runtime.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { buildPreviewInvoice } from "@/lib/retail/service";
import { pdfResponseHeaders, renderInvoicePdf } from "@/lib/retail/renderInvoicePdf";
import { readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** "Preview PDF" for an unsaved invoice: { invoice, existing_id? }. Nothing is saved and no number is used. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    const existingId = typeof body.existing_id === "string" ? body.existing_id : null;
    const invoice = await buildPreviewInvoice(retailDb(), body.invoice, existingId);
    const buffer = await renderInvoicePdf(invoice);
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers: pdfResponseHeaders("preview.pdf", "preview.pdf", true, buffer.length) });
  } catch (error) {
    return retailError(error);
  }
}
