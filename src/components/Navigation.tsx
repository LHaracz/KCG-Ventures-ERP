"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSupabase } from "@/components/InstantProvider";

type NavLeaf = { href: string; label: string };
type NavSection = { title: string; items: NavLeaf[] };

const topItems: NavLeaf[] = [
  { href: "/", label: "Dashboard" },
  { href: "/schedule", label: "Schedule" },
  { href: "/notifications", label: "Alerts" },
  { href: "/settings/notifications", label: "Notification Settings" },
];

const sections: NavSection[] = [
  {
    title: "BotanIQals",
    items: [
      { href: "/calibration", label: "Freeze Dryer Calibration" },
      { href: "/inventory", label: "Inventory & Cycle Count" },
      { href: "/products", label: "Products & BOM" },
      { href: "/cycles", label: "Production Cycles & Planner" },
      { href: "/fulfillments", label: "Fulfillments" },
      { href: "/sales-data", label: "Sales Data" },
    ],
  },
  {
    title: "MiniLeaf",
    items: [
      { href: "/microgreens", label: "Microgreens Guide" },
      { href: "/yield", label: "Yield Logging" },
      { href: "/microgreen-optimization", label: "Microgreens Optimization" },
    ],
  },
];

function NavLink({
  item,
  active,
  onClick,
}: {
  item: NavLeaf;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={`block rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-emerald-600 text-white"
          : "text-zinc-700 hover:bg-zinc-100"
      }`}
    >
      {item.label}
    </Link>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="mt-4 mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 underline decoration-zinc-300 underline-offset-4">
      {title}
    </div>
  );
}

function AccountControls({
  isLoading,
  user,
  onLogout,
}: {
  isLoading: boolean;
  user: { email?: string | null } | null;
  onLogout: () => void;
}) {
  if (isLoading) {
    return <span className="text-xs text-zinc-500">Checking session…</span>;
  }
  if (user) {
    return (
      <div className="flex flex-col gap-2">
        <span className="truncate text-xs text-zinc-600" title={user.email ?? ""}>
          {user.email}
        </span>
        <button
          type="button"
          onClick={onLogout}
          className="w-full rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
        >
          Log out
        </button>
      </div>
    );
  }
  return (
    <Link
      href="/login"
      className="inline-flex w-full items-center justify-center rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
    >
      Log in
    </Link>
  );
}

function NavMenu({
  pathname,
  onNavigate,
}: {
  pathname: string | null;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
      {topItems.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={pathname === item.href}
          onClick={onNavigate}
        />
      ))}
      {sections.map((section) => (
        <div key={section.title}>
          <SectionHeading title={section.title} />
          <div className="space-y-1">
            {section.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={pathname === item.href}
                onClick={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function Navigation() {
  const pathname = usePathname();
  const { user, isLoading, supabase } = useSupabase();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setMobileOpen(false);
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-64 md:shrink-0 md:flex-col md:border-r md:border-zinc-200 md:bg-white">
        <div className="border-b border-zinc-200 px-4 py-4">
          <span className="text-sm font-semibold text-emerald-700">
            KCG Ventures ERP
          </span>
        </div>
        <NavMenu pathname={pathname} />
        <div className="border-t border-zinc-200 px-3 py-3">
          <AccountControls isLoading={isLoading} user={user} onLogout={handleLogout} />
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="border-b bg-white md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm font-semibold text-emerald-700">
            KCG Ventures ERP
          </span>
          <button
            type="button"
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
          >
            Menu
          </button>
        </div>

        {mobileOpen && (
          <div
            id="mobile-nav"
            className="flex max-h-[calc(100vh-56px)] flex-col border-t border-zinc-200"
          >
            <NavMenu pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            <div className="border-t border-zinc-200 px-3 py-3">
              <AccountControls
                isLoading={isLoading}
                user={user}
                onLogout={handleLogout}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
