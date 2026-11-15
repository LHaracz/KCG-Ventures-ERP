import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { setInvoiceDeleted } from "@/lib/retail/service";
import { retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Delete an invoice (kept, marked VOID, number never reused). */
export async function POST(request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { invoiceId } = await params;
    return NextResponse.json({ invoice: await setInvoiceDeleted(retailDb(), invoiceId, true) });
  } catch (error) {
    return retailError(error);
  }
}
