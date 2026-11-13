import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { restoreEquipment } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Restore an archived equipment item. */
export async function POST(request: Request, { params }: { params: Promise<{ equipmentId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { equipmentId } = await params;
    return NextResponse.json({ equipment: await restoreEquipment(procurementDb(), equipmentId, actorName(request)) });
  } catch (error) {
    return procurementError(error);
  }
}
