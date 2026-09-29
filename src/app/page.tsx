"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { normalizeBusinessType } from "@/lib/businessType";
import {
  computeMinileafAggregate,
  computeFeasibility,
  computeShortages,
  feasibilityBadge,
} from "@/lib/feasibility";
// Reuse the sidebar's own BotanIQals category groupings (Production /
// Inventory / Fulfillment) so the dashboard's dropdowns always show exactly
// the same pages as the side nav, with one definition to keep in sync.
import { sections as navSections, type NavCategory } from "@/components/Navigation";

const ACTIVE_STATUSES = ["draft", "planned"];

const botaniqalsCategories: NavCategory[] =
  navSections.find((s) => s.title === "BotanIQals")?.categories ?? [];

export default function Home() {
  const { user, isLoading, supabase } = useSupabase();

  const [cycles, setCycles] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [microgreens, setMicrogreens] = useState<any[]>([]);
  const [bomLines, setBomLines] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [calibration, setCalibration] = useState<any | null>(null);
  const [machine, setMachine] = useState<any | null>(null);
  const [yieldEntries, setYieldEntries] = useState<any[]>([]);
  const [variants, setVariants] = useState<any[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setDataLoading(true);
      const [c, t, p, m, b, i, cal, y, v, mach] = await Promise.all([
        supabase
          .from("production_cycles")
          .select("*")
          .eq("user_id", user.id)
          .in("status", ACTIVE_STATUSES)
          .order("start_date", { ascending: true }),
        supabase.from("production_targets").select("*").eq("user_id", user.id),
        supabase.from("products").select("*"),
        supabase.from("microgreens").select("*"),
        supabase.from("bom_lines").select("*"),
        supabase.from("inventory_items").select("*"),
        supabase.from("calibration").select("*").limit(1).maybeSingle(),
        supabase.from("yield_entries").select("*"),
        supabase.from("product_variants").select("*"),
        supabase.from("freeze_dryer_machine_settings").select("*").maybeSingle(),
      ]);
      if (cancelled) return;
      setCycles(c.data || []);
      setTargets(t.data || []);
      setProducts(p.data || []);
      setMicrogreens(m.data || []);
      setBomLines(b.data || []);
      setItems(i.data || []);
      setCalibration(cal.data || null);
      setYieldEntries(y.data || []);
      setVariants(v.data || []);
      setMachine(mach.data || null);
      setDataLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  const cycleRows = useMemo(() => {
    return cycles.map((cycle: any) => {
      const isMiniLeaf = normalizeBusinessType(cycle, { defaultType: "BotanIQals" }) === "MiniLeaf";
      const cycleTargets = targets.filter((t: any) => t.production_cycle === cycle.id);

      const minileafAggregate = computeMinileafAggregate({
        isMiniLeaf,
        targets: cycleTargets,
        products,
        variants,
        microgreens,
        yieldEntries,
      });
      const feasibility = computeFeasibility({
        cycle,
        isMiniLeaf,
        targets: cycleTargets,
        products,
        bomLines,
        calibration,
        machine,
        minileafAggregate,
      });
      const shortages = computeShortages({
        targets: cycleTargets,
        products,
        bomLines,
        items,
      });
      const shortageCount = shortages.filter((s) => s.shortage > 0).length;

      return {
        cycle,
        isMiniLeaf,
        targetCount: cycleTargets.length,
        feasibility,
        shortageCount,
      };
    });
  }, [cycles, targets, products, variants, microgreens, yieldEntries, bomLines, calibration, machine, items]);

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-black">
        Loading dashboard…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center">
        <h1 className="mb-3 text-2xl font-semibold text-zinc-900">
          Welcome to KCG Ventures ERP
        </h1>
        <p className="mb-6 text-sm text-black">
          Plan production cycles, check freeze dryer feasibility, manage
          inventory, and project cycle-level costs and profit for the shared
          BotanIQals + MiniLeaf facility.
        </p>
        <Link
          href="/login"
          className="inline-flex w-full items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 sm:w-auto"
        >
          Log in to get started
        </Link>
      </div>
    );
  }

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-8">
        <section>
          <h1 className="mb-2 text-2xl font-semibold text-zinc-900">
            Production Dashboard
          </h1>
          <p className="text-sm text-black">
            Active production cycles and quick access to your most-used tools.
          </p>
        </section>

        <ActiveCyclesTable rows={cycleRows} loading={dataLoading} />

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-2">
            <Link
              href="/schedule"
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
            >
              Schedule
            </Link>
            <Link
              href="/stats"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Sales Dashboard
            </Link>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <BusinessColumn
            title="MiniLeaf"
            cards={[
              {
                href: "/microgreens",
                title: "Microgreens Guide",
                description: "Manage microgreen parameters for planning and logging.",
              },
              {
                href: "/yield",
                title: "Yield Logging",
                description: "Log fresh and dried yields per tray and microgreen.",
              },
              {
                href: "/microgreen-optimization",
                title: "Microgreen Optimization",
                description: "Optimize mixes and container counts across active products.",
              },
            ]}
          />
          <div>
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 underline decoration-zinc-300 underline-offset-4">
              BotanIQals
            </h2>
            <div className="space-y-3">
              {botaniqalsCategories.map((category) => (
                <CategoryDropdown key={category.title} category={category} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}

// Mirrors the sidebar's collapsible BotanIQals categories (Production /
// Inventory / Fulfillment) as a stack of dropdowns: click a category to
// reveal the same pages as buttons, instead of one long flat card list.
function CategoryDropdown({ category }: { category: NavCategory }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-zinc-900"
      >
        <span>{category.title}</span>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${
            isOpen ? "rotate-90" : ""
          }`}
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {isOpen && (
        <div className="flex flex-wrap gap-2 border-t border-zinc-200 px-4 py-3">
          {category.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:border-emerald-500 hover:bg-zinc-50"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveCyclesTable({
  rows,
  loading,
}: {
  rows: any[];
  loading: boolean;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900">
        Active Production Cycles
      </h2>
      {loading ? (
        <p className="text-xs text-black">Loading cycles…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-black">
          No active cycles right now. Cycles marked Draft or Planned will show up
          here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Production Cycle</th>
                <th className="px-3 py-2 font-medium">Start Date</th>
                <th className="px-3 py-2 font-medium">End Date</th>
                <th className="px-3 py-2 font-medium">Feasibility Status</th>
                <th className="px-3 py-2 font-medium">Business</th>
                <th className="px-3 py-2 font-medium">Targets / Shortages</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ cycle, isMiniLeaf, targetCount, feasibility, shortageCount }) => {
                const badge = feasibilityBadge(feasibility);
                return (
                  <tr key={cycle.id} className="border-b border-zinc-100">
                    <td className="px-3 py-2">
                      <Link
                        href={`/cycles/${cycle.id}/plan`}
                        title={cycle.id}
                        className="inline-flex items-center rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-zinc-800"
                      >
                        {String(cycle.id).slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-zinc-700">{formatDate(cycle.start_date)}</td>
                    <td className="px-3 py-2 text-zinc-700">{formatDate(cycle.end_date)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-700">
                      {isMiniLeaf ? "MiniLeaf" : "BotanIQals"}
                    </td>
                    <td className="px-3 py-2 text-zinc-700">
                      {targetCount} target{targetCount === 1 ? "" : "s"}
                      {shortageCount > 0 && (
                        <span className="ml-2 inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800">
                          {shortageCount} shortage{shortageCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BusinessColumn({
  title,
  cards,
}: {
  title: string;
  cards: { href: string; title: string; description: string }[];
}) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 underline decoration-zinc-300 underline-offset-4">
        {title}
      </h2>
      <div className="space-y-3">
        {cards.map((card) => (
          <ShortcutCard key={card.href} {...card} />
        ))}
      </div>
    </div>
  );
}

function ShortcutCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-lg border border-zinc-200 bg-white p-4 text-left shadow-sm transition hover:border-emerald-500 hover:shadow-md"
    >
      <span className="mb-1 text-sm font-semibold text-zinc-900">{title}</span>
      <span className="text-xs text-zinc-600">{description}</span>
    </Link>
  );
}
