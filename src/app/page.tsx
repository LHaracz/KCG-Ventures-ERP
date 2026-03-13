"use client";

import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

export default function Home() {
  const { user, isLoading } = useSupabase();

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
      <div className="mx-auto max-w-5xl space-y-6">
        <section>
          <h1 className="mb-2 text-2xl font-semibold text-zinc-900">
            Production Dashboard
          </h1>
          <p className="text-sm text-black">
            High-level view of your latest production cycle, feasibility, and
            key shortcuts.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">
              Production Cycle Summary
            </h2>
            <p className="text-xs text-black">
              Cycle overview and feasibility will appear here once cycles are
              configured.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">
              Feasibility Status
            </h2>
            <p className="text-xs text-black">
              Freeze dryer and inventory feasibility for the active cycle.
            </p>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ShortcutCard
            href="/calibration"
            title="Freeze Dryer Calibration"
            description="Define machines, trays, cycle times, and capacities."
          />
          <ShortcutCard
            href="/microgreens"
            title="Microgreen Guide"
            description="Manage microgreen parameters for planning and logging."
          />
          <ShortcutCard
            href="/products"
            title="Products & BOM"
            description="Define products, microgreen links, and BOM lines."
          />
          <ShortcutCard
            href="/inventory"
            title="Inventory & Cycle Count"
            description="Track materials, adjustments, and cycle counts."
          />
          <ShortcutCard
            href="/yield"
            title="Yield Logging"
            description="Log fresh and dried yields per tray and microgreen."
          />
          <ShortcutCard
            href="/cycles"
            title="Production Cycles & Planner"
            description="Set cycle targets, feasibility, and tray plans."
          />
        </section>
      </div>
    </AuthGuard>
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

