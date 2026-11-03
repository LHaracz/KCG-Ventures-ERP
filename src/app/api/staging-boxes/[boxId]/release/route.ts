import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";

/** Release a lost, damaged or stuck box (reason required). Its order goes back to picking. */
export async function POST(request: Request, { params }: { params: Promise<{ boxId: string }> }) {
  try {
    await requireApiUserFromBearerToken(request);
    const { boxId } = await params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    if (!body.reason?.trim()) return badRequest("A reason is required to release a staging box.");
    const { data, error } = await requireAdmin().rpc("release_staging_box", { p_box_id: boxId, p_reason: body.reason });
    if (error) return rpcErrorResponse(error);
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
