import { shopifyAdminGraphQL, orderGidToNumericId } from "@/lib/shopifyAdmin";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Sales Data import (Phase 1a) — pulls Shopify orders + line items into
 * Supabase (`orders`/`order_line_items`), and queues any line item name with
 * no `variant_component_map` match into `unmapped_line_items`. Matching is by
 * exact line item name string only — never automatic/parsed — per the
 * feature spec (Shopify order data here has no SKUs populated).
 *
 * Reuses shopifyAdminGraphQL from shopifyAdmin.ts (the same client the
 * Fulfillments feature uses), not the REST-based shopifyInventorySync.ts
 * client, which is for stock-quantity pushes — a different concern.
 */

const SALES_IMPORT_STATE_ID = "d0000000-0000-0000-0000-000000000001";

type ShopifyOrderNode = {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  email: string | null;
  totalPriceSet: { shopMoney: { amount: string } } | null;
  customer: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  lineItems: {
    edges: Array<{
      node: {
        name: string;
        quantity: number;
        sku: string | null;
        originalUnitPriceSet: { shopMoney: { amount: string } } | null;
      };
    }>;
  };
};

type OrdersQueryResponse = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: ShopifyOrderNode }>;
  };
};

const ORDER_FIELDS = `
  id
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  email
  totalPriceSet {
    shopMoney {
      amount
    }
  }
  customer {
    firstName
    lastName
    email
    phone
  }
  lineItems(first: 100) {
    edges {
      node {
        name
        quantity
        sku
        originalUnitPriceSet {
          shopMoney {
            amount
          }
        }
      }
    }
  }
`;

const ORDERS_QUERY = `
  query SalesDataOrders($first: Int!, $query: String, $after: String) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: false, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${ORDER_FIELDS}
        }
      }
    }
  }
`;

