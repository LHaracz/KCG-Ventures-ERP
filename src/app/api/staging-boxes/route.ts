import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";
import { guardApi } from "@/lib/access/api";

/** Create staging boxes: { count } from 1 to 50, numbering continues from the highest box. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const body = (await request.json().catch(() => ({}))) as { count?: number };
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) return badRequest("Enter a number of boxes from 1 to 50.");
    const { data, error } = await requireAdmin().rpc("create_staging_boxes", { p_count: count });
    if (error) return rpcErrorResponse(error);
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
