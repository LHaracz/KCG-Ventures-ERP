import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function normalizeShopDomain(domain) {
  return domain.includes(".myshopify.com") ? domain : `${domain}.myshopify.com`;
}

function toVariantGid(variantId) {
  if (String(variantId).startsWith("gid://")) return String(variantId);
  return `gid://shopify/ProductVariant/${variantId}`;
}

function parseUnitsPerVariant(...textCandidates) {
  for (const candidate of textCandidates) {
    if (!candidate) continue;
    const text = String(candidate).toLowerCase();

    const directMatch =
      text.match(/(?:^|[^0-9])(\d{1,3})\s*[- ]?(?:pack|pk)\b/) ||
      text.match(/\bpack\s*of\s*(\d{1,3})\b/) ||
      text.match(/\b(\d{1,3})\s*x\b/);

    if (directMatch) {
      const value = Number(directMatch[1]);
      if (Number.isInteger(value) && value >= 1) return value;
    }
  }
  return 1;
}

async function fetchVariantTitlesById(variantIds) {
  const endpoint = `https://${normalizeShopDomain(
    SHOPIFY_SHOP_DOMAIN,
  )}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const ids = variantIds.map((variantId) => toVariantGid(variantId));
  const query = `
    query VariantTitles($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          product {
            title
          }
        }
      }
    }
  `;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      query,
      variables: { ids },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch Shopify variants (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const byVariantId = new Map();
  for (const node of payload.data?.nodes || []) {
    if (!node?.id) continue;
    const idMatch = String(node.id).match(/ProductVariant\/(.+)$/);
    if (!idMatch) continue;
    byVariantId.set(idMatch[1], {
      variantTitle: node.title || "",
      productTitle: node.product?.title || "",
    });
  }
  return byVariantId;
}

async function main() {
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("SHOPIFY_SHOP_DOMAIN", SHOPIFY_SHOP_DOMAIN);
  requireEnv("SHOPIFY_ACCESS_TOKEN", SHOPIFY_ACCESS_TOKEN);

  const isDryRun = process.argv.includes("--dry-run");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: inventoryRows, error } = await supabase
    .from("inventory")
    .select("id, product_name, shopify_variant_id, units_per_variant")
    .order("product_name", { ascending: true });

  if (error) {
    throw new Error(`Failed to load inventory rows: ${error.message}`);
  }

  if (!inventoryRows?.length) {
    console.log("No inventory rows found.");
    return;
  }

  const variantIds = inventoryRows.map((row) => String(row.shopify_variant_id));
  const variantMetaById = await fetchVariantTitlesById(variantIds);

  const updates = [];
  for (const row of inventoryRows) {
    const variantMeta = variantMetaById.get(String(row.shopify_variant_id));
    const nextUnits = parseUnitsPerVariant(
      variantMeta?.variantTitle,
      variantMeta?.productTitle,
      row.product_name,
    );
    const currentUnits = Number(row.units_per_variant ?? 1);
    if (nextUnits !== currentUnits) {
      updates.push({
        id: row.id,
        shopify_variant_id: row.shopify_variant_id,
        product_name: row.product_name,
        currentUnits,
        nextUnits,
      });
    }
  }

  if (updates.length === 0) {
    console.log("No units_per_variant changes needed.");
    return;
  }

  console.log(`Detected ${updates.length} rows needing updates.`);
  updates.forEach((item) => {
    console.log(
      `- ${item.product_name} | variant ${item.shopify_variant_id}: ${item.currentUnits} -> ${item.nextUnits}`,
    );
  });

  if (isDryRun) {
    console.log("Dry run only; no database changes were written.");
    return;
  }

  for (const update of updates) {
    const { error: updateError } = await supabase
      .from("inventory")
      .update({ units_per_variant: update.nextUnits })
      .eq("id", update.id);

    if (updateError) {
      throw new Error(
        `Failed updating units_per_variant for row ${update.id} (${update.product_name}): ${updateError.message}`,
      );
    }
  }

  console.log(`Updated ${updates.length} inventory rows successfully.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
