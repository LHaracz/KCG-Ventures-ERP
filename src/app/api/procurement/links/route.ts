import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { addLink } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Add a supplier to a raw material: { raw_material_id, supplier_id | new_supplier, link, make_preferred }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ link: await addLink(procurementDb(), body, actorName(request)) });
  } catch (error) {
    return procurementError(error);
  }
}
