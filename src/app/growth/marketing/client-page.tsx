"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { UrlTabs, errorBox } from "@/components/growth/GrowthUi";
import { AssetsTab, CalendarTab, ClaimsTab, ProductsTab, SettingsTab, TemplatesTab } from "@/components/growth/MarketingTabs";
import { fetchMarketing, type MarketingData } from "@/lib/growth/client";

export default function MarketingHubPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <MarketingInner />
      </Suspense>
    </AuthGuard>
  );
}

type Tab = "calendar" | "assets" | "claims" | "products" | "templates" | "settings";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "calendar", label: "Calendar" },
  { key: "assets", label: "Assets" },
  { key: "claims", label: "Claims" },
  { key: "products", label: "Products" },
  { key: "templates", label: "Templates" },
];

function MarketingInner() {
  const { user } = useSupabase();
  const param = useSearchParams().get("tab");
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

  const tabs = data?.is_admin ? [...TABS, { key: "settings" as Tab, label: "Settings" }] : TABS;
  const tab: Tab = tabs.some((t) => t.key === param) ? (param as Tab) : "calendar";

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div>
        <h1 className="text-2xl font-semibold text-black">Marketing Hub</h1>
        <p className="text-sm text-black">Plan posts, keep approved claims and product copy in one place, and store links to photos and reels. Editing and posting happen in your usual apps.</p>
      </div>
      <UrlTabs base="/growth/marketing" current={tab} tabs={tabs} />
      {error && <p className={errorBox} role="alert">{error}</p>}
      {!data && !error && <p className="text-xs text-black">Loading…</p>}
      {data && tab === "calendar" && <CalendarTab data={data} reload={load} />}
      {data && tab === "assets" && <AssetsTab data={data} reload={load} />}
      {data && tab === "claims" && <ClaimsTab data={data} reload={load} />}
      {data && tab === "products" && <ProductsTab data={data} reload={load} />}
      {data && tab === "templates" && <TemplatesTab data={data} reload={load} />}
      {data && tab === "settings" && data.is_admin && <SettingsTab data={data} reload={load} />}
    </div>
  );
}
