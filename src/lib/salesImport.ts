import { shopifyAdminGraphQL, orderGidToNumericId } from "@/lib/shopifyAdmin";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parseCsv } from "@/lib/csvParse";
import {
  preloadInventoryCache,
  recordInventoryTransaction,
  type InventoryRowCache,
} from "@/lib/finishedGoodsInventory";

/**
 * Sales Data import — pulls Shopify orders + line items into Supabase
 * (`orders`/`order_line_items`), and queues any line item name with no
 * `variant_component_map` match into `unmapped_line_items`. Matching is by
 * exact line item name string only — never automatic/parsed — per the
 * feature spec (Shopify order data here has no SKUs populated).
 *
 * Two entry points, one shared upsert path:
 *  - runSalesImport(): pulls from Shopify's Admin GraphQL API. Even with
 *    status:any and the read_all_orders scope, this only reaches orders
 *    Shopify's Orders API actually exposes — in practice that's capped to
 *    a rolling recent window for this store, so it's the "keep current"
 *    path, not the full-history path.
 *  - runCsvSalesImport(): parses a Shopify order-export CSV (Admin →
 *    Orders → Export) for the orders the API won't return — the "backfill
 *    history" path.
 * Both funnel into processNormalizedOrders(), so upserting, de-duplication
 * (safe to re-run over an overlapping range), unmapped-line-item tracking,
 * and the "since last import" watermark all behave identically either way.
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

function buildSearchQuery(since: string | null, until: string | null): string {
  // Shopify's orders() query defaults to status:open when no status term is
  // given, silently excluding closed/archived orders — which is most orders
  // more than a few weeks old. status:any is required here so date-range
  // filtering (and the regular "since last import" sync) actually returns
  // full history, not just currently-open orders.
  const parts: string[] = ["status:any"];
  if (since) parts.push(`created_at:>='${since}'`);
  if (until) parts.push(`created_at:<='${until}'`);
  return parts.join(" ");
}

// A single order + its line items, already normalized to the shape the
// shared upsert path needs — regardless of whether it came from Shopify's
// API or a parsed CSV row group.
type NormalizedOrderInput = {
  shopifyOrderId: string;
  orderName: string;
  createdAt: string; // ISO 8601
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  customerEmail: string | null;
  customerName: string | null;
  total: number | null;
  lineItems: Array<{ name: string; quantity: number; price: number | null; sku: string | null }>;
};

export type SalesImportResult = {
  importedOrders: number;
  newUnmappedCount: number;
};

type MappingComponent = { product_id: string; qty_per_unit: number };

// Upserts a batch of already-normalized orders (each order upserted on
// shopify_order_id, its line items deleted+reinserted), tracks newly-seen
// unmapped line item names, applies finished-goods inventory decrements for
// BotanIQals components, and advances the "since last import" watermark.
// Shared by both the Shopify API import and the CSV import so re-running
// either one over an overlapping range never creates duplicates.
async function processNormalizedOrders(
  admin: NonNullable<typeof supabaseAdmin>,
  orders: NormalizedOrderInput[],
  triggeredByUserId: string | null = null,
): Promise<SalesImportResult> {
  const importedAt = new Date().toISOString();

  // Preload the full mapping (not just names) once — this run's "unmapped"
  // check, and the inventory decrement below, both work off the mapping as
  // it stood when the import started.
  const { data: mapRows, error: mapError } = await admin
    .from("variant_component_map")
    .select("lineitem_name, components");
  if (mapError) throw new Error(mapError.message);
  const mappingByName = new Map<string, MappingComponent[]>(
    (mapRows || []).map((r) => [r.lineitem_name, (r.components || []) as MappingComponent[]]),
  );

  // MiniLeaf/microgreens are out of scope for finished-goods inventory —
  // only decrement components whose product is a BotanIQals product.
  const { data: botaniqalsProductRows, error: botaniqalsProductsError } = await admin
    .from("products")
    .select("id")
    .eq("is_microgreen", false);
  if (botaniqalsProductsError) throw new Error(botaniqalsProductsError.message);
  const botaniqalsProductIds = new Set((botaniqalsProductRows || []).map((p) => p.id));

  const inventoryCache: InventoryRowCache = await preloadInventoryCache(admin);

  let importedOrders = 0;
  let latestCreatedAt: string | null = null;
  // lineitem_name -> number of NEW (unmapped) occurrences seen this run.
  const unmappedIncrements = new Map<string, number>();

  for (const order of orders) {
    const { data: orderRow, error: orderError } = await admin
      .from("orders")
      .upsert(
        {
          shopify_order_id: order.shopifyOrderId,
          order_name: order.orderName,
          created_at: order.createdAt,
          financial_status: order.financialStatus,
          fulfillment_status: order.fulfillmentStatus,
          customer_email: order.customerEmail,
          customer_name: order.customerName,
          total: order.total,
          imported_at: importedAt,
        },
        { onConflict: "shopify_order_id" },
      )
      .select("id, inventory_applied")
      .single();

    if (orderError || !orderRow) {
      throw new Error(orderError?.message || `Failed to upsert order ${order.orderName}.`);
    }

    // Re-imported/edited order: delete+reinsert its line items rather than
    // trying to diff them.
    const { error: deleteError } = await admin
      .from("order_line_items")
      .delete()
      .eq("order_id", orderRow.id);
    if (deleteError) throw new Error(deleteError.message);

    const lineItemRows = order.lineItems.map((li, index) => ({
      order_id: orderRow.id,
      lineitem_name: li.name,
      quantity: li.quantity,
      price: li.price,
      raw_sku: li.sku,
      position: index,
    }));

    if (lineItemRows.length > 0) {
      const { error: insertError } = await admin.from("order_line_items").insert(lineItemRows);
      if (insertError) throw new Error(insertError.message);
    }

    // Inventory decrement: only attempt for an order that isn't already
    // fully applied. A line item with no mapping is skipped on its own
    // (doesn't block the rest of the order), and the order is only marked
    // inventory_applied once every line item has been mapped and
    // processed — so a future re-import picks up the rest once mapped.
    //
    // Re-import safety: an order that's already partially decremented (some
    // items mapped, one still unmapped) must not be double-decremented on a
    // later re-import before it's fully mapped. Since inventory_applied is
    // order-level, we additionally check this order's own existing
    // sale_decrease transactions and skip any (product, line item) pair
    // that's already there — this is why the transaction's note is set to
    // the exact line item name, doubling as the dedup key.
    const attemptDecrement = !orderRow.inventory_applied;
    let orderFullyMapped = true;

    let alreadyProcessedKeys: Set<string> | null = null;
    if (attemptDecrement) {
      const { data: existingTx, error: existingTxError } = await admin
        .from("inventory_transactions")
        .select("product_id, note")
        .eq("reference_type", "order")
        .eq("reference_id", orderRow.id)
        .eq("type", "sale_decrease");
      if (existingTxError) throw new Error(existingTxError.message);
      alreadyProcessedKeys = new Set((existingTx || []).map((t) => `${t.product_id}::${t.note ?? ""}`));
    }

    for (const li of order.lineItems) {
      const mapping = mappingByName.get(li.name);
      if (!mapping) {
        orderFullyMapped = false;
        unmappedIncrements.set(li.name, (unmappedIncrements.get(li.name) ?? 0) + 1);
        continue;
      }

      if (!attemptDecrement) continue;

      for (const component of mapping) {
        if (!botaniqalsProductIds.has(component.product_id)) continue; // MiniLeaf — no transaction
        const key = `${component.product_id}::${li.name}`;
        if (alreadyProcessedKeys!.has(key)) continue; // already decremented in a prior partial run

        const rawAmount = Number(component.qty_per_unit) * Number(li.quantity);
        if (!Number.isFinite(rawAmount) || rawAmount === 0) continue;
        const decrementAmount = Math.round(rawAmount);

        await recordInventoryTransaction(admin, {
          productId: component.product_id,
          type: "sale_decrease",
          quantityDelta: -decrementAmount,
          referenceType: "order",
          referenceId: orderRow.id,
          note: li.name,
          createdBy: triggeredByUserId,
          cache: inventoryCache,
        });
      }
    }

    if (attemptDecrement && orderFullyMapped) {
      const { error: applyError } = await admin
        .from("orders")
        .update({ inventory_applied: true })
        .eq("id", orderRow.id);
      if (applyError) throw new Error(applyError.message);
    }

    importedOrders += 1;
    if (!latestCreatedAt || order.createdAt > latestCreatedAt) {
      latestCreatedAt = order.createdAt;
    }
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

  // Advance the "since last import" watermark, but only when this batch
  // actually contained orders with real created_at values, and never move
  // it backward. (A batch that parsed to zero usable orders — e.g. a bad
  // CSV upload — must NOT touch the watermark, or a future "since last
  // import" API sync would silently skip everything before now.)
  if (latestCreatedAt) {
    const { data: currentStateRow } = await admin
      .from("sales_import_state")
      .select("last_imported_at")
      .eq("id", SALES_IMPORT_STATE_ID)
      .maybeSingle();
    const currentWatermark = currentStateRow?.last_imported_at ?? null;
    const nextWatermark =
      !currentWatermark || latestCreatedAt > currentWatermark ? latestCreatedAt : currentWatermark;

    await admin
      .from("sales_import_state")
      .upsert({ id: SALES_IMPORT_STATE_ID, last_imported_at: nextWatermark }, { onConflict: "id" });
  }

  return { importedOrders, newUnmappedCount };
}

export async function runSalesImport(params: {
  since?: string | null;
  until?: string | null;
  triggeredByUserId?: string | null;
}): Promise<SalesImportResult> {
  const admin = requireAdmin();

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

  const normalizedOrders: NormalizedOrderInput[] = [];
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
      const customerName = node.customer
        ? [node.customer.firstName, node.customer.lastName].filter(Boolean).join(" ") || null
        : null;
      const customerEmail = node.customer?.email ?? node.email ?? null;
      const total = node.totalPriceSet ? Number(node.totalPriceSet.shopMoney.amount) : null;

      normalizedOrders.push({
        shopifyOrderId: orderGidToNumericId(node.id),
        orderName: node.name,
        createdAt: node.createdAt,
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
        customerEmail,
        customerName,
        total,
        lineItems: node.lineItems.edges.map((li) => ({
          name: li.node.name,
          quantity: li.node.quantity,
          price: li.node.originalUnitPriceSet
            ? Number(li.node.originalUnitPriceSet.shopMoney.amount)
            : null,
          sku: li.node.sku || null,
        })),
      });
    }

    hasNextPage = data.orders.pageInfo.hasNextPage;
    after = data.orders.pageInfo.endCursor;
  }

  return processNormalizedOrders(admin, normalizedOrders, params.triggeredByUserId ?? null);
}

// --- CSV import (backfill path) ---------------------------------------

const CSV_REQUIRED_HEADERS = ["Name", "Id"];

function parseCsvNumber(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseCsvDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    // Shopify exports "YYYY-MM-DD HH:mm:ss -0400" (space, not "T"); most
    // JS date parsers accept that already, but fall back to an ISO-ish
    // rewrite for any environment that doesn't.
    parsed = new Date(trimmed.replace(" ", "T"));
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export type CsvImportParseResult = {
  orders: NormalizedOrderInput[];
  skippedRowCount: number;
  errors: string[];
};

// Parses a Shopify order-export CSV (Admin → Orders → Export). Shopify
// repeats the order "Name" on every line-item row of an order but leaves
// the rest of that order's fields blank after its first row — so orders
// are grouped by consecutive rows sharing the same Name, forward-filling
// order-level fields from each group's first row.
export function parseShopifyOrdersCsv(csvText: string): CsvImportParseResult {
  const rows = parseCsv(csvText);
  const errors: string[] = [];

  if (rows.length === 0) {
    return { orders: [], skippedRowCount: 0, errors: ["The CSV file is empty."] };
  }

  const headers = rows[0].map((h) => h.trim());
  const missingHeaders = CSV_REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missingHeaders.length > 0) {
    return {
      orders: [],
      skippedRowCount: 0,
      errors: [
        `Missing required column(s): ${missingHeaders.join(", ")}. Export orders from Shopify ` +
          `(Orders → Export) and upload that file as-is, without editing the columns.`,
      ],
    };
  }

  const col = (row: string[], name: string): string | undefined => {
    const idx = headers.indexOf(name);
    if (idx === -1) return undefined;
    return row[idx];
  };

  type Group = {
    orderName: string;
    shopifyOrderId: string | null;
    createdAt: string | null;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    customerEmail: string | null;
    customerName: string | null;
    total: number | null;
    lineItems: Array<{ name: string; quantity: number; price: number | null; sku: string | null }>;
  };

  const groups: Group[] = [];
  let current: Group | null = null;
  let skippedRowCount = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((cell) => cell.trim() === "")) continue; // blank line

    const name = (col(row, "Name") || "").trim();
    if (!name) {
      skippedRowCount += 1;
      continue;
    }

    if (!current || current.orderName !== name) {
      const id = (col(row, "Id") || "").trim();
      const billingName = (col(row, "Billing Name") || "").trim();
      const shippingName = (col(row, "Shipping Name") || "").trim();
      current = {
        orderName: name,
        shopifyOrderId: id || null,
        createdAt: parseCsvDate(col(row, "Created at")),
        financialStatus: (col(row, "Financial Status") || "").trim() || null,
        fulfillmentStatus: (col(row, "Fulfillment Status") || "").trim() || null,
        customerEmail: (col(row, "Email") || "").trim() || null,
        customerName: billingName || shippingName || null,
        total: parseCsvNumber(col(row, "Total")),
        lineItems: [],
      };
      groups.push(current);
    }

    const lineName = (col(row, "Lineitem name") || "").trim();
    if (lineName) {
      const quantity = parseCsvNumber(col(row, "Lineitem quantity")) ?? 0;
      const price = parseCsvNumber(col(row, "Lineitem price"));
      const sku = (col(row, "Lineitem sku") || "").trim() || null;
      current.lineItems.push({ name: lineName, quantity, price, sku });
    }
  }

  const orders: NormalizedOrderInput[] = [];
  for (const group of groups) {
    if (!group.shopifyOrderId) {
      errors.push(`Order ${group.orderName}: missing "Id" column value — skipped.`);
      skippedRowCount += 1;
      continue;
    }
    if (!group.createdAt) {
      errors.push(`Order ${group.orderName}: missing or unparseable "Created at" — skipped.`);
      skippedRowCount += 1;
      continue;
    }
    if (group.lineItems.length === 0) {
      errors.push(`Order ${group.orderName}: no line items found — skipped.`);
      skippedRowCount += 1;
      continue;
    }
    orders.push({
      shopifyOrderId: group.shopifyOrderId,
      orderName: group.orderName,
      createdAt: group.createdAt,
      financialStatus: group.financialStatus,
      fulfillmentStatus: group.fulfillmentStatus,
      customerEmail: group.customerEmail,
      customerName: group.customerName,
      total: group.total,
      lineItems: group.lineItems,
    });
  }

  return { orders, skippedRowCount, errors };
}

export type CsvSalesImportResult = SalesImportResult & {
  skippedRowCount: number;
  parseErrors: string[];
};

export async function runCsvSalesImport(
  csvText: string,
  triggeredByUserId?: string | null,
): Promise<CsvSalesImportResult> {
  const admin = requireAdmin();
  const { orders, skippedRowCount, errors } = parseShopifyOrdersCsv(csvText);

  if (orders.length === 0) {
    return { importedOrders: 0, newUnmappedCount: 0, skippedRowCount, parseErrors: errors };
  }

  const result = await processNormalizedOrders(admin, orders, triggeredByUserId ?? null);
  return { ...result, skippedRowCount, parseErrors: errors };
}
