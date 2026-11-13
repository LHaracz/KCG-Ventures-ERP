import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { archiveEquipment } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Archive an equipment item and its supplier listings. Nothing is deleted. */
export async function POST(request: Request, { params }: { params: Promise<{ equipmentId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { equipmentId } = await params;
    return NextResponse.json(await archiveEquipment(procurementDb(), equipmentId, actorName(request)));
  } catch (error) {
    return procurementError(error);
  }
}
