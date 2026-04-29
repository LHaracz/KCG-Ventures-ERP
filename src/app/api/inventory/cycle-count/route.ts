import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { setInventoryCycleCount } from "@/lib/inventorySync";

export async function POST(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);
    const body = (await request.json()) as {
      inventoryRowId?: string;
      countedQtyOnHand?: number;
    };
    const inventoryRowId = body.inventoryRowId?.trim();
    const countedQtyOnHand = body.countedQtyOnHand;

    if (!inventoryRowId) {
      return NextResponse.json({ error: "Missing inventoryRowId." }, { status: 400 });
    }
    if (
      typeof countedQtyOnHand !== "number" ||
      !Number.isFinite(countedQtyOnHand) ||
      !Number.isInteger(countedQtyOnHand) ||
      countedQtyOnHand < 0
    ) {
      return NextResponse.json(
        { error: "countedQtyOnHand must be a non-negative integer." },
        { status: 400 },
      );
    }

    const result = await setInventoryCycleCount(inventoryRowId, countedQtyOnHand);
    return NextResponse.json({
      ok: true,
      row: result.row,
      previousQtyOnHand: result.previousQtyOnHand,
      newQtyOnHand: result.newQtyOnHand,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
