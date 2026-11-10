import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createSupplier } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Create a supplier: { supplier: {...} }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ supplier: await createSupplier(procurementDb(), body.supplier, actorName(request)) });
  } catch (error) {
    return procurementError(error);
  }
}
