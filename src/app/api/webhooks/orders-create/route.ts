import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { overrideErpFromShopifyForInventoryRow } from "@/lib/inventorySync";
import { shopifyVariantIdLookupKeys } from "@/lib/shopifyIds";
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
  previousQtyOnHand: number;
  newQtyOnHand: number;
  shopifyAvailable: number;
};

function verifyShopifyWebhook(rawBody: string, headerHmac: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const provided = Buffer.from(headerHmac, "utf8");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function webhookSettleMs(): number {
  const raw = process.env.WEBHOOK_SHOPIFY_INVENTORY_SETTLE_MS;
  if (raw == null || String(raw).trim() === "") {
    return 750;
  }
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) {
    return 750;
  }
  return Math.min(n, 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
          "This Shopify order was already recorded in inventory_webhook_events; ERP was not re-synced from Shopify.",
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

  const settleMs = webhookSettleMs();
  if (settleMs > 0) {
    ordersCreateWebhookLog("waiting before Shopify inventory read", { runId, settleMs });
    await sleep(settleMs);
  }

  const lineItems = payload.line_items ?? [];
  const skippedLines: SkippedLine[] = [];
  /** One refresh per variant (dedupe lines). */
  const variantToInventoryRowId = new Map<string, string>();

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

    const lookupKeys = shopifyVariantIdLookupKeys(variantId);
    if (lookupKeys.length === 0) {
      skippedLines.push({
        variantId,
        quantity: quantityRaw,
        reason: "variant_not_mapped_in_inventory",
      });
      continue;
    }

    const { data: inventoryRows, error: lookupError } = await admin
      .from("inventory")
      .select("id")
      .in("shopify_variant_id", lookupKeys)
      .limit(2);

    if (lookupError) {
      ordersCreateWebhookLog("failure: inventory lookup", {
        runId,
        topic,
        orderId,
        variantId,
        lookupKeys,
        error: lookupError.message,
      });
      await admin.from("inventory_webhook_events").delete().eq("shopify_order_id", orderId);
      return NextResponse.json(
        {
          ok: false,
          step: "inventory_lookup",
          runId,
          topic,
          orderId,
          hmacVerified: true,
          variantId,
          lookupKeys,
          error: lookupError.message,
          skippedLines,
          idempotencyReleased: true,
        },
        { status: 500 },
      );
    }
    const matchedRows = inventoryRows ?? [];
    if (matchedRows.length > 1) {
      ordersCreateWebhookLog("failure: multiple inventory rows for variant lookup keys", {
        runId,
        orderId,
        variantId,
        lookupKeys,
        rowIds: matchedRows.map((r) => r.id),
      });
      await admin.from("inventory_webhook_events").delete().eq("shopify_order_id", orderId);
      return NextResponse.json(
        {
          ok: false,
          step: "inventory_lookup_ambiguous",
          runId,
          topic,
          orderId,
          variantId,
          lookupKeys,
          error: "Multiple inventory rows matched the same Shopify variant id shapes.",
          skippedLines,
          idempotencyReleased: true,
        },
        { status: 500 },
      );
    }
    const inventoryRow = matchedRows[0];
    if (!inventoryRow?.id) {
      ordersCreateWebhookLog("skipped line: variant not mapped", {
        runId,
        orderId,
        variantId,
        lookupKeys,
        quantityRaw,
      });
      skippedLines.push({
        variantId,
        quantity: quantityRaw,
        reason: "variant_not_mapped_in_inventory",
      });
      continue;
    }

    if (!variantToInventoryRowId.has(variantId)) {
      variantToInventoryRowId.set(variantId, String(inventoryRow.id));
    }
  }

  const processedLines: ProcessedLine[] = [];

  for (const [variantId, inventoryRowId] of variantToInventoryRowId) {
    try {
      const result = await overrideErpFromShopifyForInventoryRow(inventoryRowId);
      processedLines.push({
        variantId,
        inventoryRowId,
        previousQtyOnHand: result.previousQtyOnHand,
        newQtyOnHand: result.newQtyOnHand,
        shopifyAvailable: result.shopifyAvailable,
      });
      ordersCreateWebhookLog("ERP overridden from Shopify", {
        runId,
        orderId,
        variantId,
        inventoryRowId,
        previousQtyOnHand: result.previousQtyOnHand,
        newQtyOnHand: result.newQtyOnHand,
        shopifyAvailable: result.shopifyAvailable,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      ordersCreateWebhookLog("failure: overrideErpFromShopifyForInventoryRow", {
        runId,
        orderId,
        variantId,
        inventoryRowId,
        error: message,
      });
      await admin.from("inventory_webhook_events").delete().eq("shopify_order_id", orderId);
      return NextResponse.json(
        {
          ok: false,
          step: "override_erp_from_shopify",
          runId,
          topic,
          orderId,
          variantId,
          inventoryRowId,
          error: message,
          processedLines,
          skippedLines,
          idempotencyReleased: true,
        },
        { status: 500 },
      );
    }
  }

  const matchedVariantIds = processedLines.map((p) => p.variantId);
  const skippedVariantIds = skippedLines
    .map((s) => s.variantId)
    .filter((id): id is string => !!id);

  ordersCreateWebhookLog("webhook completed", {
    runId,
    topic,
    orderId,
    mode: "shopify_to_erp_full_override",
    processedCount: processedLines.length,
    skippedCount: skippedLines.length,
    matchedVariantIds,
    skippedVariantIds,
  });

  const erpUpdated = processedLines.length > 0;
  const hint =
    erpUpdated
      ? undefined
      : skippedLines.some((s) => s.reason === "variant_not_mapped_in_inventory")
        ? "No line items matched inventory.shopify_variant_id (tried numeric id and gid://shopify/ProductVariant/...) — ERP unchanged. For real orders: ensure a row exists and shopify_variant_id matches Shopify (REST id or full variant GID). Test notifications use unrelated sample variant ids."
        : skippedLines.length > 0
          ? "No inventory rows were updated; all line items were skipped for other reasons (see skippedLines)."
          : "Order had no line items to process.";

  if (!erpUpdated && hint) {
    ordersCreateWebhookLog("webhook completed: ERP not updated", { runId, orderId, hint });
  }

  return NextResponse.json({
    ok: true,
    runId,
    topic,
    orderId,
    hmacVerified: true,
    duplicate: false,
    mode: "shopify_to_erp_full_override",
    erpUpdated,
    processedItems: processedLines.length,
    skippedItems: skippedLines.length,
    processedLines,
    skippedLines,
    matchedVariantIds,
    skippedVariantIds,
    settleMs,
    ...(hint ? { hint } : {}),
  });
}
