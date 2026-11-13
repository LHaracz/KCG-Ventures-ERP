import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { renameCategory } from "@/lib/procurement/service";
import { procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Rename an equipment category: { name }. */
export async function POST(request: Request, { params }: { params: Promise<{ categoryId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { categoryId } = await params;
    const body = await readJson(request);
    return NextResponse.json({ category: await renameCategory(procurementDb(), categoryId, body.name) });
  } catch (error) {
    return procurementError(error);
  }
}
