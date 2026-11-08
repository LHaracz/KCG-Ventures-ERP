import { NextResponse } from "next/server";
import { readJson, UUID_RE, withSopApi } from "@/lib/sopApi";
import { reconcileSopFormulaTables } from "@/lib/sopService";
import { guardApi } from "@/lib/access/api";

/** Idempotent catch-up for missed automatic versions. Body: { sopIds?: string[] } (omit for all). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  return withSopApi(request, async ({ admin }) => {
    const body = await readJson<{ sopIds?: string[] }>(request).catch(() => ({ sopIds: undefined }));
    const sopIds = (body.sopIds ?? []).filter((x) => UUID_RE.test(x));
    try {
      const results = await reconcileSopFormulaTables(admin, sopIds.length ? sopIds : undefined);
      return NextResponse.json({ created: results.filter((r) => r.outcome === "created").length, results });
    } catch (error) {
      console.error(`[sop-reconcile] failed: ${error instanceof Error ? error.message : "unknown error"}`);
      throw error;
    }
  });
}
