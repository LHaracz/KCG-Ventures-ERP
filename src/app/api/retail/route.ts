import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadRetailBootstrap } from "@/lib/retail/service";
import { retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Businesses, invoice settings, retailers, terms, products and invoice counts for the Retail pages. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await loadRetailBootstrap(retailDb()));
  } catch (error) {
    return retailError(error);
  }
}
