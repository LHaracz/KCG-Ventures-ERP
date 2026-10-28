// @react-pdf/renderer needs real Node APIs (fs, for font + logo loading) —
// this route can never run on the Edge runtime.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchPurchaseOrderWithLines } from "@/lib/purchaseOrders";
import { downloadCompanyLogoBytes } from "@/lib/companyLogoStorage";
import { PurchaseOrderPdfDocument } from "@/lib/pdf/purchaseOrderPdf";

/** Strips everything except safe filename characters, then collapses whitespace to dashes — keeps the generated name a single clean quoted-string token, immune to header injection or path tricks. */
function sanitizeForFilename(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const inline = new URL(request.url).searchParams.get("disposition") === "inline";
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "The server isn't configured to generate purchase order PDFs (missing service role key)." },
        { status: 500 },
      );
    }

    const po = await fetchPurchaseOrderWithLines(supabaseAdmin, id);
    if (!po) {
      return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    }

    let logoDataUri: string | null = null;
    if (po.company_snapshot.logo_path) {
      const logo = await downloadCompanyLogoBytes(po.company_snapshot.logo_path);
      if (logo) {
        logoDataUri = `data:${logo.mimeType};base64,${Buffer.from(logo.bytes).toString("base64")}`;
      }
      // A missing/unreadable logo is never fatal — the PDF just renders without one.
    }

    const buffer = await renderToBuffer(<PurchaseOrderPdfDocument po={po} logoDataUri={logoDataUri} />);

    // Only a real download counts for last_downloaded_at — an in-app
    // preview (disposition=inline) never touches it. Best-effort either
    // way: a failed write here should never cost the user their file.
    if (!inline) {
      try {
        await supabaseAdmin.from("purchase_orders").update({ last_downloaded_at: new Date().toISOString() }).eq("id", id);
      } catch {
        // ignored
      }
    }

    const vendorPart = sanitizeForFilename(po.vendor_name);
    const filename = `${sanitizeForFilename(po.po_number)}${vendorPart ? `-${vendorPart}` : ""}.pdf`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
