"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSupabase } from "@/components/InstantProvider";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/calibration", label: "Freeze Dryer Calibration" },
  { href: "/microgreens", label: "Microgreen Guide" },
  { href: "/yield", label: "Yield Logging" },
  { href: "/inventory", label: "Inventory & Cycle Count" },
  { href: "/products", label: "Products & BOM" },
  { href: "/cycles", label: "Production Cycles & Planner" },
  { href: "/schedule", label: "Schedule" },
  { href: "/notifications", label: "Alerts" },
  { href: "/settings/notifications", label: "Notification settings" },
];

export function Navigation() {
  const pathname = usePathname();
  const { user, isLoading, supabase } = useSupabase();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  return (
    <header className="border-b bg-white">
      <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-emerald-700">
              KCG Ventures ERP
            </span>
          </div>

          <button
            type="button"
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
          >
            Menu
          </button>

          <div className="hidden items-center gap-3 md:flex">
            {isLoading ? (
              <span className="text-xs text-black">Checking session…</span>
            ) : user ? (
              <>
                <span className="hidden text-xs text-zinc-600 lg:inline">
                  {user.email}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
                >
                  Log out
                </button>
              </>
            ) : (
              <Link
                href="/login"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
              >
                Log in
              </Link>
            )}
          </div>
        </div>

        <nav className="hidden pt-3 md:block">
          <div className="flex flex-wrap gap-2 text-sm font-medium">
            {navItems.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md px-3 py-1.5 transition ${
                    active
                      ? "bg-emerald-600 text-white"
                      : "text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>

        {mobileOpen && (
          <nav id="mobile-nav" className="pt-3 md:hidden">
            <div className="grid gap-1 rounded-md border border-zinc-200 bg-white p-2 text-sm font-medium">
              {navItems.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`rounded-md px-3 py-2 transition ${
                      active
                        ? "bg-emerald-600 text-white"
                        : "text-zinc-700 hover:bg-zinc-100"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
              <div className="mt-1 border-t border-zinc-200 pt-2">
                {isLoading ? (
                  <span className="px-3 text-xs text-black">
                    Checking session…
                  </span>
                ) : user ? (
                  <div className="flex items-center justify-between gap-2 px-3">
                    <span className="truncate text-xs text-zinc-600">
                      {user.email}
                    </span>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
                    >
                      Log out
                    </button>
                  </div>
                ) : (
                  <div className="px-3">
                    <Link
                      href="/login"
                      onClick={() => setMobileOpen(false)}
                      className="inline-flex rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
                    >
                      Log in
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}

