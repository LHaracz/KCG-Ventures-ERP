"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useSupabase } from "@/components/InstantProvider";

export type NavLeaf = { href: string; label: string };
export type NavCategory = { title: string; items: NavLeaf[] };
export type NavSection = {
  title: string;
  items?: NavLeaf[];
  categories?: NavCategory[];
};

const SIDEBAR_WIDTH_STORAGE_KEY = "kcg-erp-sidebar-width";
const SIDEBAR_MIN_WIDTH = 190;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 256; // matches the previous fixed w-64

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

const topItems: NavLeaf[] = [
  { href: "/", label: "Dashboard" },
  { href: "/schedule", label: "Schedule" },
  { href: "/notifications", label: "Alerts" },
  { href: "/settings/notifications", label: "Notification Settings" },
];

// Exported so other pages (e.g. the Dashboard's BotanIQals dropdowns) can
// mirror these exact categories/pages instead of maintaining a second,
// driftable copy of the same links.
export const sections: NavSection[] = [
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
          { href: "/stats", label: "Sales Stats" },
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
  inactiveTextClassName = "text-black",
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
    <div className="mt-4 mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-black underline decoration-zinc-300 underline-offset-4">
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

// Draggable handle on the sidebar's right edge. Tracks drag state via React
// state (not just CSS :hover) so the highlight persists even if the pointer
// drifts off the thin handle mid-drag; width updates live via onResize, and
// the final width is committed (and persisted) via onResizeEnd on release.
function SidebarResizeHandle({
  width,
  onResize,
  onResizeEnd,
}: {
  width: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };
    setIsDragging(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!dragState.current) return;
      const delta = moveEvent.clientX - dragState.current.startX;
      onResize(clampSidebarWidth(dragState.current.startWidth + delta));
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setIsDragging(false);
      if (dragState.current) {
        const delta = upEvent.clientX - dragState.current.startX;
        onResizeEnd(clampSidebarWidth(dragState.current.startWidth + delta));
      }
      dragState.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      className="group absolute -right-1 top-0 hidden h-full w-2 cursor-col-resize touch-none select-none md:block"
    >
      <div
        className={`mx-auto h-full transition-all ${
          isDragging ? "w-1 bg-emerald-500" : "w-px bg-zinc-200 group-hover:w-1 group-hover:bg-emerald-400"
        }`}
      />
    </div>
  );
}

export function Navigation() {
  const pathname = usePathname();
  const { user, isLoading, supabase } = useSupabase();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);

  // Read the persisted width only on the client after mount, so the initial
  // render always matches the SSR default (avoids a hydration mismatch). This
  // is an intentional one-time sync from an external store (localStorage) on
  // mount, not a derived-state loop — the empty dep array means it can only
  // ever run once per mount.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
      if (stored) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read from localStorage on mount, guarded by an empty dep array
          setSidebarWidth(clampSidebarWidth(parsed));
        }
      }
    } catch {
      // localStorage can throw in private browsing / disabled storage —
      // just keep the default width in that case.
    }
  }, []);

  const handleSidebarResizeEnd = (width: number) => {
    setSidebarWidth(width);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // localStorage can throw in private browsing / disabled storage — the
      // resize itself still works, it just won't persist this session.
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setMobileOpen(false);
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className="relative hidden md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:flex-col md:border-r md:border-zinc-200 md:bg-white"
        style={{ width: sidebarWidth }}
      >
        <div className="border-b border-zinc-200 px-4 py-4">
          <span className="text-sm font-semibold text-emerald-700">
            KCG Ventures ERP
          </span>
        </div>
        <NavMenu pathname={pathname} />
        <div className="border-t border-zinc-200 px-3 py-3">
          <AccountControls isLoading={isLoading} user={user} onLogout={handleLogout} />
        </div>
        <SidebarResizeHandle
          width={sidebarWidth}
          onResize={setSidebarWidth}
          onResizeEnd={handleSidebarResizeEnd}
        />
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
