import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadEquipmentPoPrefill, loadLaunchPoPrefill, loadPoPrefill } from "@/lib/procurement/service";
import { procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/**
 * Prefill for a new Purchase Order: { supplier_id, raw_material_ids },
 * { supplier_id, equipment_id }, or from a launch
 * { supplier_id, launch_id, launch_ingredient_ids }. Only ids come from the browser; the
 * supplier, raw materials or equipment are loaded here. Nothing is saved and
 * no PO number is used.
 */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    if (body.launch_id !== undefined) {
      return NextResponse.json(await loadLaunchPoPrefill(procurementDb(), body.supplier_id, body.launch_id, body.launch_ingredient_ids));
    }
    if (body.equipment_id !== undefined) {
      return NextResponse.json(await loadEquipmentPoPrefill(procurementDb(), body.supplier_id, body.equipment_id));
    }
    return NextResponse.json(await loadPoPrefill(procurementDb(), body.supplier_id, body.raw_material_ids ?? []));
  } catch (error) {
    return procurementError(error);
  }
}
