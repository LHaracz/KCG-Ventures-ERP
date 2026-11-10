import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { archiveLink } from "@/lib/procurement/service";
import { procurementDb, procurementError } from "@/lib/procurement/routeHelpers";

/** Remove a supplier from a raw material (archives the link; nothing is deleted). */
export async function POST(request: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { linkId } = await params;
    return NextResponse.json({ link: await archiveLink(procurementDb(), linkId) });
  } catch (error) {
    return procurementError(error);
  }
}
