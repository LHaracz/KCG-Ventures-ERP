import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createEquipment } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Add an equipment item: { equipment: { name, category_id, description } }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ equipment: await createEquipment(procurementDb(), body.equipment, actorName(request)) });
  } catch (error) {
    return procurementError(error);
  }
}
