import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";
import { callerOf, guardApi } from "@/lib/access/api";

/** Add batch manually: { productId, qty, producedDate (YYYY-MM-DD), note, name } (add_manual_batch). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const body = (await request.json().catch(() => ({}))) as {
      productId?: string;
      qty?: number;
      producedDate?: string;
      note?: string;
      name?: string;
    };
    if (!body.productId) return badRequest("Choose a product.");
    if (!Number.isInteger(body.qty) || (body.qty ?? 0) <= 0) return badRequest("Enter a quantity greater than 0.");
    if (!body.producedDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.producedDate)) return badRequest("Enter the production date.");
    // "Added by" is the signed-in employee, from the session.
    const addedBy = callerOf(request).access.fullName;
    if (!addedBy) return badRequest("Your name isn't set. Reload and try again.");
    const { data, error } = await requireAdmin().rpc("add_manual_batch", {
      p_product_id: body.productId,
      p_qty: body.qty,
      p_produced_date: body.producedDate,
      p_note: body.note ?? null,
      p_name: addedBy,
    });
    if (error) return rpcErrorResponse(error);
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
