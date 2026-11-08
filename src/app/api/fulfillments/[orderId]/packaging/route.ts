import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { badRequest, cachedOrder, errorResponse, requireAdmin, rpcErrorResponse } from "@/lib/fulfillmentApi";
import { loadPackagingConfig, packagingForOrder } from "@/lib/warehouse";
import type { PackagingOverride } from "@/lib/packagingEngine";
import { guardApi } from "@/lib/access/api";

/**
 * Packaging override for one order.
 *   { action: "set", target: "preset", presetId } | { action: "set", target: "needs_review" }
 *   { action: "clear" }
 * The event records the package before and after. The "before" is computed
 * here with the packaging engine from the cached order (suggestions are never
 * stored); if the order isn't cached, the client's label is used.
 */
type Body = {
  action?: "set" | "clear";
  target?: "preset" | "needs_review";
  presetId?: string | null;
  previousLabel?: string | null;
};

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await requireApiUserFromBearerToken(request);
    const { orderId } = await params;
    if (!orderId?.trim()) return badRequest("Missing orderId.");
    const body = (await request.json().catch(() => ({}))) as Body;
    const db = requireAdmin();

    // Current effective package and the plain suggestion, for the event log.
    let currentLabel = body.previousLabel ?? null;
    let suggestionLabel: string | null = null;
    const order = await cachedOrder(orderId);
    if (order) {
      const [config, overrideRes] = await Promise.all([
        loadPackagingConfig(db),
        db.from("order_packaging").select("override_target, override_preset_id, override_preset_name").eq("order_id", orderId).maybeSingle(),
      ]);
      const o = overrideRes.data as any;
      const override: PackagingOverride | null = o
        ? { target: o.override_target, presetId: o.override_preset_id, presetName: o.override_preset_name }
        : null;
      const { packaging } = packagingForOrder(order, config, override);
      currentLabel = packaging.label;
      suggestionLabel = packaging.suggestionLabel;
    }

    if (body.action === "clear") {
      const { data, error } = await db.rpc("clear_packaging_override", {
        p_order_id: orderId,
        p_restored_label: suggestionLabel,
      });
      if (error) return rpcErrorResponse(error);
      return NextResponse.json({ ok: true, ...(data as object) });
    }

    if (body.action !== "set" || (body.target !== "preset" && body.target !== "needs_review")) {
      return badRequest("Choose a package or Needs Review.");
    }
    if (body.target === "preset" && !body.presetId) return badRequest("Choose a package.");

    const { data, error } = await db.rpc("set_packaging_override", {
      p_order_id: orderId,
      p_target: body.target,
      p_preset_id: body.target === "preset" ? body.presetId : null,
      p_previous_label: currentLabel,
    });
    if (error) return rpcErrorResponse(error);
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (error) {
    return errorResponse(error);
  }
}
