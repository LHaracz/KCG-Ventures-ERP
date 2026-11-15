import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createRetailer } from "@/lib/retail/service";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Add a retailer: { retailer, terms } (terms by business id; null = use the business default). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ retailer: await createRetailer(retailDb(), body, actorName(request)) });
  } catch (error) {
    return retailError(error);
  }
}
