/**
 * GET diagnostics for /api/webhooks/orders-create (Shopify POST only).
 * App Router: this file must live at
 * src/app/api/webhooks/orders-create/status/route.ts
 * → URL path /api/webhooks/orders-create/status
 */
export async function GET() {
  return Response.json({
    ok: true,
    route: "/api/webhooks/orders-create/status",
    hasWebhookSecret: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET),
    hasSupabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    timestamp: new Date().toISOString(),
  });
}
