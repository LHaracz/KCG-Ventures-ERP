import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadRetailerDetail, updateRetailer } from "@/lib/retail/service";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** A retailer with its terms, price list and invoices. */
export async function GET(request: Request, { params }: { params: Promise<{ retailerId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { retailerId } = await params;
    return NextResponse.json(await loadRetailerDetail(retailDb(), retailerId));
  } catch (error) {
    return retailError(error);
  }
}

/** Edit a retailer: { retailer, terms }. */
export async function POST(request: Request, { params }: { params: Promise<{ retailerId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { retailerId } = await params;
    const body = await readJson(request);
    return NextResponse.json({ retailer: await updateRetailer(retailDb(), retailerId, body, actorName(request)) });
  } catch (error) {
    return retailError(error);
  }
}
