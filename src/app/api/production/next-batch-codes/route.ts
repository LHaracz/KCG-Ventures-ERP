import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { errorResponse, requireAdmin } from "@/lib/fulfillmentApi";

/** Read-only preview of the next batch codes, for Complete Production's confirmation step. */
export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const count = Math.min(50, Math.max(1, Number(new URL(request.url).searchParams.get("count")) || 1));
    const { data, error } = await requireAdmin().rpc("peek_next_batch_codes", { p_count: count });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, codes: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}
