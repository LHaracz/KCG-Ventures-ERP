import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createCategory } from "@/lib/procurement/service";
import { procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Add an equipment category: { name }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ category: await createCategory(procurementDb(), body.name) });
  } catch (error) {
    return procurementError(error);
  }
}
