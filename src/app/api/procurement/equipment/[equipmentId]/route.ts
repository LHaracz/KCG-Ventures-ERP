import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updateEquipment } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Edit an equipment item's name, category and description: { equipment }. */
export async function POST(request: Request, { params }: { params: Promise<{ equipmentId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { equipmentId } = await params;
    const body = await readJson(request);
    return NextResponse.json({ equipment: await updateEquipment(procurementDb(), equipmentId, body.equipment, actorName(request)) });
  } catch (error) {
    return procurementError(error);
  }
}
