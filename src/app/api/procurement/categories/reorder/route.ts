import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { reorderCategories } from "@/lib/procurement/service";
import { procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Set the order of the active categories: { ids: [...] }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ categories: await reorderCategories(procurementDb(), body.ids) });
  } catch (error) {
    return procurementError(error);
  }
}
