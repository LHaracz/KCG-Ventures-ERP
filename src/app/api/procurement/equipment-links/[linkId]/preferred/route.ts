import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { makeEquipmentPreferred } from "@/lib/procurement/service";
import { procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Make this listing the item's preferred supplier (one transaction). */
export async function POST(request: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { linkId } = await params;
    return NextResponse.json({ link: await makeEquipmentPreferred(procurementDb(), linkId) });
  } catch (error) {
    return procurementError(error);
  }
}
