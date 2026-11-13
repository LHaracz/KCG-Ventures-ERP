import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { archiveCategory } from "@/lib/procurement/service";
import { procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Archive a category. Refused while any active equipment item uses it. */
export async function POST(request: Request, { params }: { params: Promise<{ categoryId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { categoryId } = await params;
    return NextResponse.json({ category: await archiveCategory(procurementDb(), categoryId) });
  } catch (error) {
    return procurementError(error);
  }
}
