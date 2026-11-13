import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadEquipmentPoPrefill, loadPoPrefill } from "@/lib/procurement/service";
import { procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/**
 * Prefill for a new Purchase Order: { supplier_id, raw_material_ids } or
 * { supplier_id, equipment_id }. Only ids come from the browser; the
 * supplier, raw materials or equipment are loaded here. Nothing is saved and
 * no PO number is used.
 */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    if (body.equipment_id !== undefined) {
      return NextResponse.json(await loadEquipmentPoPrefill(procurementDb(), body.supplier_id, body.equipment_id));
    }
    return NextResponse.json(await loadPoPrefill(procurementDb(), body.supplier_id, body.raw_material_ids ?? []));
  } catch (error) {
    return procurementError(error);
  }
}
