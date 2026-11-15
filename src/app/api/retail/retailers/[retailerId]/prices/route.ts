import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { savePrices } from "@/lib/retail/service";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Save price list rows: { prices: [{ product_id, wholesale_price, msrp, notes }] }. */
export async function POST(request: Request, { params }: { params: Promise<{ retailerId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { retailerId } = await params;
    const body = await readJson(request);
    return NextResponse.json({ prices: await savePrices(retailDb(), retailerId, body.prices, actorName(request)) });
  } catch (error) {
    return retailError(error);
  }
}
