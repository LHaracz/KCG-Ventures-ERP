import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updateSupplier } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Update a supplier's shared details (every ingredient it supplies): { supplier: {...} }. */
export async function POST(request: Request, { params }: { params: Promise<{ supplierId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { supplierId } = await params;
    const body = await readJson(request);
    return NextResponse.json({ supplier: await updateSupplier(procurementDb(), supplierId, body.supplier, actorName(request)) });
  } catch (error) {
    return procurementError(error);
  }
}
