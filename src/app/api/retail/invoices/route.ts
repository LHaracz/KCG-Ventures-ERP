import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createInvoice, listInvoices } from "@/lib/retail/service";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Invoices, newest number first, 20 per page. Query: q, business, retailer, terms, from, to, deleted=1, page. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const sp = new URL(request.url).searchParams;
    const page = Number(sp.get("page") ?? "1");
    return NextResponse.json(
      await listInvoices(retailDb(), {
        q: sp.get("q") ?? undefined,
        businessId: sp.get("business") ?? undefined,
        retailerId: sp.get("retailer") ?? undefined,
        termsType: sp.get("terms") ?? undefined,
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
        includeDeleted: sp.get("deleted") === "1",
        page: Number.isInteger(page) && page > 0 ? page : 1,
      }),
    );
  } catch (error) {
    return retailError(error);
  }
}

/** Create an invoice. The database assigns the invoice number. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json(await createInvoice(retailDb(), body.invoice, actorName(request)));
  } catch (error) {
    return retailError(error);
  }
}
