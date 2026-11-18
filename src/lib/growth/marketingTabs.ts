/**
 * Marketing Hub tabs, left to right, with their URL keys (?tab=...). The
 * older tabs (calendar, assets, claims, products, templates, settings) keep
 * their keys; Settings is shown to Admins only and is added by the page.
 */
export type MarketingTabKey = "calendar" | "library" | "pillars" | "assets" | "claims" | "products" | "templates" | "best-times" | "settings";

export const MARKETING_TABS: ReadonlyArray<{ key: MarketingTabKey; label: string }> = [
  { key: "calendar", label: "Calendar" },
  { key: "library", label: "Ad Library" },
  { key: "pillars", label: "Pillars" },
  { key: "assets", label: "Assets" },
  { key: "claims", label: "Claims" },
  { key: "products", label: "Products" },
  { key: "templates", label: "Templates" },
  { key: "best-times", label: "Best Times" },
];

/** The tabs a person sees: Settings is last and Admin only. */
export const marketingTabsFor = (isAdmin: boolean): Array<{ key: MarketingTabKey; label: string }> =>
  isAdmin ? [...MARKETING_TABS, { key: "settings", label: "Settings" }] : [...MARKETING_TABS];
