import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, requireAdmin } from "@/lib/fulfillmentApi";
import { callerOf, guardApi } from "@/lib/access/api";

/**
 * Count boxes: { counts: [{ batch_id, expected_remaining, counted_qty, reason }], name }
 * All or nothing (count_batches). If a batch changed since the count was
 * opened, responds 409 with code count_stale and the current numbers.
 */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const body = (await request.json().catch(() => ({}))) as { counts?: unknown[] };
    // "Counted by" is the signed-in employee, from the session.
    const countedBy = callerOf(request).access.fullName;
    if (!Array.isArray(body.counts) || body.counts.length === 0) return badRequest("Enter at least one count.");
    const { data, error } = await requireAdmin().rpc("count_batches", { p_counts: body.counts, p_name: countedBy });
    if (error) {
      const e = error as { message: string; hint?: string | null; details?: string | null };
      let stale: unknown = null;
      try {
        stale = e.details ? JSON.parse(e.details) : null;
      } catch {
        stale = null;
      }
      return NextResponse.json({ error: e.message, code: e.hint ?? null, stale }, { status: e.hint ? 409 : 500 });
    }
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
