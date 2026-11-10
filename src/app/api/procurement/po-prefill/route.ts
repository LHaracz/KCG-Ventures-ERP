import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadPoPrefill } from "@/lib/procurement/service";
import { procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/**
 * Prefill for a new Purchase Order: { supplier_id, raw_material_ids }. Only
 * ids come from the browser; the supplier and raw materials are loaded here.
 * Nothing is saved and no PO number is used.
 */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json(await loadPoPrefill(procurementDb(), body.supplier_id, body.raw_material_ids ?? []));
  } catch (error) {
    return procurementError(error);
  }
}
