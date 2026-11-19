import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { previewEquipmentDelete } from "@/lib/procurement/equipmentDelete";
import { procurementDb, procurementError, requireAdminCaller } from "@/lib/procurement/routeHelpers";

/** Admin only, read only: what deleting this equipment item would delete and keep. */
export async function GET(request: Request, { params }: { params: Promise<{ equipmentId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    const { equipmentId } = await params;
    return NextResponse.json(await previewEquipmentDelete(procurementDb(), equipmentId));
  } catch (error) {
    return procurementError(error);
  }
}
