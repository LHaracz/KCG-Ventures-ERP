import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { subtractInventory } from "@/lib/inventorySync";
import { ordersCreateWebhookLog } from "./log";

type ShopifyOrderLineItem = {
  variant_id?: number | string | null;
  quantity?: number | null;
};

type ShopifyOrderPayload = {
  id?: number | string | null;
  line_items?: ShopifyOrderLineItem[];
};

type SkippedLine = {
  variantId: string | null;
  quantity: number | null;
  reason: "missing_variant_id" | "invalid_quantity" | "variant_not_mapped_in_inventory";
};

type ProcessedLine = {
  variantId: string;
  inventoryRowId: string;
  lineQuantity: number;
  unitsPerVariant: number;
  totalUnitsSubtracted: number;
};

function verifyShopifyWebhook(rawBody: string, headerHmac: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const provided = Buffer.from(headerHmac, "utf8");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export async function POST(request: Request) {
  const runId = `webhook-order-${Date.now()}`;
  const topic = request.headers.get("x-shopify-topic") ?? "";
  const shopDomain = request.headers.get("x-shopify-shop-domain") ?? "";

  ordersCreateWebhookLog("webhook received", {
    runId,
    topic,
    shopDomain,
    hasHmacHeader: !!request.headers.get("x-shopify-hmac-sha256"),
  });

  const admin = supabaseAdmin;
  if (!admin) {
    ordersCreateWebhookLog("failure: supabase admin not configured", { runId });
    return NextResponse.json(
      {
        ok: false,
        step: "supabase_admin",
        runId,
        error: "Server misconfiguration: Supabase service role client is not available.",
      },
      { status: 500 },
    );
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret?.trim()) {
    ordersCreateWebhookLog("failure: SHOPIFY_WEBHOOK_SECRET missing", { runId });
    return NextResponse.json(
      {
        ok: false,
        step: "env",
        runId,
        error: "Missing SHOPIFY_WEBHOOK_SECRET",
      },
      { status: 500 },
    );
  }

  const headerHmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!headerHmac) {
    ordersCreateWebhookLog("failure: missing HMAC header", { runId, topic });
    return NextResponse.json(
      {
        ok: false,
        step: "hmac_header",
        runId,
        topic,
        hmacVerified: false,
        error: "Missing X-Shopify-Hmac-Sha256 header",
      },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  const hmacOk = verifyShopifyWebhook(rawBody, headerHmac, secret);
  if (!hmacOk) {
    ordersCreateWebhookLog("failure: HMAC verification failed", { runId, topic });
    return NextResponse.json(
      {
        ok: false,
        step: "hmac_verification",
        runId,
        topic,
        hmacVerified: false,
        error: "Invalid Shopify webhook signature",
      },
      { status: 401 },
    );
  }

  ordersCreateWebhookLog("HMAC verification passed", { runId, topic });

  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    ordersCreateWebhookLog("failure: invalid JSON body", { runId, topic });
    return NextResponse.json(
      {
        ok: false,
        step: "parse_json",
        runId,
        topic,
        hmacVerified: true,
        error: "Invalid JSON payload",
      },
      { status: 400 },
    );
  }

  const orderId = String(payload.id ?? "");
  if (!orderId) {
    ordersCreateWebhookLog("failure: missing order id in payload", { runId, topic });
    return NextResponse.json(
      {
        ok: false,
        step: "order_id",
        runId,
        topic,
        hmacVerified: true,
        error: "Missing order ID in payload",
      },
      { status: 400 },
    );
  }

  ordersCreateWebhookLog("parsed order payload", {
    runId,
    topic,
    orderId,
    lineItemCount: payload.line_items?.length ?? 0,
  });

  const { error: idempotencyError } = await admin.from("inventory_webhook_events").insert({
    shopify_order_id: orderId,
  });

  if (idempotencyError) {
    const duplicate = idempotencyError.message.toLowerCase().includes("duplicate");
    if (duplicate) {
      ordersCreateWebhookLog("duplicate webhook event (idempotency)", {
        runId,
        topic,
        orderId,
      });
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "already_processed",
        runId,
        topic,
        orderId,
        message:
          "This Shopify order was already recorded in inventory_webhook_events; inventory was not decremented again.",
      });
    }
    ordersCreateWebhookLog("failure: idempotency insert", {
      runId,
      topic,
      orderId,
      error: idempotencyError.message,
    });
    return NextResponse.json(
      {
        ok: false,
        step: "idempotency_insert",
        runId,
        topic,
        orderId,
        hmacVerified: true,
        error: idempotencyError.message,
      },
      { status: 500 },
    );
  }

  ordersCreateWebhookLog("recorded webhook event for idempotency", { runId, topic, orderId });

  const lineItems = payload.line_items ?? [];
  const processedLines: ProcessedLine[] = [];
  const skippedLines: SkippedLine[] = [];

  for (const item of lineItems) {
    const variantIdRaw = item.variant_id;
    const quantityRaw = Number(item.quantity ?? 0);
    const variantId = variantIdRaw == null ? "" : String(variantIdRaw);

    if (!variantId) {
      skippedLines.push({
        variantId: null,
        quantity: item.quantity ?? null,
        reason: "missing_variant_id",
      });
      continue;
    }
    if (!Number.isFinite(quantityRaw) || quantityRaw <= 0) {
      skippedLines.push({
        variantId,
        quantity: item.quantity ?? null,
        reason: "invalid_quantity",
      });
      continue;
    }

    const { data: inventoryRow, error: lookupError } = await admin
      .from("inventory")
      .select("id, units_per_variant")
      .eq("shopify_variant_id", variantId)
      .maybeSingle();

    if (lookupError) {
      ordersCreateWebhookLog("failure: inventory lookup", {
        runId,
        topic,
        orderId,
        variantId,
        error: lookupError.message,
      });
      return NextResponse.json(
        {
          ok: false,
          step: "inventory_lookup",
          runId,
          topic,
          orderId,
          hmacVerified: true,
          variantId,
          error: lookupError.message,
          processedLines,
          skippedLines,
        },
        { status: 500 },
      );
    }
    if (!inventoryRow?.id) {
      ordersCreateWebhookLog("skipped line: variant not mapped", {
        runId,
        orderId,
        variantId,
        quantityRaw,
      });
      skippedLines.push({
        variantId,
        quantity: quantityRaw,
        reason: "variant_not_mapped_in_inventory",
      });
      continue;
    }

    const unitsPerVariant = Math.trunc(Number(inventoryRow.units_per_variant ?? 1));
    if (!Number.isFinite(unitsPerVariant) || unitsPerVariant < 1) {
      ordersCreateWebhookLog("failure: invalid units_per_variant", {
        runId,
        variantId,
        unitsPerVariant: inventoryRow.units_per_variant,
      });
      return NextResponse.json(
        {
          ok: false,
          step: "units_per_variant",
          runId,
          topic,
          orderId,
          variantId,
          error: `Invalid units_per_variant for variant ${variantId}`,
          processedLines,
          skippedLines,
        },
        { status: 500 },
      );
    }

    const totalUnits = quantityRaw * unitsPerVariant;
    try {
      await subtractInventory(inventoryRow.id, totalUnits);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      ordersCreateWebhookLog("failure: subtractInventory", {
        runId,
        orderId,
        variantId,
        inventoryRowId: inventoryRow.id,
        totalUnits,
        error: message,
      });
      return NextResponse.json(
        {
          ok: false,
          step: "subtract_inventory",
          runId,
          topic,
          orderId,
          variantId,
          inventoryRowId: inventoryRow.id,
          totalUnitsAttempted: totalUnits,
          error: message,
          processedLines,
          skippedLines,
        },
        { status: 500 },
      );
    }

    processedLines.push({
      variantId,
      inventoryRowId: inventoryRow.id,
      lineQuantity: quantityRaw,
      unitsPerVariant,
      totalUnitsSubtracted: totalUnits,
    });
    ordersCreateWebhookLog("inventory decremented", {
      runId,
      orderId,
      variantId,
      inventoryRowId: inventoryRow.id,
      lineQuantity: quantityRaw,
      unitsPerVariant,
      totalUnitsSubtracted: totalUnits,
    });
  }

  const matchedVariantIds = processedLines.map((p) => p.variantId);
  const skippedVariantIds = skippedLines
    .map((s) => s.variantId)
    .filter((id): id is string => !!id);

  ordersCreateWebhookLog("webhook completed", {
    runId,
    topic,
    orderId,
    processedCount: processedLines.length,
    skippedCount: skippedLines.length,
    matchedVariantIds,
    skippedVariantIds,
  });

  return NextResponse.json({
    ok: true,
    runId,
    topic,
    orderId,
    hmacVerified: true,
    duplicate: false,
    processedItems: processedLines.length,
    skippedItems: skippedLines.length,
    processedLines,
    skippedLines,
    matchedVariantIds,
    skippedVariantIds,
  });
}
