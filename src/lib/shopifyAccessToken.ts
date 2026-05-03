import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ShopifyTokenResolution = {
  accessToken: string;
  tokenSource:
    | "SHOPIFY_CLIENT_CREDENTIALS_DB_CACHE"
    | "SHOPIFY_CLIENT_CREDENTIALS_REFRESH"
    | "SHOPIFY_ACCESS_TOKEN"
    | "SHOPIFY_ADMIN_ACCESS_TOKEN";
};

const TOKEN_CACHE_ID = "admin_api";
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

let memoryToken: { accessToken: string; expiresAtMs: number } | null = null;

function normalizeShopDomain(shopDomain: string): string {
  return shopDomain.includes(".myshopify.com")
    ? shopDomain
    : `${shopDomain}.myshopify.com`;
}

function isTokenUsable(expiresAtMs: number): boolean {
  return Number.isFinite(expiresAtMs) && Date.now() < expiresAtMs - TOKEN_REFRESH_BUFFER_MS;
}

async function readCachedTokenFromDb(): Promise<{ accessToken: string; expiresAtMs: number } | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("shopify_auth_tokens")
    .select("access_token, expires_at")
    .eq("id", TOKEN_CACHE_ID)
    .maybeSingle();

  if (error || !data?.access_token || !data.expires_at) return null;
  const expiresAtMs = new Date(data.expires_at).getTime();
  if (!isTokenUsable(expiresAtMs)) return null;
  return { accessToken: data.access_token, expiresAtMs };
}

async function cacheToken(params: { accessToken: string; expiresAtMs: number }): Promise<void> {
  memoryToken = { accessToken: params.accessToken, expiresAtMs: params.expiresAtMs };
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("shopify_auth_tokens").upsert(
    {
      id: TOKEN_CACHE_ID,
      access_token: params.accessToken,
      expires_at: new Date(params.expiresAtMs).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

async function refreshViaClientCredentials(params: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAtMs: number }> {
  const tokenResponse = await fetch(
    `https://${normalizeShopDomain(params.shopDomain)}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: params.clientId,
        client_secret: params.clientSecret,
      }),
    },
  );

  const bodyText = await tokenResponse.text();
  if (!tokenResponse.ok) {
    throw new Error(
      `Failed to refresh Shopify token (${tokenResponse.status}): ${bodyText}`,
    );
  }

  const parsed = JSON.parse(bodyText) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) {
    throw new Error("Shopify token refresh response missing access_token.");
  }
  const expiresInSeconds = Number(parsed.expires_in || 0);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("Shopify token refresh response missing valid expires_in.");
  }

  return {
    accessToken: parsed.access_token,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
}

export async function resolveShopifyAccessToken(): Promise<ShopifyTokenResolution> {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN ?? "";
  const clientId = process.env.SHOPIFY_CLIENT_ID ?? "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET ?? "";

  if (shopDomain && clientId && clientSecret) {
    if (memoryToken && isTokenUsable(memoryToken.expiresAtMs)) {
      return {
        accessToken: memoryToken.accessToken,
        tokenSource: "SHOPIFY_CLIENT_CREDENTIALS_DB_CACHE",
      };
    }

    const dbToken = await readCachedTokenFromDb();
    if (dbToken) {
      memoryToken = dbToken;
      return {
        accessToken: dbToken.accessToken,
        tokenSource: "SHOPIFY_CLIENT_CREDENTIALS_DB_CACHE",
      };
    }

    const refreshed = await refreshViaClientCredentials({
      shopDomain,
      clientId,
      clientSecret,
    });
    await cacheToken(refreshed);
    return {
      accessToken: refreshed.accessToken,
      tokenSource: "SHOPIFY_CLIENT_CREDENTIALS_REFRESH",
    };
  }

  const staticPrimary = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
  if (staticPrimary) {
    return { accessToken: staticPrimary, tokenSource: "SHOPIFY_ACCESS_TOKEN" };
  }
  const staticAdmin = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "";
  if (staticAdmin) {
    return { accessToken: staticAdmin, tokenSource: "SHOPIFY_ADMIN_ACCESS_TOKEN" };
  }

  throw new Error(
    "Missing Shopify authentication config. Provide SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET + SHOPIFY_SHOP_DOMAIN, or fallback SHOPIFY_ACCESS_TOKEN / SHOPIFY_ADMIN_ACCESS_TOKEN.",
  );
}
