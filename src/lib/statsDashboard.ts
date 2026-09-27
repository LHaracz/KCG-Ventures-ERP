// Pure computation pipeline behind the /stats Sales Stats dashboard. Takes
// already-fetched rows (the page does the Supabase fetching) and produces
// every KPI/chart dataset the page renders. Kept separate from the page so
// the math is testable standalone (npx tsx), same convention as
// botaniqalsOptimization.ts.
//
// Design note: "Total Revenue" everywhere here (the KPI card AND every
// chart) is the sum of RESOLVED line-item revenue (price * quantity, for
// line items that map to the business/scope in question) — never
// orders.total. orders.total can include shipping/tax and doesn't split by
// business, so using it would make the KPI card disagree with the charts
// built from line items. An unmapped line item (no variant_component_map
// row) is excluded from every total consistently, since its business can't
// be determined — computeStatsDashboard() reports how much revenue that
// represents so the page can surface it as an advisory rather than silently
// dropping it.
//
// Business scoping happens at the LINE-ITEM level, not by an order's
// overall Sales-Data-style BusinessTag ("Mixed" orders exist — e.g. someone
// buying both a BotanIQals and a MiniLeaf item at a market booth — and
// excluding them entirely would under-count real revenue). "Total Orders"
// for a given scope counts distinct orders with at least one in-scope line
// item.
import { toZonedTime } from "date-fns-tz";
import { format, startOfWeek } from "date-fns";
import {
  resolveLineItemBusiness,
  resolveLineItemComponents,
  type MappingComponent,
} from "@/lib/salesAttribution";
import { computeChannelBucket, type ChannelBucket } from "@/lib/marketMatching";
import { splitLineItemRevenueByComponents, orderContainsBundle } from "@/lib/bundleAttribution";

export type BusinessScope = "all" | "botaniqals" | "minileaf";

export type OrderForStats = {
  id: string;
  created_at: string;
  channel: string | null;
  market_id: string | null;
  pos_category: "market" | "other" | null;
  billing_name: string | null;
};

export type LineItemForStats = {
  order_id: string;
  lineitem_name: string;
  quantity: number;
  price: number | null;
};

export type ProductForStats = {
  id: string;
  name: string;
  is_microgreen: boolean;
  sale_price_per_unit: number | null;
};

export type MarketOption = { id: string; name: string };

export type MarketFilter = "all" | "other_pos_only" | string; // string = a market id

function zonedWeekStartKey(createdAtIso: string, timezone: string): string {
  const zoned = toZonedTime(new Date(createdAtIso), timezone);
  // startOfWeek operates on whatever Date it's given using its own local
  // getters — since `zoned` already carries the target zone's wall-clock
  // time in those getters (same trick used throughout this app, see
  // src/lib/marketMatching.ts), this correctly buckets by the
  // business-local week.
  const weekStart = startOfWeek(zoned, { weekStartsOn: 1 });
  return format(weekStart, "yyyy-MM-dd");
}

function zonedDayOfWeek(createdAtIso: string, timezone: string): number {
  return toZonedTime(new Date(createdAtIso), timezone).getDay();
}

function zonedHourOfDay(createdAtIso: string, timezone: string): number {
  return toZonedTime(new Date(createdAtIso), timezone).getHours();
}

// Every Monday-start week-key that overlaps [startDateIso, endDateIso],
// sorted ascending. Reused for the Weekly Revenue vs Target chart's x-axis,
// the Target Pace banner's week count, and Product Revenue Mix by Week.
export function buildWeekBuckets(startDateIso: string, endDateIso: string, timezone: string): string[] {
  const start = toZonedTime(new Date(startDateIso), timezone);
  const end = toZonedTime(new Date(endDateIso), timezone);
  const keys: string[] = [];
  let cursor = startOfWeek(start, { weekStartsOn: 1 });
  const lastWeekStart = startOfWeek(end, { weekStartsOn: 1 });
  while (cursor <= lastWeekStart) {
    keys.push(format(cursor, "yyyy-MM-dd"));
    const next = new Date(cursor);
    next.setDate(next.getDate() + 7);
    cursor = next;
  }
  return keys;
}

type ResolvedLineItem = {
  order: OrderForStats;
  lineitem_name: string;
  quantity: number;
  revenue: number;
  business: "botaniqals" | "minileaf" | null;
};

function includeLineItemForScope(business: "botaniqals" | "minileaf" | null, scope: BusinessScope): boolean {
  if (business === null) return false;
  if (scope === "all") return true;
  return business === scope;
}

