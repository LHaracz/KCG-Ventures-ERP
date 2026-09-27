"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar, Line, Doughnut, Pie, Chart } from "react-chartjs-2";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { fetchAllRows } from "@/lib/supabasePagination";
import {
  buildComponentsByLineitemName,
  buildBusinessByLineitemName,
  type VariantMapRow,
} from "@/lib/salesAttribution";
import { type ChannelBucket } from "@/lib/marketMatching";
import {
  computeStatsDashboard,
  buildWeekBuckets,
  type BusinessScope,
  type MarketFilter,
  type OrderForStats,
  type LineItemForStats,
  type ProductForStats,
  type DashboardResult,
} from "@/lib/statsDashboard";

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend);

const NOTIFICATION_CONFIG_ID = "a0000000-0000-0000-0000-000000000001";
const DEFAULT_TIMEZONE = "America/New_York";
const BUNDLE_SETTINGS_ID = "f0000000-0000-0000-0000-000000000001";

const BRAND_GREEN = "#1a472a";
const BRAND_GREEN_LIGHT = "#2f6b45";

// Fixed-order categorical colors — identity follows a color regardless of
// how the underlying values rank, never re-assigned when a filter changes
// which series are present.
const CATEGORICAL_COLORS = ["#10b981", "#f59e0b", "#0ea5e9", "#8b5cf6", "#f43f5e", "#eab308", "#64748b", "#84cc16"];

