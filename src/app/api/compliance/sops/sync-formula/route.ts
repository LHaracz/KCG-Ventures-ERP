import { NextResponse } from "next/server";
import { jsonError, readJson, UUID_RE, withSopApi } from "@/lib/sopApi";
import { syncSopFormulaTables } from "@/lib/sopService";

/**
 * Called right after Finish Iteration commits. Creates one automatic
 * version per affected SOP (idempotent). Errors are logged without any
 * formula amounts or SOP text.
 */
export async function POST(request: Request) {
  return withSopApi(request, async ({ admin }) => {
    const body = await readJson<{ productId: string; formulationId: string }>(request);
    if (!UUID_RE.test(body.productId ?? "") || !UUID_RE.test(body.formulationId ?? "")) return jsonError("productId and formulationId are required.");
    try {
      const results = await syncSopFormulaTables(admin, body.productId, body.formulationId);
      return NextResponse.json({ results });
    } catch (error) {
      console.error(`[sop-sync] failed for product ${body.productId}: ${error instanceof Error ? error.message : "unknown error"}`);
      throw error;
    }
  });
}