function requireAdmin() {
  if (!supabaseAdmin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return supabaseAdmin;
}

function buildSearchQuery(since: string | null, until: string | null): string | null {
  const parts: string[] = [];
  if (since) parts.push(`created_at:>='${since}'`);
  if (until) parts.push(`created_at:<='${until}'`);
  return parts.length > 0 ? parts.join(" ") : null;
}

export type SalesImportResult = {
  importedOrders: number;
  newUnmappedCount: number;
};

export async function runSalesImport(params: {
  since?: string | null;
  until?: string | null;
}): Promise<SalesImportResult> {
  const admin = requireAdmin();
  const importStartedAt = new Date().toISOString();

  let since = params.since ?? null;
  const until = params.until ?? null;

  if (!since) {
    const { data: stateRow } = await admin
      .from("sales_import_state")
      .select("last_imported_at")
      .eq("id", SALES_IMPORT_STATE_ID)
      .maybeSingle();
    since = stateRow?.last_imported_at ?? null;
  }

  const searchQuery = buildSearchQuery(since, until);

  // Preload existing mapped line item names once — this run's "unmapped"
  // check is against the mapping as it stood when the import started.
  const { data: mapRows, error: mapError } = await admin
    .from("variant_component_map")
    .select("lineitem_name");
  if (mapError) throw new Error(mapError.message);
  const mappedNames = new Set((mapRows || []).map((r) => r.lineitem_name));

  let importedOrders = 0;
  let latestCreatedAt: string | null = null;
  // lineitem_name -> number of NEW (unmapped) occurrences seen this run.
  const unmappedIncrements = new Map<string, number>();

  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: OrdersQueryResponse = await shopifyAdminGraphQL<OrdersQueryResponse>(ORDERS_QUERY, {
      first: 100,
      query: searchQuery,
      after,
    });

    for (const edge of data.orders.edges) {
      const node = edge.node;
      const shopifyOrderId = orderGidToNumericId(node.id);
      const customerName = node.customer
        ? [node.customer.firstName, node.customer.lastName].filter(Boolean).join(" ") || null
        : null;
      const customerEmail = node.customer?.email ?? node.email ?? null;
      const total = node.totalPriceSet ? Number(node.totalPriceSet.shopMoney.amount) : null;

      const { data: orderRow, error: orderError } = await admin
        .from("orders")
        .upsert(
          {
            shopify_order_id: shopifyOrderId,
            order_name: node.name,
            created_at: node.createdAt,
            financial_status: node.displayFinancialStatus,
            fulfillment_status: node.displayFulfillmentStatus,
            customer_email: customerEmail,
            customer_name: customerName,
            total,
            imported_at: new Date().toISOString(),
          },
          { onConflict: "shopify_order_id" },
        )
        .select("id")
        .single();

      if (orderError || !orderRow) {
        throw new Error(orderError?.message || `Failed to upsert order ${node.name}.`);
      }

      // Re-imported/edited order: delete+reinsert its line items rather than
      // trying to diff them.
      const { error: deleteError } = await admin
        .from("order_line_items")
        .delete()
        .eq("order_id", orderRow.id);
      if (deleteError) throw new Error(deleteError.message);

      const lineItemRows = node.lineItems.edges.map((li) => ({
        order_id: orderRow.id,
        lineitem_name: li.node.name,
        quantity: li.node.quantity,
        price: li.node.originalUnitPriceSet
          ? Number(li.node.originalUnitPriceSet.shopMoney.amount)
          : null,
        raw_sku: li.node.sku || null,
      }));

      if (lineItemRows.length > 0) {
        const { error: insertError } = await admin.from("order_line_items").insert(lineItemRows);
        if (insertError) throw new Error(insertError.message);
      }

      for (const li of node.lineItems.edges) {
        const name = li.node.name;
        if (!mappedNames.has(name)) {
          unmappedIncrements.set(name, (unmappedIncrements.get(name) ?? 0) + 1);
        }
      }

      importedOrders += 1;
      if (!latestCreatedAt || node.createdAt > latestCreatedAt) {
        latestCreatedAt = node.createdAt;
      }
    }

    hasNextPage = data.orders.pageInfo.hasNextPage;
    after = data.orders.pageInfo.endCursor;
  }

  // Upsert the unmapped queue: increment existing rows, insert new ones.
  let newUnmappedCount = 0;
  if (unmappedIncrements.size > 0) {
    const names = Array.from(unmappedIncrements.keys());
    const { data: existingUnmapped, error: existingError } = await admin
      .from("unmapped_line_items")
      .select("id, lineitem_name, order_count")
      .in("lineitem_name", names);
    if (existingError) throw new Error(existingError.message);

    const existingByName = new Map((existingUnmapped || []).map((r) => [r.lineitem_name, r]));

    for (const name of names) {
      const increment = unmappedIncrements.get(name) ?? 0;
      const existing = existingByName.get(name);
      if (existing) {
        const { error } = await admin
          .from("unmapped_line_items")
          .update({ order_count: existing.order_count + increment })
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await admin.from("unmapped_line_items").insert({
          lineitem_name: name,
          order_count: increment,
        });
        if (error) throw new Error(error.message);
        newUnmappedCount += 1;
      }
    }
  }

  // Advance the "since last import" watermark, but never move it backward —
  // a bounded historical backfill (an explicit `until`) must not regress the
  // cursor used by future "since last import" runs.
  const { data: currentStateRow } = await admin
    .from("sales_import_state")
    .select("last_imported_at")
    .eq("id", SALES_IMPORT_STATE_ID)
    .maybeSingle();
  const currentWatermark = currentStateRow?.last_imported_at ?? null;
  const candidateWatermark = latestCreatedAt ?? importStartedAt;
  const nextWatermark =
    !currentWatermark || candidateWatermark > currentWatermark ? candidateWatermark : currentWatermark;

  await admin
    .from("sales_import_state")
    .upsert({ id: SALES_IMPORT_STATE_ID, last_imported_at: nextWatermark }, { onConflict: "id" });

  return { importedOrders, newUnmappedCount };
}