export type DashboardKpis = {
  totalRevenue: number;
  totalUnits: number;
  totalOrders: number;
  channelTotals: Record<ChannelBucket, number>;
  bundleAttachRate: number | null; // null only when there are no in-scope orders
  topProductName: string | null;
  topProductRevenue: number;
  zeroSalesProductNames: string[];
  businessSplit: { botaniqals: number; minileaf: number } | null; // only for scope="all"
  unmappedRevenueExcluded: number;
};

export type WeeklyPoint = { weekStart: string; revenue: number; target: number };
export type DayOfWeekPoint = { dayOfWeek: number; revenue: number };
export type AovPoint = { weekStart: string; averageOrderValue: number };
export type ProductBarPoint = { productId: string; productName: string; value: number };
export type ProductWeekMixPoint = { weekStart: string; productId: string; productName: string; revenue: number };
export type HourSeriesPoint = { hour: number; dayOfWeek: number; revenue: number };
export type RetailerRevenuePoint = { billingName: string; revenue: number };

export type DashboardResult = {
  kpis: DashboardKpis;
  weeklyRevenueVsTarget: WeeklyPoint[];
  revenueByDayOfWeek: DayOfWeekPoint[];
  averageOrderValueByWeek: AovPoint[];
  revenueByProduct: ProductBarPoint[];
  unitsByProduct: ProductBarPoint[];
  productRevenueMixByWeek: ProductWeekMixPoint[];
  posRevenueByHour: HourSeriesPoint[];
  wholesaleByRetailer: RetailerRevenuePoint[];
};