const CHANNEL_COLORS: Record<ChannelBucket, string> = {
  market: "#10b981",
  other_pos: "#f59e0b",
  online: "#0ea5e9",
  wholesale: "#8b5cf6",
};
const CHANNEL_LABELS: Record<ChannelBucket, string> = {
  market: "Market Sales",
  other_pos: "Other POS Sales",
  online: "Online",
  wholesale: "Wholesale",
};
const CHANNEL_ORDER: ChannelBucket[] = ["market", "other_pos", "online", "wholesale"];

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatCurrency(amount: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoDateKey(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

type MarketOption = { id: string; name: string };
type ProductOption = { id: string; name: string; is_microgreen: boolean; sale_price_per_unit: number | null };

const scopeLabels: Record<BusinessScope, string> = {
  all: "All Businesses",
  botaniqals: "BotanIQals",
  minileaf: "MiniLeaf",
};

export default function StatsPage() {
  const { supabase } = useSupabase();

  // Reference data, loaded once on mount.
  const [markets, setMarkets] = useState<MarketOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [variantMap, setVariantMap] = useState<VariantMapRow[]>([]);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [loadingReference, setLoadingReference] = useState(true);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  // Controls.
  const [startDate, setStartDate] = useState(daysAgoDateKey(6));
  const [endDate, setEndDate] = useState(todayDateKey());
  const [scope, setScope] = useState<BusinessScope>("all");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const [botaniqalsTargetInput, setBotaniqalsTargetInput] = useState("0");
  const [minileafTargetInput, setMinileafTargetInput] = useState("0");
  const [bundleNamesInput, setBundleNamesInput] = useState("");

  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [result, setResult] = useState<DashboardResult | null>(null);
  const [resultScope, setResultScope] = useState<BusinessScope>("all");
  const [resultRange, setResultRange] = useState<{ start: string; end: string } | null>(null);

  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const dashboardRef = useRef<HTMLDivElement | null>(null);

  const loadReferenceData = async () => {
    const [marketsResult, productsResult, mapResult, configResult, bundleResult, statsSettingsResult] =
      await Promise.all([
        supabase.from("markets").select("id, name").order("name", { ascending: true }),
        supabase.from("products").select("id, name, is_microgreen, sale_price_per_unit").eq("is_microgreen", false),
        supabase.from("variant_component_map").select("lineitem_name, business, components"),
        supabase.from("notification_config").select("timezone").eq("id", NOTIFICATION_CONFIG_ID).maybeSingle(),
        supabase
          .from("bundle_settings")
          .select("bundle_lineitem_names")
          .eq("id", BUNDLE_SETTINGS_ID)
          .maybeSingle(),
        supabase.from("stats_settings").select("scope, weekly_revenue_target"),
      ]);

    const errors = [
      marketsResult.error?.message,
      productsResult.error?.message,
      mapResult.error?.message,
      bundleResult.error?.message,
      statsSettingsResult.error?.message,
    ].filter(Boolean);
    if (errors.length > 0) setReferenceError(errors.join(" | "));

    setMarkets((marketsResult.data || []) as MarketOption[]);
    setProducts((productsResult.data || []) as ProductOption[]);
    setVariantMap((mapResult.data || []) as VariantMapRow[]);
    setTimezone((configResult.data?.timezone as string) || DEFAULT_TIMEZONE);
    setBundleNamesInput(((bundleResult.data?.bundle_lineitem_names as string[]) || []).join(", "));

    const statsSettingsRows = (statsSettingsResult.data || []) as Array<{
      scope: string;
      weekly_revenue_target: number;
    }>;
    const settingsByScope = new Map(statsSettingsRows.map((r) => [r.scope, r.weekly_revenue_target]));
    setBotaniqalsTargetInput(String(settingsByScope.get("botaniqals") ?? 0));
    setMinileafTargetInput(String(settingsByScope.get("minileaf") ?? 0));
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingReference(true);
      setReferenceError(null);
      await loadReferenceData();
      if (!cancelled) setLoadingReference(false);
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const componentsByLineitemName = useMemo(() => buildComponentsByLineitemName(variantMap), [variantMap]);
  const businessByLineitemName = useMemo(() => buildBusinessByLineitemName(variantMap), [variantMap]);
  const botaniqalsProductsById = useMemo(() => {
    const map = new Map<string, ProductForStats>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  const parsedBundleNames = useMemo(
    () =>
      bundleNamesInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [bundleNamesInput],
  );

  const handleSaveSettings = async () => {
    setSettingsError(null);
    setSettingsMessage(null);
    const botaniqalsTarget = Number(botaniqalsTargetInput);
    const minileafTarget = Number(minileafTargetInput);
    if (!Number.isFinite(botaniqalsTarget) || !Number.isFinite(minileafTarget)) {
      setSettingsError("Weekly revenue targets must be numbers.");
      return;
    }
    setSavingSettings(true);
    try {
      const { error: statsError } = await supabase.from("stats_settings").upsert(
        [
          { scope: "botaniqals", weekly_revenue_target: botaniqalsTarget },
          { scope: "minileaf", weekly_revenue_target: minileafTarget },
        ],
        { onConflict: "scope" },
      );
      if (statsError) throw statsError;

      const { error: bundleError } = await supabase.from("bundle_settings").upsert(
        { id: BUNDLE_SETTINGS_ID, bundle_lineitem_names: parsedBundleNames },
        { onConflict: "id" },
      );
      if (bundleError) throw bundleError;

      setSettingsMessage("Settings saved.");
    } catch (err: unknown) {
      setSettingsError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleGenerate = async () => {
    setGenerateError(null);
    setGenerating(true);
    try {
      if (!startDate || !endDate || startDate > endDate) {
        throw new Error("Pick a valid start and end date (start must be on or before end).");
      }
      const rangeStartIso = new Date(`${startDate}T00:00:00`).toISOString();
      const rangeEndIso = new Date(`${endDate}T23:59:59.999`).toISOString();

      const { data: orders, error: ordersError } = await fetchAllRows<OrderForStats>((from, to) =>
        supabase
          .from("orders")
          .select("id, created_at, channel, market_id, pos_category, billing_name")
          .gte("created_at", rangeStartIso)
          .lte("created_at", rangeEndIso)
          .order("created_at", { ascending: true })
          .range(from, to),
      );
      if (ordersError) throw ordersError;

      const orderIds = new Set(orders.map((o) => o.id));
      let lineItems: LineItemForStats[] = [];
      if (orderIds.size > 0) {
        const { data: allLineItems, error: lineItemsError } = await fetchAllRows<
          LineItemForStats & { order_id: string }
        >((from, to) =>
          supabase
            .from("order_line_items")
            .select("order_id, lineitem_name, quantity, price")
            .range(from, to),
        );
        if (lineItemsError) throw lineItemsError;
        lineItems = allLineItems.filter((li) => orderIds.has(li.order_id));
      }

      const weekBuckets = buildWeekBuckets(rangeStartIso, rangeEndIso, timezone);

      const computed = computeStatsDashboard({
        orders,
        lineItems,
        businessByLineitemName,
        componentsByLineitemName,
        botaniqalsProductsById,
        scope,
        marketFilter,
        weeklyTargets: {
          botaniqals: Number(botaniqalsTargetInput) || 0,
          minileaf: Number(minileafTargetInput) || 0,
        },
        bundleLineitemNames: parsedBundleNames,
        timezone,
        weekBuckets,
      });

      setResult(computed);
      setResultScope(scope);
      setResultRange({ start: startDate, end: endDate });
    } catch (err: unknown) {
      setGenerateError(err instanceof Error ? err.message : "Failed to generate the dashboard.");
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!dashboardRef.current) return;
    setExportError(null);
    setExportingPdf(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(dashboardRef.current, { scale: 2, backgroundColor: "#ffffff" });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pageWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;
      let position = 0;

      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      const scopeLabel = scopeLabels[resultScope];
      const filename = `${scopeLabel} ${resultRange?.start} - ${resultRange?.end} Sales Dashboard.pdf`;
      pdf.save(filename);
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : "Failed to generate the PDF.");
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">Sales Stats</h1>
          <p className="text-sm text-zinc-600">
            Pick a date range and business scope, then generate a sales dashboard you can view here
            or download as a PDF.
          </p>
        </header>

        {referenceError && (
          <p className="text-xs text-red-600" role="alert">
            {referenceError}
          </p>
        )}

        {/* Controls */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">End date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-800">Business scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as BusinessScope)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Businesses</option>
                <option value="botaniqals">BotanIQals</option>
                <option value="minileaf">MiniLeaf</option>
              </select>
            </div>
            {scope !== "minileaf" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">Market filter</label>
                <select
                  value={marketFilter}
                  onChange={(e) => setMarketFilter(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="all">All Markets</option>
                  <option value="other_pos_only">Other POS Only</option>
                  {markets.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <Link href="/settings/markets" className="text-[11px] font-medium text-emerald-700 underline">
              Manage Markets →
            </Link>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || loadingReference}
              className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {generating ? "Generating…" : "Generate Dashboard"}
            </button>
          </div>
          {generateError && (
            <p className="mt-2 text-xs text-red-600" role="alert">
              {generateError}
            </p>
          )}

          <details className="mt-4 border-t border-zinc-100 pt-3">
            <summary className="cursor-pointer text-xs font-medium text-zinc-800">
              Weekly targets &amp; bundle settings
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">
                  BotanIQals weekly revenue target
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={botaniqalsTargetInput}
                  onChange={(e) => setBotaniqalsTargetInput(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">
                  MiniLeaf weekly revenue target
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={minileafTargetInput}
                  onChange={(e) => setMinileafTargetInput(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">
                  Bundle line items (comma-separated, for Bundle Attach Rate)
                </label>
                <input
                  value={bundleNamesInput}
                  onChange={(e) => setBundleNamesInput(e.target.value)}
                  placeholder="Better Smile Bundle"
                  className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleSaveSettings}
                disabled={savingSettings}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {savingSettings ? "Saving…" : "Save Settings"}
              </button>
              {settingsMessage && <span className="text-xs text-emerald-700">{settingsMessage}</span>}
              {settingsError && (
                <span className="text-xs text-red-600" role="alert">
                  {settingsError}
                </span>
              )}
            </div>
          </details>
        </section>

        {/* Dashboard */}
        {result && resultRange && (
          <>
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={handleDownloadPdf}
                disabled={exportingPdf}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-70"
                style={{ backgroundColor: BRAND_GREEN }}
              >
                {exportingPdf ? "Preparing PDF…" : "Download PDF"}
              </button>
            </div>
            {exportError && (
              <p className="text-xs text-red-600" role="alert">
                {exportError}
              </p>
            )}

            <div ref={dashboardRef} className="space-y-5 rounded-lg p-5" style={{ backgroundColor: "#f4f7f5" }}>
              <div className="rounded-lg p-4 text-white" style={{ backgroundColor: BRAND_GREEN }}>
                <h2 className="text-lg font-semibold">{scopeLabels[resultScope]} Sales Dashboard</h2>
                <p className="text-xs opacity-90">
                  {resultRange.start} — {resultRange.end}
                </p>
              </div>

              {resultScope === "all" && result.kpis.businessSplit && (
                <BusinessSplitRow split={result.kpis.businessSplit} />
              )}

              <KpiCard result={result} scope={resultScope} />

              <TargetPaceBanner
                result={result}
                scope={resultScope}
                weeklyTargets={{
                  botaniqals: Number(botaniqalsTargetInput) || 0,
                  minileaf: Number(minileafTargetInput) || 0,
                }}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <ChartCard title="Revenue by Channel">
                  <RevenueByChannelChart channelTotals={result.kpis.channelTotals} />
                </ChartCard>
                <ChartCard title="Weekly Revenue vs Target">
                  <WeeklyRevenueVsTargetChart points={result.weeklyRevenueVsTarget} />
                </ChartCard>
              </div>

              {resultScope !== "minileaf" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <ChartCard title="Revenue by Product">
                    <ProductBarChart points={result.revenueByProduct} valueFormatter={formatCurrency} />
                  </ChartCard>
                  <ChartCard title="Units Sold by Product">
                    <ProductBarChart points={result.unitsByProduct} valueFormatter={(v) => v.toFixed(0)} />
                  </ChartCard>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <ChartCard title="Total Revenue by Day of Week">
                  <RevenueByDayOfWeekChart points={result.revenueByDayOfWeek} />
                </ChartCard>
                <ChartCard title="Average Order Value by Week">
                  <AovByWeekChart points={result.averageOrderValueByWeek} />
                </ChartCard>
              </div>

              {resultScope !== "minileaf" && (
                <>
                  <ChartCard title="POS Revenue by Hour of Day">
                    <PosRevenueByHourChart points={result.posRevenueByHour} />
                  </ChartCard>

                  <ChartCard title="Product Revenue Mix by Week">
                    <ProductRevenueMixByWeekChart
                      points={result.productRevenueMixByWeek}
                      weekBuckets={result.weeklyRevenueVsTarget.map((p) => p.weekStart)}
                    />
                  </ChartCard>

                  {result.wholesaleByRetailer.length > 0 && (
                    <ChartCard title="Wholesale Revenue by Retailer">
                      <WholesaleByRetailerChart points={result.wholesaleByRetailer} />
                    </ChartCard>
                  )}

                  {resultScope === "botaniqals" && (
                    <ProductDetailTable revenueByProduct={result.revenueByProduct} unitsByProduct={result.unitsByProduct} />
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </AuthGuard>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-zinc-900">{title}</h3>
      <div className="h-64">{children}</div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function BusinessSplitRow({ split }: { split: { botaniqals: number; minileaf: number } }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-zinc-900">Business Split</h3>
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="BotanIQals Revenue" value={formatCurrency(split.botaniqals)} />
        <StatTile label="MiniLeaf Revenue" value={formatCurrency(split.minileaf)} />
      </div>
    </div>
  );
}

function KpiCard({ result, scope }: { result: DashboardResult; scope: BusinessScope }) {
  const { kpis } = result;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-zinc-900">Summary</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Total Revenue" value={formatCurrency(kpis.totalRevenue)} />
        <StatTile label="Total Units Sold" value={kpis.totalUnits.toFixed(0)} />
        <StatTile label="Total Orders" value={kpis.totalOrders.toFixed(0)} />
        <StatTile label="Market Sales Rev" value={formatCurrency(kpis.channelTotals.market)} />
        <StatTile label="Other POS Sales Rev" value={formatCurrency(kpis.channelTotals.other_pos)} />
        <StatTile label="Online Rev" value={formatCurrency(kpis.channelTotals.online)} />
        <StatTile label="Wholesale Rev" value={formatCurrency(kpis.channelTotals.wholesale)} />
        {scope !== "minileaf" && (
          <StatTile
            label="Bundle Attach Rate"
            value={kpis.bundleAttachRate == null ? "—" : formatPercent(kpis.bundleAttachRate)}
          />
        )}
        {scope !== "minileaf" && (
          <StatTile
            label="Top Product"
            value={kpis.topProductName ? `${kpis.topProductName} (${formatCurrency(kpis.topProductRevenue)})` : "—"}
          />
        )}
        {scope !== "minileaf" && (
          <StatTile
            label="Zero-Sales Alert"
            value={kpis.zeroSalesProductNames.length === 0 ? "None" : kpis.zeroSalesProductNames.join(", ")}
          />
        )}
      </div>
      {kpis.unmappedRevenueExcluded > 0 && (
        <p className="mt-2 text-[11px] text-amber-700">
          {formatCurrency(kpis.unmappedRevenueExcluded)} in unmapped line items were excluded from these totals —
          map them on the Sales Data page for complete numbers.
        </p>
      )}
    </div>
  );
}

function TargetPaceBanner({
  result,
  scope,
  weeklyTargets,
}: {
  result: DashboardResult;
  scope: BusinessScope;
  weeklyTargets: { botaniqals: number; minileaf: number };
}) {
  const weeks = result.weeklyRevenueVsTarget.length || 1;
  const targetTotal = (scope === "all" ? weeklyTargets.botaniqals + weeklyTargets.minileaf : weeklyTargets[scope]) * weeks;
  const pace = targetTotal > 0 ? result.kpis.totalRevenue / targetTotal : null;
  const color = pace == null ? "#64748b" : pace >= 1 ? "#10b981" : pace >= 0.75 ? "#f59e0b" : "#ef4444";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-900">Target Pace</span>
        <span className="text-sm font-semibold" style={{ color }}>
          {pace == null ? "No target set" : `${formatPercent(pace)} of target`}
        </span>
      </div>
      {targetTotal > 0 && (
        <p className="mt-1 text-[11px] text-zinc-600">
          {formatCurrency(result.kpis.totalRevenue)} of {formatCurrency(targetTotal)} target over {weeks} week
          {weeks === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}

function RevenueByChannelChart({ channelTotals }: { channelTotals: Record<ChannelBucket, number> }) {
  const labels = CHANNEL_ORDER.map((b) => CHANNEL_LABELS[b]);
  const data = CHANNEL_ORDER.map((b) => channelTotals[b]);
  const colors = CHANNEL_ORDER.map((b) => CHANNEL_COLORS[b]);
  return (
    <Doughnut
      data={{ labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: "#ffffff" }] }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatCurrency(Number(ctx.raw))}` } },
        },
      }}
    />
  );
}

function WeeklyRevenueVsTargetChart({ points }: { points: DashboardResult["weeklyRevenueVsTarget"] }) {
  return (
    <Chart
      type="bar"
      data={{
        labels: points.map((p) => p.weekStart),
        datasets: [
          {
            type: "bar" as const,
            label: "Revenue",
            data: points.map((p) => p.revenue),
            backgroundColor: BRAND_GREEN_LIGHT,
            borderRadius: 4,
          },
          {
            type: "line" as const,
            label: "Target",
            data: points.map((p) => p.target),
            borderColor: "#ef4444",
            borderDash: [6, 4],
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatCurrency(Number(v)) } } },
      }}
    />
  );
}

function ProductBarChart({
  points,
  valueFormatter,
}: {
  points: DashboardResult["revenueByProduct"];
  valueFormatter: (v: number) => string;
}) {
  return (
    <Bar
      data={{
        labels: points.map((p) => p.productName),
        datasets: [
          {
            data: points.map((p) => p.value),
            backgroundColor: BRAND_GREEN_LIGHT,
            borderRadius: 4,
          },
        ],
      }}
      options={{
        indexAxis: "y" as const,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => valueFormatter(Number(ctx.raw)) } },
        },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => valueFormatter(Number(v)) } } },
      }}
    />
  );
}

function RevenueByDayOfWeekChart({ points }: { points: DashboardResult["revenueByDayOfWeek"] }) {
  return (
    <Bar
      data={{
        labels: points.map((p) => DAY_LABELS[p.dayOfWeek]),
        datasets: [{ data: points.map((p) => p.revenue), backgroundColor: BRAND_GREEN_LIGHT, borderRadius: 4 }],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => formatCurrency(Number(ctx.raw)) } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatCurrency(Number(v)) } } },
      }}
    />
  );
}

function AovByWeekChart({ points }: { points: DashboardResult["averageOrderValueByWeek"] }) {
  return (
    <Line
      data={{
        labels: points.map((p) => p.weekStart),
        datasets: [
          {
            data: points.map((p) => p.averageOrderValue),
            borderColor: BRAND_GREEN,
            backgroundColor: BRAND_GREEN,
            tension: 0.2,
          },
        ],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => formatCurrency(Number(ctx.raw)) } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatCurrency(Number(v)) } } },
      }}
    />
  );
}

function PosRevenueByHourChart({ points }: { points: DashboardResult["posRevenueByHour"] }) {
  const daysPresent = Array.from(new Set(points.map((p) => p.dayOfWeek))).sort((a, b) => a - b);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const datasets = daysPresent.map((dow, idx) => ({
    label: DAY_LABELS[dow],
    data: hours.map((h) => points.find((p) => p.dayOfWeek === dow && p.hour === h)?.revenue ?? 0),
    borderColor: CATEGORICAL_COLORS[idx % CATEGORICAL_COLORS.length],
    backgroundColor: CATEGORICAL_COLORS[idx % CATEGORICAL_COLORS.length],
    tension: 0.2,
    pointRadius: 2,
  }));
  return (
    <Line
      data={{ labels: hours.map((h) => `${h}:00`), datasets }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatCurrency(Number(v)) } } },
      }}
    />
  );
}

function ProductRevenueMixByWeekChart({
  points,
  weekBuckets,
}: {
  points: DashboardResult["productRevenueMixByWeek"];
  weekBuckets: string[];
}) {
  const productNames = Array.from(new Set(points.map((p) => p.productName)));
  const datasets = productNames.map((name, idx) => ({
    label: name,
    data: weekBuckets.map(
      (week) => points.find((p) => p.weekStart === week && p.productName === name)?.revenue ?? 0,
    ),
    backgroundColor: CATEGORICAL_COLORS[idx % CATEGORICAL_COLORS.length],
    borderRadius: 3,
  }));
  return (
    <Bar
      data={{ labels: weekBuckets, datasets }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => formatCurrency(Number(v)) } },
        },
      }}
    />
  );
}

function WholesaleByRetailerChart({ points }: { points: DashboardResult["wholesaleByRetailer"] }) {
  return (
    <Pie
      data={{
        labels: points.map((p) => p.billingName),
        datasets: [
          {
            data: points.map((p) => p.revenue),
            backgroundColor: points.map((_, idx) => CATEGORICAL_COLORS[idx % CATEGORICAL_COLORS.length]),
            borderWidth: 2,
            borderColor: "#ffffff",
          },
        ],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatCurrency(Number(ctx.raw))}` } },
        },
      }}
    />
  );
}

function ProductDetailTable({
  revenueByProduct,
  unitsByProduct,
}: {
  revenueByProduct: DashboardResult["revenueByProduct"];
  unitsByProduct: DashboardResult["unitsByProduct"];
}) {
  const unitsByProductId = new Map(unitsByProduct.map((p) => [p.productId, p.value]));
  const rows = revenueByProduct.map((p) => {
    const units = unitsByProductId.get(p.productId) ?? 0;
    return {
      productName: p.productName,
      revenue: p.value,
      units,
      revenuePerUnit: units > 0 ? p.value / units : 0,
    };
  });

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-zinc-900">Product Detail</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-200 text-zinc-500">
              <th className="py-1 pr-3 font-medium">Product</th>
              <th className="py-1 pr-3 font-medium">Units</th>
              <th className="py-1 pr-3 font-medium">Revenue</th>
              <th className="py-1 pr-3 font-medium">Revenue/Unit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.productName} className="border-b border-zinc-100 text-black">
                <td className="py-1 pr-3">{r.productName}</td>
                <td className="py-1 pr-3">{r.units.toFixed(0)}</td>
                <td className="py-1 pr-3">{formatCurrency(r.revenue)}</td>
                <td className="py-1 pr-3">{formatCurrency(r.revenuePerUnit)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-zinc-500">
                  No BotanIQals product sales in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
