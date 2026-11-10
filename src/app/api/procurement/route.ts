import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadProcurementData } from "@/lib/procurement/service";
import { procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Raw materials, suppliers (archived included) and active supplier links for the Procurement pages. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await loadProcurementData(procurementDb()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return procurementError(error);
  }
}
