"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { UrlTabs, errorBox } from "@/components/growth/GrowthUi";
import { CalendarTab, ClaimsTab, ProductsTab, SettingsTab, TemplatesTab } from "@/components/growth/MarketingTabs";
import { AssetsTab } from "@/components/growth/AssetLibrary";
import { AdLibraryTab, PillarsTab } from "@/components/growth/LibraryTabs";
import { BestTimesTab } from "@/components/growth/LibraryCalendar";
import { fetchMarketing, type MarketingData } from "@/lib/growth/client";
import { marketingTabsFor, type MarketingTabKey } from "@/lib/growth/marketingTabs";

export default function MarketingHubPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <MarketingInner />
      </Suspense>
    </AuthGuard>
  );
}

type Tab = MarketingTabKey;

function MarketingInner() {
  const { user } = useSupabase();
  const sp = useSearchParams();
  const param = sp.get("tab");
  // Filters (as_*, lib_*, pil_*, cal_*) carry across tabs; per-item keys do not.
  const query = (() => {
    const q = new URLSearchParams(sp.toString());
    for (const k of ["item", "post"]) q.delete(k);
    return q.toString();
  })();
  const [data, setData] = useState<MarketingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await fetchMarketing();
      setData(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    void load();
  }, [user, load]);

  const tabs = marketingTabsFor(!!data?.is_admin);
  const tab: Tab = tabs.some((t) => t.key === param) ? (param as Tab) : "calendar";

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div>
        <h1 className="text-2xl font-semibold text-black">Marketing Hub</h1>
        <p className="text-sm text-black">Plan posts, keep a library of premade reels and picture posts, approved claims and product copy in one place, and store photos and links. Editing and posting happen in your usual apps.</p>
      </div>
      <UrlTabs base="/growth/marketing" current={tab} tabs={tabs} keepQuery={query} />
      {error && <p className={errorBox} role="alert">{error}</p>}
      {!data && !error && <p className="text-xs text-black">Loading…</p>}
      {data && tab === "calendar" && <CalendarTab data={data} reload={load} />}
      {data && tab === "library" && <AdLibraryTab data={data} reload={load} />}
      {data && tab === "pillars" && <PillarsTab data={data} reload={load} />}
      {data && tab === "assets" && <AssetsTab data={data} reload={load} />}
      {data && tab === "claims" && <ClaimsTab data={data} reload={load} />}
      {data && tab === "products" && <ProductsTab data={data} reload={load} />}
      {data && tab === "templates" && <TemplatesTab data={data} reload={load} />}
      {data && tab === "best-times" && <BestTimesTab data={data} reload={load} />}
      {data && tab === "settings" && data.is_admin && <SettingsTab data={data} reload={load} />}
    </div>
  );
}
