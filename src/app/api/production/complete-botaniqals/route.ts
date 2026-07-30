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
};

/**
 * BotanIQals production completion server step: push produced quantities to Google Sheets.
 * Does not touch Shopify or the ERP finished-goods inventory table.
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

    if (quantityByProductId.size === 0) {
      const empty: CompletionApiResponse = { ok: true, sent: 0 };
      return NextResponse.json(empty);
    }

    const productIds = Array.from(quantityByProductId.keys());
    const { data: productRows, error: productRowsError } = await supabaseAdmin
      .from("products")
      .select("id, name")
      .in("id", productIds);

    if (productRowsError) {
      return NextResponse.json({ error: productRowsError.message }, { status: 500 });
    }

    const productNameById = new Map<string, string>();
    for (const row of productRows ?? []) {
      if (!row.id || !row.name) continue;
      productNameById.set(String(row.id), String(row.name));
    }

    const missingNameProductIds: string[] = [];
    for (const productId of productIds) {
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

    await notifySheetsProductionIn(records);

    const response: CompletionApiResponse = { ok: true, sent: records.length };
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