export function computeStatsDashboard(params: {
  orders: OrderForStats[];
  lineItems: LineItemForStats[];
  businessByLineitemName: Map<string, "minileaf" | "botaniqals">;
  componentsByLineitemName: Map<string, MappingComponent[]>;
  botaniqalsProductsById: Map<string, ProductForStats>;
  scope: BusinessScope;
  marketFilter: MarketFilter;
  weeklyTargets: { botaniqals: number; minileaf: number };
  timezone: string;
  weekBuckets: string[];
}): DashboardResult {
  const {
    orders,
    lineItems,
    businessByLineitemName,
    componentsByLineitemName,
    botaniqalsProductsById,
    scope,
    marketFilter,
    weeklyTargets,
    timezone,
    weekBuckets,
  } = params;

  const ordersById = new Map(orders.map((o) => [o.id, o]));

  const resolved: ResolvedLineItem[] = [];
  let unmappedRevenueExcluded = 0;
  for (const li of lineItems) {
    const order = ordersById.get(li.order_id);
    if (!order) continue;
    const business = resolveLineItemBusiness(li.lineitem_name, businessByLineitemName);
    const revenue = (li.price ?? 0) * li.quantity;
    if (business === null) {
      unmappedRevenueExcluded += revenue;
      continue;
    }
    resolved.push({ order, lineitem_name: li.lineitem_name, quantity: li.quantity, revenue, business });
  }

  const inScope = resolved.filter((r) => includeLineItemForScope(r.business, scope));

  // Market filter: applied to POS ("market"/"other_pos" bucket) revenue only
  // — narrows which orders' revenue counts at all when a specific market or
  // "Other POS Only" is chosen. Non-POS orders are unaffected.
  const passesMarketFilter = (order: OrderForStats): boolean => {
    if (marketFilter === "all") return true;
    const bucket = computeChannelBucket(order.channel, order.pos_category);
    if (bucket !== "market" && bucket !== "other_pos") return true; // non-POS unaffected
    if (marketFilter === "other_pos_only") return bucket === "other_pos";
    return order.market_id === marketFilter; // a specific market id
  };
  const filtered = inScope.filter((r) => passesMarketFilter(r.order));

  // --- KPIs -----------------------------------------------------------
  let totalRevenue = 0;
  let minileafRawUnits = 0; // MiniLeaf has no per-product decomposition, so its
  // "units" are the raw line-item quantity, unlike BotanIQals below.
  const orderIdsInScope = new Set<string>();
  const channelTotals: Record<ChannelBucket, number> = { market: 0, other_pos: 0, online: 0, wholesale: 0 };
  for (const r of filtered) {
    totalRevenue += r.revenue;
    if (r.business === "minileaf") minileafRawUnits += r.quantity;
    orderIdsInScope.add(r.order.id);
    const bucket = computeChannelBucket(r.order.channel, r.order.pos_category);
    channelTotals[bucket] += r.revenue;
  }

  let businessSplit: { botaniqals: number; minileaf: number } | null = null;
  if (scope === "all") {
    let botaniqalsRevenue = 0;
    let minileafRevenue = 0;
    for (const r of resolved.filter((x) => passesMarketFilter(x.order))) {
      if (r.business === "botaniqals") botaniqalsRevenue += r.revenue;
      else if (r.business === "minileaf") minileafRevenue += r.revenue;
    }
    businessSplit = { botaniqals: botaniqalsRevenue, minileaf: minileafRevenue };
  }

  // Bundle attach rate: % of in-scope orders containing at least one line
  // item that maps (via variant_component_map) to more than one distinct
  // product_id — derived automatically from the mapping data, no manual
  // bundle-name configuration needed.
  let bundleAttachRate: number | null = null;
  if (orderIdsInScope.size > 0) {
    const lineItemNamesByOrder = new Map<string, string[]>();
    for (const r of filtered) {
      const arr = lineItemNamesByOrder.get(r.order.id) ?? [];
      arr.push(r.lineitem_name);
      lineItemNamesByOrder.set(r.order.id, arr);
    }
    let containing = 0;
    for (const names of lineItemNamesByOrder.values()) {
      if (orderContainsBundle(names, componentsByLineitemName)) containing += 1;
    }
    bundleAttachRate = containing / orderIdsInScope.size;
  }

  // --- Product-level splits (BotanIQals products only, always) --------
  // Note: if a line item's components ever mixed BotanIQals and MiniLeaf
  // products in the same row (the spec states this doesn't currently
  // happen), filtering to botaniqalsComponents below would attribute that
  // line's full revenue to just its BotanIQals components, not split
  // against the MiniLeaf ones too — an acceptable gap for a case that
  // doesn't exist today, flagged here in case that ever changes.
  const revenueByProductId = new Map<string, number>();
  const unitsByProductId = new Map<string, number>();
  const productWeekMix = new Map<string, Map<string, number>>(); // productId -> weekStart -> revenue

  for (const r of filtered) {
    const components = resolveLineItemComponents(r.lineitem_name, componentsByLineitemName);
    const botaniqalsComponents = components.filter((c) => botaniqalsProductsById.has(c.product_id));
    if (botaniqalsComponents.length === 0) continue;
    const splits = splitLineItemRevenueByComponents(
      { price: r.revenue / Math.max(r.quantity, 1), quantity: r.quantity },
      botaniqalsComponents,
      botaniqalsProductsById,
    );
    const weekKey = zonedWeekStartKey(r.order.created_at, timezone);
    for (const s of splits) {
      revenueByProductId.set(s.product_id, (revenueByProductId.get(s.product_id) ?? 0) + s.revenue);
      unitsByProductId.set(s.product_id, (unitsByProductId.get(s.product_id) ?? 0) + s.units);
      const weekMap = productWeekMix.get(s.product_id) ?? new Map<string, number>();
      weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + s.revenue);
      productWeekMix.set(s.product_id, weekMap);
    }
  }

  const revenueByProduct: ProductBarPoint[] = Array.from(revenueByProductId.entries())
    .map(([productId, value]) => ({
      productId,
      productName: botaniqalsProductsById.get(productId)?.name ?? productId,
      value,
    }))
    .sort((a, b) => b.value - a.value);

  const unitsByProduct: ProductBarPoint[] = Array.from(unitsByProductId.entries())
    .map(([productId, value]) => ({
      productId,
      productName: botaniqalsProductsById.get(productId)?.name ?? productId,
      value,
    }))
    .sort((a, b) => b.value - a.value);

  // "Total Units Sold" KPI: BotanIQals units are the per-component
  // decomposed count (so a bundle counts as N product units, matching
  // Units Sold by Product); MiniLeaf has no component decomposition here,
  // so its units are the raw line-item quantity.
  const botaniqalsUnitsTotal = unitsByProduct.reduce((sum, p) => sum + p.value, 0);
  const totalUnits =
    scope === "botaniqals"
      ? botaniqalsUnitsTotal
      : scope === "minileaf"
        ? minileafRawUnits
        : botaniqalsUnitsTotal + minileafRawUnits;

  const productRevenueMixByWeek: ProductWeekMixPoint[] = [];
  for (const [productId, weekMap] of productWeekMix.entries()) {
    const productName = botaniqalsProductsById.get(productId)?.name ?? productId;
    for (const [weekStart, revenue] of weekMap.entries()) {
      productRevenueMixByWeek.push({ weekStart, productId, productName, revenue });
    }
  }

  const topProduct = revenueByProduct[0] ?? null;
  const zeroSalesProductNames = Array.from(botaniqalsProductsById.values())
    .filter((p) => !unitsByProductId.has(p.id) || unitsByProductId.get(p.id) === 0)
    .map((p) => p.name);

  // --- Weekly / day-of-week / hour-of-day series -----------------------
  const revenueByWeek = new Map<string, number>();
  const revenueByDay = new Map<number, number>();
  const revenueByOrderForAov = new Map<string, { week: string; revenue: number }>();
  const revenueByHourDay = new Map<string, number>(); // `${dayOfWeek}:${hour}` -> revenue

  for (const r of filtered) {
    const weekKey = zonedWeekStartKey(r.order.created_at, timezone);
    revenueByWeek.set(weekKey, (revenueByWeek.get(weekKey) ?? 0) + r.revenue);

    const dow = zonedDayOfWeek(r.order.created_at, timezone);
    revenueByDay.set(dow, (revenueByDay.get(dow) ?? 0) + r.revenue);

    const bucket = computeChannelBucket(r.order.channel, r.order.pos_category);
    if (bucket === "market" || bucket === "other_pos") {
      const hour = zonedHourOfDay(r.order.created_at, timezone);
      const key = `${dow}:${hour}`;
      revenueByHourDay.set(key, (revenueByHourDay.get(key) ?? 0) + r.revenue);
    }

    const existing = revenueByOrderForAov.get(r.order.id);
    revenueByOrderForAov.set(r.order.id, {
      week: weekKey,
      revenue: (existing?.revenue ?? 0) + r.revenue,
    });
  }

  // "All Businesses" weekly target combines both scopes' targets.
  const weeklyTargetForScope =
    scope === "all" ? weeklyTargets.botaniqals + weeklyTargets.minileaf : weeklyTargets[scope];

  const weeklyRevenueVsTarget: WeeklyPoint[] = weekBuckets.map((weekStart) => ({
    weekStart,
    revenue: revenueByWeek.get(weekStart) ?? 0,
    target: weeklyTargetForScope,
  }));

  const revenueByDayOfWeek: DayOfWeekPoint[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    revenue: revenueByDay.get(dayOfWeek) ?? 0,
  }));

  const orderCountByWeek = new Map<string, number>();
  const revenueSumByWeekForAov = new Map<string, number>();
  for (const { week, revenue } of revenueByOrderForAov.values()) {
    orderCountByWeek.set(week, (orderCountByWeek.get(week) ?? 0) + 1);
    revenueSumByWeekForAov.set(week, (revenueSumByWeekForAov.get(week) ?? 0) + revenue);
  }
  const averageOrderValueByWeek: AovPoint[] = weekBuckets.map((weekStart) => {
    const count = orderCountByWeek.get(weekStart) ?? 0;
    const revenue = revenueSumByWeekForAov.get(weekStart) ?? 0;
    return { weekStart, averageOrderValue: count > 0 ? revenue / count : 0 };
  });

  const posRevenueByHour: HourSeriesPoint[] = Array.from(revenueByHourDay.entries()).map(([key, revenue]) => {
    const [dayOfWeek, hour] = key.split(":").map(Number);
    return { dayOfWeek, hour, revenue };
  });

  // --- Wholesale by retailer -------------------------------------------
  const revenueByBillingName = new Map<string, number>();
  for (const r of filtered) {
    const bucket = computeChannelBucket(r.order.channel, r.order.pos_category);
    if (bucket !== "wholesale") continue;
    const name = r.order.billing_name || "(unknown retailer)";
    revenueByBillingName.set(name, (revenueByBillingName.get(name) ?? 0) + r.revenue);
  }
  const wholesaleByRetailer: RetailerRevenuePoint[] = Array.from(revenueByBillingName.entries())
    .map(([billingName, revenue]) => ({ billingName, revenue }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    kpis: {
      totalRevenue,
      totalUnits,
      totalOrders: orderIdsInScope.size,
      channelTotals,
      bundleAttachRate,
      topProductName: topProduct?.productName ?? null,
      topProductRevenue: topProduct?.value ?? 0,
      zeroSalesProductNames,
      businessSplit,
      unmappedRevenueExcluded,
    },
    weeklyRevenueVsTarget,
    revenueByDayOfWeek,
    averageOrderValueByWeek,
    revenueByProduct,
    unitsByProduct,
    productRevenueMixByWeek,
    posRevenueByHour,
    wholesaleByRetailer,
  };
}
