import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { archiveSupplier } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Archive a supplier and its ingredient links. Nothing is deleted. */
export async function POST(request: Request, { params }: { params: Promise<{ supplierId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { supplierId } = await params;
    return NextResponse.json(await archiveSupplier(procurementDb(), supplierId, actorName(request)));
  } catch (error) {
    return procurementError(error);
  }
}
