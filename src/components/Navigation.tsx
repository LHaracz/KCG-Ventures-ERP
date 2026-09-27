"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSupabase } from "@/components/InstantProvider";

type NavLeaf = { href: string; label: string };
type NavCategory = { title: string; items: NavLeaf[] };
type NavSection = {
  title: string;
  items?: NavLeaf[];
  categories?: NavCategory[];
};

const topItems: NavLeaf[] = [
  { href: "/", label: "Dashboard" },
  { href: "/schedule", label: "Schedule" },
  { href: "/notifications", label: "Alerts" },
  { href: "/settings/notifications", label: "Notification Settings" },
];

const sections: NavSection[] = [
  {
    title: "BotanIQals",
    categories: [
      {
        title: "Production",
        items: [
          { href: "/calibration", label: "Freeze Dryer Calibration" },
          { href: "/products", label: "Products & BOM" },
          { href: "/cycles", label: "Production Cycles & Planner" },
          { href: "/production-optimization", label: "Production Optimization" },
        ],
      },
      {
        title: "Inventory",
        items: [
          { href: "/finished-products-inventory", label: "Finished Products Inventory" },
          { href: "/inventory", label: "Raw Materials" },
        ],
      },
      {
        title: "Fulfillment",
        items: [
          { href: "/fulfillments", label: "Fulfillments" },
          { href: "/sales-data", label: "Sales Data" },
        ],
      },
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
  inactiveTextClassName = "text-zinc-700",
}: {
  item: NavLeaf;
  active: boolean;
  onClick?: () => void;
  inactiveTextClassName?: string;
}) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={`block rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-emerald-600 text-white"
          : `${inactiveTextClassName} hover:bg-zinc-100`
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

// Sub-category heading nested under a business section (e.g. "Production"
// under "BotanIQals"). Deliberately smaller/lighter than SectionHeading to
// keep a clear Business > Category > Page visual hierarchy, but the text
// itself stays black (not the muted grey SectionHeading uses) per the
// nav restyle spec. Collapsible, expanded by default.
function CategorySection({
  category,
  pathname,
  onNavigate,
}: {
  category: NavCategory;
  pathname: string | null;
  onNavigate?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between rounded-md px-3 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-black hover:bg-zinc-100"
      >
        <span>{category.title}</span>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 text-zinc-500 transition-transform ${
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
        <div className="mt-0.5 space-y-1 pl-2">
          {category.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={pathname === item.href}
              onClick={onNavigate}
              inactiveTextClassName="text-black"
            />
          ))}
        </div>
      )}
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
          {section.categories ? (
            <div className="space-y-2">
              {section.categories.map((category) => (
                <CategorySection
                  key={category.title}
                  category={category}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              {(section.items ?? []).map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={pathname === item.href}
                  onClick={onNavigate}
                />
              ))}
            </div>
          )}
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
