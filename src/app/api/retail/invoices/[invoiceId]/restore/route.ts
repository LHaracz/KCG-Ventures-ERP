import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { setInvoiceDeleted } from "@/lib/retail/service";
import { retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Restore a deleted invoice (refused if its order number is now used by another invoice). */
export async function POST(request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { invoiceId } = await params;
    return NextResponse.json({ invoice: await setInvoiceDeleted(retailDb(), invoiceId, false) });
  } catch (error) {
    return retailError(error);
  }
}
