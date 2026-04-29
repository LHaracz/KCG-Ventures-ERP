import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { addInventory } from "@/lib/inventorySync";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeBusinessType } from "@/lib/businessType";

type CompletionTargetRow = {
  product: string | null;
  quantity_to_produce: number | null;
  target_units: number | null;
};

type CompletionApiResponse = {
  ok: boolean;
  updated: number;
  skipped: number;
  missingProductIds?: string[];
  failedSyncProducts?: Array<{ productId: string; error: string }>;
};

async function ensureInventoryRowsForProducedProducts(params: {
  productIds: string[];
}): Promise<void> {
  if (!supabaseAdmin || params.productIds.length === 0) return;

  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from("inventory")
    .select("product_id")
    .in("product_id", params.productIds);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const existingProductIds = new Set(
    (existingRows ?? [])
      .map((row) => (row.product_id ? String(row.product_id) : null))
      .filter((value): value is string => Boolean(value)),
  );

  const missingProductIds = params.productIds.filter((id) => !existingProductIds.has(id));
  if (missingProductIds.length === 0) return;

  const { data: products, error: productsError } = await supabaseAdmin
    .from("products")
    .select("id, name")
    .in("id", missingProductIds);

  if (productsError) {
    throw new Error(productsError.message);
  }

  const nowIso = new Date().toISOString();
  const rowsToInsert = (products ?? []).map((product) => ({
    product_id: product.id,
    product_name: product.name,
    shopify_variant_id: `UNMAPPED_VARIANT_${product.id}`,
    shopify_inventory_item_id: `UNMAPPED_ITEM_${product.id}`,
    shopify_location_id: "UNMAPPED_LOCATION",
    units_per_variant: 1,
    qty_on_hand: 0,
    reserved_qty: 0,
    available_qty: 0,
    updated_at: nowIso,
  }));

  if (rowsToInsert.length === 0) return;

  const { error: insertError } = await supabaseAdmin
    .from("inventory")
    .insert(rowsToInsert);

  if (insertError) {
    throw new Error(insertError.message);
  }
}

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
      .select("id, user_id, business_type, brand")
      .eq("id", cycleId)
      .eq("user_id", user.id)
      .single();

    if (cycleError || !cycle) {
      return NextResponse.json({ error: cycleError?.message || "Cycle not found." }, { status: 404 });
    }

    const businessType = normalizeBusinessType(cycle);
    if (businessType !== "BotanIQals") {
      return NextResponse.json(
        { error: "Finished product inventory updates only apply to BotanIQals cycles." },
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
          { error: `Actual quantity submitted for product not in cycle targets: ${productId}` },
          { status: 400 },
        );
      }
      if (!Number.isFinite(rawQty) || !Number.isInteger(rawQty) || rawQty < 0) {
        return NextResponse.json(
          { error: `Actual quantity for product ${productId} must be a non-negative integer.` },
          { status: 400 },
        );
      }
      if (rawQty === 0) continue;
      quantityByProductId.set(productId, rawQty);
    }

    const missingActuals = Array.from(validProductIds).filter(
      (productId) => !Object.prototype.hasOwnProperty.call(submittedActuals, productId),
    );
    if (missingActuals.length > 0) {
      return NextResponse.json(
        { error: "Missing actual quantities for one or more target products.", missingProductIds: missingActuals },
        { status: 400 },
      );
    }

    if (quantityByProductId.size === 0) {
      return NextResponse.json({ ok: true, updated: 0, skipped: 0 });
    }

    const productIds = Array.from(quantityByProductId.keys());
    await ensureInventoryRowsForProducedProducts({ productIds });

    const { data: inventoryRows, error: inventoryError } = await supabaseAdmin
      .from("inventory")
      .select("id, product_id")
      .in("product_id", productIds);

    if (inventoryError) {
      return NextResponse.json({ error: inventoryError.message }, { status: 500 });
    }

    const inventoryIdByProductId = new Map<string, string>();
    for (const row of inventoryRows ?? []) {
      if (!row.product_id) continue;
      inventoryIdByProductId.set(String(row.product_id), String(row.id));
    }

    const missingProductIds: string[] = [];
    for (const [productId] of quantityByProductId) {
      if (!inventoryIdByProductId.get(productId)) {
        missingProductIds.push(productId);
      }
    }
    if (missingProductIds.length > 0) {
      return NextResponse.json(
        {
          error:
            "Missing inventory mapping for one or more produced products. Set inventory.product_id for all BotanIQals finished products before completing production.",
          missingProductIds,
        },
        { status: 400 },
      );
    }

    let updated = 0;
    let skipped = 0;
    const failedSyncProducts: Array<{ productId: string; error: string }> = [];

    for (const [productId, qty] of quantityByProductId) {
      const inventoryProductId = inventoryIdByProductId.get(productId);
      if (!inventoryProductId) {
        skipped += 1;
        continue;
      }

      const { error: eventError } = await supabaseAdmin
        .from("inventory_production_events")
        .insert({
          production_cycle_id: cycleId,
          inventory_product_id: inventoryProductId,
        });

      if (eventError) {
        const duplicate = eventError.message.toLowerCase().includes("duplicate");
        if (duplicate) {
          skipped += 1;
          continue;
        }
        return NextResponse.json({ error: eventError.message }, { status: 500 });
      }

      try {
        await addInventory(inventoryProductId, Math.trunc(qty), {
          requireShopifySync: true,
        });
        updated += 1;
      } catch (error) {
        failedSyncProducts.push({
          productId,
          error: error instanceof Error ? error.message : "Unknown Shopify sync failure",
        });
      }
    }

    if (failedSyncProducts.length > 0) {
      return NextResponse.json(
        {
          error:
            "Finished inventory was updated, but Shopify sync failed for one or more products. Use Sync to Shopify after resolving mapping/config issues.",
          updated,
          skipped,
          failedSyncProducts,
        },
        { status: 502 },
      );
    }

    const response: CompletionApiResponse = { ok: true, updated, skipped };
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
