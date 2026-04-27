import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { subtractInventory } from "@/lib/inventorySync";

type ShopifyOrderLineItem = {
  variant_id?: number | string | null;
  quantity?: number | null;
};

type ShopifyOrderPayload = {
  id?: number | string | null;
  line_items?: ShopifyOrderLineItem[];
};

function verifyShopifyWebhook(rawBody: string, headerHmac: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const provided = Buffer.from(headerHmac, "utf8");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export async function POST(request: Request) {
  const admin = supabaseAdmin;
  if (!admin) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Missing SHOPIFY_WEBHOOK_SECRET" }, { status: 500 });
  }

  const headerHmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!headerHmac) {
    return NextResponse.json({ error: "Missing Shopify HMAC header" }, { status: 401 });
  }

  const rawBody = await request.text();
  if (!verifyShopifyWebhook(rawBody, headerHmac, secret)) {
    return NextResponse.json({ error: "Invalid Shopify webhook signature" }, { status: 401 });
  }

  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const orderId = String(payload.id ?? "");
  if (!orderId) {
    return NextResponse.json({ error: "Missing order ID" }, { status: 400 });
  }

  const { error: idempotencyError } = await admin.from("inventory_webhook_events").insert({
    shopify_order_id: orderId,
  });

  if (idempotencyError) {
    const duplicate = idempotencyError.message.toLowerCase().includes("duplicate");
    if (duplicate) {
      return NextResponse.json({ ok: true, skipped: true, reason: "already_processed" });
    }
    return NextResponse.json({ error: idempotencyError.message }, { status: 500 });
  }

  const lineItems = payload.line_items ?? [];
  let processedItems = 0;
  let skippedItems = 0;

  for (const item of lineItems) {
    const variantIdRaw = item.variant_id;
    const quantityRaw = Number(item.quantity ?? 0);
    const variantId = variantIdRaw == null ? "" : String(variantIdRaw);

    if (!variantId || !Number.isFinite(quantityRaw) || quantityRaw <= 0) {
      skippedItems += 1;
      continue;
    }

    const { data: inventoryRow, error: lookupError } = await admin
      .from("inventory")
      .select("id, units_per_variant")
      .eq("shopify_variant_id", variantId)
      .maybeSingle();

    if (lookupError) {
      return NextResponse.json({ error: lookupError.message }, { status: 500 });
    }
    if (!inventoryRow?.id) {
      skippedItems += 1;
      continue;
    }

    const unitsPerVariant = Math.trunc(Number(inventoryRow.units_per_variant ?? 1));
    if (!Number.isFinite(unitsPerVariant) || unitsPerVariant < 1) {
      return NextResponse.json(
        { error: `Invalid units_per_variant for variant ${variantId}` },
        { status: 500 },
      );
    }
    const totalUnits = quantityRaw * unitsPerVariant;
    await subtractInventory(inventoryRow.id, totalUnits);
    processedItems += 1;
  }

  return NextResponse.json({
    ok: true,
    orderId,
    processedItems,
    skippedItems,
  });
}
