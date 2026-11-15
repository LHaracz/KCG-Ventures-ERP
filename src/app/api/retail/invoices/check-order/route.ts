import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { conflictMessage, findOrderConflict } from "@/lib/retail/service";
import { normalizeOrderNumber } from "@/lib/retail/orderNumber";
import { readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Is a Shopify order number already used by an active invoice? { order_number, exclude_id? }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    const n = normalizeOrderNumber(body.order_number);
    if (!n.ok) return NextResponse.json({ normalized: null, conflict: null, message: n.error });
    const exclude = typeof body.exclude_id === "string" ? body.exclude_id : null;
    const conflict = await findOrderConflict(retailDb(), n.value, exclude);
    return NextResponse.json({ normalized: n.value, conflict, message: conflict ? conflictMessage(conflict) : null });
  } catch (error) {
    return retailError(error);
  }
}
