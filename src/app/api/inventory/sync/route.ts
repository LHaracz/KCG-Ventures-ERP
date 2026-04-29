import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { syncAllInventoryToShopify } from "@/lib/inventorySync";

export async function POST(request: Request) {
  const runId = `manual-sync-${Date.now()}`;
  // #region agent log
  fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
    body: JSON.stringify({
      sessionId: "ea9524",
      runId,
      hypothesisId: "H1",
      location: "src/app/api/inventory/sync/route.ts:7",
      message: "sync endpoint entered",
      data: {},
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  try {
    await requireApiUserFromBearerToken(request);
    const result = await syncAllInventoryToShopify();
    if (result.failed.length > 0) {
      // #region agent log
      console.error("[inventory-sync-debug] sync failures", {
        runId,
        failed: result.failed,
      });
      // #endregion
    }
    // #region agent log
    fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
      body: JSON.stringify({
        sessionId: "ea9524",
        runId,
        hypothesisId: "H1",
        location: "src/app/api/inventory/sync/route.ts:20",
        message: "sync endpoint result",
        data: { synced: result.synced, failedCount: result.failed.length, failed: result.failed },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return NextResponse.json({
      ok: result.failed.length === 0,
      synced: result.synced,
      failed: result.failed,
      failedCount: result.failed.length,
      debugRunId: runId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    // #region agent log
    fetch("http://127.0.0.1:7579/ingest/75023274-b317-4510-8d56-7dafb38622b5", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ea9524" },
      body: JSON.stringify({
        sessionId: "ea9524",
        runId,
        hypothesisId: "H1",
        location: "src/app/api/inventory/sync/route.ts:37",
        message: "sync endpoint error",
        data: { message },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
