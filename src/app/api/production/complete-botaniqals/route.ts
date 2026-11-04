import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeBusinessType } from "@/lib/businessType";
import {
  notifySheetsProductionIn,
  productionDateFromCycleEndDate,
  type SheetsProductionRecord,
} from "@/lib/sheetsProductionWebhook";

type CompletionTargetRow = {
  product: string | null;
  quantity_to_produce: number | null;
  target_units: number | null;
};

type CompletionApiResponse = {
  ok: boolean;
  sent: number;
  completedAt: string;
  batches: Array<{ product_id: string; batch_id: string; batch_code: string; qty: number }>;
  alreadyCompleted: boolean;
};

/**
 * BotanIQals production completion (server):
 *  1. Push produced quantities to Google Sheets (unchanged).
 *  2. In one database transaction (complete_botaniqals_production): create
 *     one finished-goods batch per product with actual > 0, write the
 *     completion snapshot (ingredient quantities, costs and sale prices as of
 *     now) and mark the cycle completed. The batch receipt replaces the old
 *     finished-goods increment. Does not touch Shopify.
 */
export async function POST(request: Request) {
  try {
    const user = await requireApiUserFromBearerToken(request);
    const body = (await request.json()) as {
      cycleId?: string;
      actualQtyByProductId?: Record<string, number>;
    };
    const cycleId = body.cycleId?.trim();
    if (!cycleId) {
      return NextResponse.json({ error: "Missing cycleId." }, { status: 400 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: "Server misconfiguration." }, { status: 500 });
    }

    const { data: cycle, error: cycleError } = await supabaseAdmin
      .from("production_cycles")
      .select("id, user_id, business_type, brand, end_date")
      .eq("id", cycleId)
      .eq("user_id", user.id)
      .single();

    if (cycleError || !cycle) {
      return NextResponse.json(
        { error: cycleError?.message || "Cycle not found." },
        { status: 404 },
      );
    }

    const businessType = normalizeBusinessType(cycle);
    if (businessType !== "BotanIQals") {
      return NextResponse.json(
        { error: "Sheets finished-goods notify only applies to BotanIQals cycles." },
        { status: 400 },
      );
    }

    const { data: targets, error: targetsError } = await supabaseAdmin
      .from("production_targets")
      .select("product, quantity_to_produce, target_units")
      .eq("production_cycle", cycleId)
      .eq("user_id", user.id);

    if (targetsError) {
      return NextResponse.json({ error: targetsError.message }, { status: 500 });
    }

    const validProductIds = new Set<string>();
    for (const target of (targets ?? []) as CompletionTargetRow[]) {
      if (!target.product) continue;
      validProductIds.add(target.product);
    }

    const submittedActuals = body.actualQtyByProductId ?? {};
    const quantityByProductId = new Map<string, number>();
    for (const [productId, rawQty] of Object.entries(submittedActuals)) {
      if (!validProductIds.has(productId)) {
        return NextResponse.json(
          {
            error: `Actual quantity submitted for product not in cycle targets: ${productId}`,
          },
          { status: 400 },
        );
      }
      if (!Number.isFinite(rawQty) || !Number.isInteger(rawQty) || rawQty < 0) {
        return NextResponse.json(
          {
            error: `Actual quantity for product ${productId} must be a non-negative integer.`,
          },
          { status: 400 },
        );
      }
      if (rawQty === 0) continue;
      quantityByProductId.set(productId, rawQty);
    }

    const missingActuals = Array.from(validProductIds).filter(
      (productId) =>
        !Object.prototype.hasOwnProperty.call(submittedActuals, productId),
    );
    if (missingActuals.length > 0) {
      return NextResponse.json(
        {
          error: "Missing actual quantities for one or more target products.",
          missingProductIds: missingActuals,
        },
        { status: 400 },
      );
    }

    const productIds = Array.from(validProductIds);
    const { data: productRows, error: productRowsError } = await supabaseAdmin
      .from("products")
      .select("id, name, sale_price_per_unit")
      .in("id", productIds.length ? productIds : ["00000000-0000-0000-0000-000000000000"]);

    if (productRowsError) {
      return NextResponse.json({ error: productRowsError.message }, { status: 500 });
    }

    const productNameById = new Map<string, string>();
    for (const row of productRows ?? []) {
      if (!row.id || !row.name) continue;
      productNameById.set(String(row.id), String(row.name));
    }

    const missingNameProductIds: string[] = [];
    for (const productId of quantityByProductId.keys()) {
      if (!productNameById.get(productId)) {
        missingNameProductIds.push(productId);
      }
    }
    if (missingNameProductIds.length > 0) {
      return NextResponse.json(
        {
          error:
            "Missing product name for one or more produced products. Set products.name so Sheet Raw Data can match.",
          missingProductIds: missingNameProductIds,
        },
        { status: 400 },
      );
    }

    const productionDate = productionDateFromCycleEndDate(
      (cycle as { end_date?: string | null }).end_date,
    );

    const records: SheetsProductionRecord[] = [];
    for (const [productId, qty] of quantityByProductId) {
      const productName = productNameById.get(productId);
      if (!productName) continue;
      records.push({
        cycle_id: `${cycleId}:${productId}`,
        product: productName,
        quantity_produced: Math.trunc(qty),
        production_date: productionDate,
      });
    }

    if (records.length > 0) await notifySheetsProductionIn(records);

    // Snapshot of what this production used and cost, at today's prices
    // (same math as the cycle planner: BOM qty_per_unit x quantity x the raw
    // material's cost_per_unit).
    const [{ data: bomRows, error: bomError }, { data: itemRows, error: itemError }] = await Promise.all([
      supabaseAdmin
        .from("bom_lines")
        .select("product, inventory_item, qty_per_unit, unit_label")
        .in("product", productIds.length ? productIds : ["00000000-0000-0000-0000-000000000000"]),
      supabaseAdmin.from("inventory_items").select("id, name, unit, cost_per_unit"),
    ]);
    if (bomError || itemError) {
      return NextResponse.json({ error: bomError?.message || itemError?.message }, { status: 500 });
    }
    const itemsById = new Map((itemRows ?? []).map((i: any) => [String(i.id), i]));
    const priceById = new Map((productRows ?? []).map((p: any) => [String(p.id), p.sale_price_per_unit == null ? null : Number(p.sale_price_per_unit)]));
    const lines: Array<Record<string, unknown>> = [];
    const perProduct: Array<Record<string, unknown>> = [];
    let totalCost = 0;
    for (const productId of productIds) {
      const qty = quantityByProductId.get(productId) ?? 0;
      let productCost = 0;
      for (const line of (bomRows ?? []) as any[]) {
        if (String(line.product) !== productId || !line.inventory_item) continue;
        const item = itemsById.get(String(line.inventory_item));
        if (!item) continue;
        const qtyUsed = qty * Number(line.qty_per_unit || 0);
        const costPerUnit = Number(item.cost_per_unit || 0);
        const lineCost = qtyUsed * costPerUnit;
        productCost += lineCost;
        lines.push({
          product_id: productId,
          product: productNameById.get(productId) ?? null,
          ingredient: item.name,
          unit: line.unit_label || item.unit || "",
          qty_used: qtyUsed,
          cost_per_unit: costPerUnit,
          line_cost: lineCost,
        });
      }
      totalCost += productCost;
      perProduct.push({
        product_id: productId,
        name: productNameById.get(productId) ?? null,
        qty,
        sale_price_per_unit: priceById.get(productId) ?? null,
        cost: productCost,
      });
    }
    const produced = perProduct.filter((p) => Number(p.qty) > 0);
    const snapshot = {
      lines,
      total_cost: totalCost,
      sale_price_per_unit: produced.length === 1 ? produced[0].sale_price_per_unit : null,
      per_product: perProduct,
    };

    const completedAt = new Date().toISOString();
    const actuals: Record<string, number> = {};
    for (const productId of productIds) actuals[productId] = quantityByProductId.get(productId) ?? 0;
    const { data: completion, error: completionError } = await supabaseAdmin.rpc("complete_botaniqals_production", {
      p_cycle_id: cycleId,
      p_actuals: actuals,
      p_snapshot: snapshot,
      p_completed_at: completedAt,
    });
    if (completionError) {
      return NextResponse.json(
        { error: completionError.message, code: (completionError as { hint?: string }).hint ?? null },
        { status: (completionError as { hint?: string }).hint ? 409 : 500 },
      );
    }

    const result = completion as { already_completed: boolean; batches: CompletionApiResponse["batches"] };
    const response: CompletionApiResponse = {
      ok: true,
      sent: records.length,
      completedAt,
      batches: result.batches ?? [],
      alreadyCompleted: !!result.already_completed,
    };
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
