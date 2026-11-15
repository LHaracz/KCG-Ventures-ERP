import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { setRetailerArchived } from "@/lib/retail/service";
import { actorName, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Restore an archived retailer. */
export async function POST(request: Request, { params }: { params: Promise<{ retailerId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { retailerId } = await params;
    return NextResponse.json({ retailer: await setRetailerArchived(retailDb(), retailerId, false, actorName(request)) });
  } catch (error) {
    return retailError(error);
  }
}
