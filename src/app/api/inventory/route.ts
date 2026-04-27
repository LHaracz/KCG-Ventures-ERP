import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { getInventory } from "@/lib/inventorySync";

export async function GET(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const inventory = await getInventory();
    return NextResponse.json({ data: inventory });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
