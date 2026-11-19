import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { deleteEquipment } from "@/lib/procurement/equipmentDelete";
import { actorName, procurementError, readJson, requireAdminCaller, userDb } from "@/lib/procurement/routeHelpers";

/** Admin only: permanently deletes the equipment item, its listings, and suppliers used only for it. Body: { expected_supplier_ids }. */
export async function POST(request: Request, { params }: { params: Promise<{ equipmentId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    const { equipmentId } = await params;
    const body = await readJson(request);
    return NextResponse.json(await deleteEquipment(await userDb(request), equipmentId, body.expected_supplier_ids, actorName(request)));
  } catch (error) {
    return procurementError(error);
  }
}
