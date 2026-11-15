import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { setRetailerArchived } from "@/lib/retail/service";
import { actorName, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Archive a retailer (kept with its invoices; hidden from new invoices). */
export async function POST(request: Request, { params }: { params: Promise<{ retailerId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { retailerId } = await params;
    return NextResponse.json({ retailer: await setRetailerArchived(retailDb(), retailerId, true, actorName(request)) });
  } catch (error) {
    return retailError(error);
  }
}
