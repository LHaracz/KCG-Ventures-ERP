import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createShopifyOrdersSource, loadFulfillmentOrders, type CachedOrder } from "@/lib/fulfillmentOrdersLoader";

/**
 * Small helpers shared by the picking / staging / packaging API routes, in
 * the same style as the existing fulfillment routes (bearer-token auth,
 * { error } JSON bodies, database functions via supabaseAdmin.rpc).
 */

export function requireAdmin() {
  if (!supabaseAdmin) throw new Error("Server is not configured (missing service role key).");
  return supabaseAdmin;
}

/** Same status mapping the existing fulfillment routes use. */
export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
  return NextResponse.json({ error: message }, { status });
}

/**
 * A database function's business-rule failure (raised with a code in HINT)
 * becomes a 409 with { error, code }; anything else is a 500.
 */
export function rpcErrorResponse(error: { message: string; hint?: string | null; code?: string | null }) {
  const code = error.hint || null;
  return NextResponse.json({ error: error.message, code }, { status: code ? 409 : 500 });
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** The Fulfillments list's shared order loader, wired to Shopify. */
export function loadOrders() {
  const db = requireAdmin();
  return loadFulfillmentOrders(db, createShopifyOrdersSource(db));
}

/** One order from the ERP-side cache (no Shopify call), or null. */
export async function cachedOrder(orderId: string): Promise<CachedOrder | null> {
  const db = requireAdmin();
  const { data } = await db
    .from("fulfillment_orders_cache")
    .select("payload")
    .eq("shopify_order_id", orderId)
    .maybeSingle();
  return (data?.payload as CachedOrder | undefined) ?? null;
}
