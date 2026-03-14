"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  return (
    <header className="border-b bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-emerald-700">
            KCG Ventures ERP
          </span>
        </div>
        <nav className="hidden gap-4 text-sm font-medium md:flex">
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
        </nav>
        <div className="flex items-center gap-3">
          {isLoading ? (
            <span className="text-xs text-black">Checking session…</span>
          ) : user ? (
            <>
              <span className="hidden text-xs text-zinc-600 sm:inline">
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
    </header>
  );
}

