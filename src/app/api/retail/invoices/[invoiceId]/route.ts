import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { getInvoice, updateInvoice } from "@/lib/retail/service";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** One invoice with its lines. */
export async function GET(request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { invoiceId } = await params;
    return NextResponse.json({ invoice: await getInvoice(retailDb(), invoiceId) });
  } catch (error) {
    return retailError(error);
  }
}

/** Save changes to an invoice: { invoice }. The invoice number never changes. */
export async function POST(request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { invoiceId } = await params;
    const body = await readJson(request);
    return NextResponse.json(await updateInvoice(retailDb(), invoiceId, body.invoice, actorName(request)));
  } catch (error) {
    return retailError(error);
  }
}
