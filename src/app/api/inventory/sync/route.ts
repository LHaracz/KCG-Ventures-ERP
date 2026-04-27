import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { syncAllInventoryToShopify } from "@/lib/inventorySync";

export async function POST(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const result = await syncAllInventoryToShopify();
    return NextResponse.json({
      ok: result.failed.length === 0,
      synced: result.synced,
      failed: result.failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
