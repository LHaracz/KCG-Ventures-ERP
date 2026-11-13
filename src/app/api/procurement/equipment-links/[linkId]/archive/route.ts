import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { archiveEquipmentLink } from "@/lib/procurement/service";
import { procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Remove a supplier from an equipment item (archives the listing). */
export async function POST(request: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { linkId } = await params;
    return NextResponse.json({ link: await archiveEquipmentLink(procurementDb(), linkId) });
  } catch (error) {
    return procurementError(error);
  }
}
