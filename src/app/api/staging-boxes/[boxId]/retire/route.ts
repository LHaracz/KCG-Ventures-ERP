import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";
import { guardApi } from "@/lib/access/api";

/** Retire an available box (never deleted; its number is never reused). */
export async function POST(request: Request, { params }: { params: Promise<{ boxId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const { boxId } = await params;
    const { data, error } = await requireAdmin().rpc("retire_staging_box", { p_box_id: boxId });
    if (error) return rpcErrorResponse(error);
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
