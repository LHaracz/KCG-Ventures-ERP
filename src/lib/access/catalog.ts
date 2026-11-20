/**
 * Feature catalog: the single list of features, the pages and API routes each
 * one covers, and the sidebar built from them. Used by the sidebar, page and
 * API guards, the role editor, scripts/check-access-registry.ts and tests.
 *
 * Fail closed: a page or API route that is not registered here is Admin only.
 * Route patterns use the Next.js folder names ("/cycles/[id]/plan").
 */

export type FeatureGroup = "Production" | "Inventory" | "Fulfillment" | "Compliance" | "Marketing & Sales" | "MiniLeaf";
export type Business = "botaniqals" | "minileaf" | "general";

export type FeatureKey =
  | "production.calibration"
  | "production.products_bom"
  | "production.planner"
  | "production.optimization"
  | "production.formulation"
  | "inventory.finished_products"
  | "inventory.raw_materials"
  | "inventory.purchase_orders"
  | "fulfillment.orders"
  | "fulfillment.pick_list"
  | "fulfillment.sales_data"
  | "fulfillment.stats"
  | "fulfillment.setup"
  | "compliance.sops"
  | "compliance.logs"
  | "compliance.coas"
  | "growth.launches"
  | "growth.prospecting"
  | "growth.marketing"
  | "minileaf.guide"
  | "minileaf.optimization"
  | "minileaf.yield_logging";

export type Feature = {
  key: FeatureKey;
  label: string;
  /** One line for the role editor: what the feature includes. */
  description: string;
  group: FeatureGroup;
  business: Business;
  assignable: true;
};

/** In sidebar order. */
export const FEATURES: Feature[] = [
  { key: "production.calibration", label: "Freeze Dryer Calibration", description: "Freeze-dryer calibration settings and profiles.", group: "Production", business: "botaniqals", assignable: true },
  { key: "production.products_bom", label: "Products & BOM", description: "All products (including MiniLeaf ones), variants and bills of materials.", group: "Production", business: "botaniqals", assignable: true },
  { key: "production.formulation", label: "Formulation", description: "Formulations and syncing formulas into SOPs.", group: "Production", business: "botaniqals", assignable: true },
  { key: "production.planner", label: "Production Cycles & Planner", description: "All production cycles (including MiniLeaf), plans, summaries and Complete Production.", group: "Production", business: "botaniqals", assignable: true },
  { key: "production.optimization", label: "Production Optimization", description: "BotanIQals production quantity optimization.", group: "Production", business: "botaniqals", assignable: true },
  { key: "inventory.finished_products", label: "Finished Products Inventory", description: "Active batches, box counts, manual batches and transaction history.", group: "Inventory", business: "botaniqals", assignable: true },
  { key: "inventory.raw_materials", label: "Raw Materials", description: "Raw materials, receiving stock and adjustments.", group: "Inventory", business: "botaniqals", assignable: true },
  { key: "inventory.purchase_orders", label: "Procurement (suppliers, buy links and Purchase Orders)", description: "Procurement (suppliers, buy links and Purchase Orders): stock alerts, suppliers and where to buy, and purchase orders with their company settings.", group: "Inventory", business: "botaniqals", assignable: true },
  { key: "fulfillment.orders", label: "Fulfillments", description: "Order list and pages, Shipping Assignments, labels (generate, print, void), Mark Fulfilled, flags and address edits.", group: "Fulfillment", business: "botaniqals", assignable: true },
  { key: "fulfillment.pick_list", label: "Pick List", description: "Picking orders into staging boxes, and staging box management.", group: "Fulfillment", business: "botaniqals", assignable: true },
  { key: "fulfillment.setup", label: "Fulfillment Setup", description: "Packaging Setup, Fulfillment settings and shipping methods.", group: "Fulfillment", business: "botaniqals", assignable: true },
  { key: "compliance.sops", label: "SOPs", description: "View, create, edit, publish and archive SOPs.", group: "Compliance", business: "botaniqals", assignable: true },
  { key: "compliance.logs", label: "Logs", description: "View logs, add entries and corrections, mark reviewed, receiving log, overdue view, export. Not creating or changing log types.", group: "Compliance", business: "botaniqals", assignable: true },
  { key: "compliance.coas", label: "COAs", description: "Certificates of analysis.", group: "Compliance", business: "botaniqals", assignable: true },
  { key: "growth.launches", label: "Launch Pipeline", description: "New product launches: dated checklists with owners, and the test batch ingredient planner (order-by dates).", group: "Marketing & Sales", business: "botaniqals", assignable: true },
  { key: "growth.prospecting", label: "Retail Prospecting", description: "Store leads, visits and calls, trips with Google Maps routes, follow-ups and the retailer goal.", group: "Marketing & Sales", business: "botaniqals", assignable: true },
  { key: "growth.marketing", label: "Marketing Hub", description: "Product marketing profiles, the claims library, assets, the content calendar and caption templates.", group: "Marketing & Sales", business: "botaniqals", assignable: true },
  { key: "fulfillment.sales_data", label: "Sales Data", description: "Sales imports, CSV upload, variant mapping and unmapped items.", group: "Marketing & Sales", business: "botaniqals", assignable: true },
  { key: "fulfillment.stats", label: "Sales Stats", description: "Sales statistics.", group: "Marketing & Sales", business: "botaniqals", assignable: true },
  { key: "minileaf.guide", label: "Microgreens Guide", description: "Microgreen parameters for planning and logging.", group: "MiniLeaf", business: "minileaf", assignable: true },
  { key: "minileaf.yield_logging", label: "Yield Logging", description: "Fresh and dried yields per tray and microgreen.", group: "MiniLeaf", business: "minileaf", assignable: true },
  { key: "minileaf.optimization", label: "Microgreens Optimization", description: "Microgreen mixes and optimization.", group: "MiniLeaf", business: "minileaf", assignable: true },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);
export const MINILEAF_FEATURES = FEATURES.filter((f) => f.business === "minileaf").map((f) => f.key);
export const FEATURE_GROUPS: FeatureGroup[] = ["Production", "Inventory", "Fulfillment", "Compliance", "Marketing & Sales", "MiniLeaf"];
export const featureByKey = (key: string) => FEATURES.find((f) => f.key === key);
export const isFeatureKey = (key: string): key is FeatureKey => FEATURE_KEYS.includes(key as FeatureKey);

/** Shown in the role editor: things no role can grant. */
export const ADMIN_ONLY_NOTE =
  "Employees and Roles, Notification settings, Retail (retailers, price lists, invoices and line sheets), approving, rejecting or retiring marketing claims, the risky-word watch list, converting a lead to a retailer, and creating or changing log types are Admin only.";

// --- Access rules -----------------------------------------------------------
/**
 * public:  no sign-in needed (sign-in, invite and reset pages)
 * always:  any active employee (Dashboard, Schedule, Alerts, profile)
 * signed_in: any signed-in login, even one that isn't an active employee
 *          (needed to finish an invite or show "no access")
 * admin:   Admins only
 * feature: any of the listed features (Admins always pass)
 * system:  not a user route; has its own secret (cron, Shopify webhooks)
 */
export type Rule =
  | { kind: "public" }
  | { kind: "signed_in" }
  | { kind: "always" }
  | { kind: "admin" }
  | { kind: "system" }
  | { kind: "feature"; features: FeatureKey[] };

const F = (...features: FeatureKey[]): Rule => ({ kind: "feature", features });
const PUBLIC: Rule = { kind: "public" };
const SIGNED_IN: Rule = { kind: "signed_in" };
const ALWAYS: Rule = { kind: "always" };
const ADMIN: Rule = { kind: "admin" };
const SYSTEM: Rule = { kind: "system" };

/** Every page route in src/app. scripts/check-access-registry.ts fails on any page missing here. */
export const PAGE_RULES: Record<string, Rule> = {
  "/": ALWAYS,
  "/schedule": ALWAYS,
  "/notifications": ALWAYS,
  "/login": PUBLIC,
  "/forgot-password": PUBLIC,
  "/auth/accept-invite": PUBLIC,
  "/auth/invalid-link": PUBLIC,
  "/set-password": SIGNED_IN,
  "/complete-profile": SIGNED_IN,
  "/no-access": SIGNED_IN,

  "/employees": ADMIN,
  "/settings/employees": ADMIN, // old roster page: redirects Admins to /employees
  "/settings/notifications": ADMIN,
  "/compliance/logs/settings": ADMIN, // log template builder
  // Ambiguous (Phase 0): Admin only until assigned to a feature.
  "/settings/markets": ADMIN,
  "/settings/finished-goods": ADMIN,
  "/finished-products": ADMIN,

  "/calibration": F("production.calibration"),
  "/products": F("production.products_bom"),
  "/formulation": F("production.formulation"),
  "/formulation/new": F("production.formulation"),
  "/formulation/[id]": F("production.formulation"),
  "/formulation/backfill": F("production.formulation"),
  "/cycles": F("production.planner"),
  "/cycles/[id]/plan": F("production.planner"),
  "/cycles/[id]/summary": F("production.planner"),
  "/production-optimization": F("production.optimization"),

  "/finished-products-inventory": F("inventory.finished_products"),
  "/inventory": F("inventory.raw_materials"),
  "/inventory/procurement": F("inventory.purchase_orders"),
  "/inventory/procurement/suppliers": F("inventory.purchase_orders"),
  "/inventory/purchase-orders": F("inventory.purchase_orders"),
  "/inventory/purchase-orders/new": F("inventory.purchase_orders"),
  "/inventory/purchase-orders/[id]": F("inventory.purchase_orders"),
  "/inventory/purchase-orders/[id]/edit": F("inventory.purchase_orders"),
  "/inventory/purchase-orders/settings": F("inventory.purchase_orders"),

  "/fulfillments": F("fulfillment.orders"),
  "/fulfillments/[orderId]": F("fulfillment.orders"),
  "/fulfillments/shipping-assignments": F("fulfillment.orders"),
  "/fulfillments/pick-list": F("fulfillment.pick_list"),
  "/fulfillments/package-presets": F("fulfillment.setup"),
  "/fulfillments/settings": F("fulfillment.setup"),
  // Retail: retailers, price lists and invoices. Admin only, never assignable.
  "/fulfillment/retail": ADMIN,
  "/fulfillment/retail/settings": ADMIN,
  "/fulfillment/retail/retailers/[id]": ADMIN,
  "/fulfillment/retail/invoices/new": ADMIN,
  "/fulfillment/retail/invoices/[id]": ADMIN,
  "/fulfillment/retail/invoices/[id]/edit": ADMIN,
  "/fulfillment/retail/line-sheets/new": ADMIN,
  "/fulfillment/retail/line-sheets/[id]": ADMIN,
  "/fulfillment/retail/line-sheets/[id]/edit": ADMIN,
  // Marketing & Sales
  "/growth/launches": F("growth.launches"),
  "/growth/launches/[id]": F("growth.launches"),
  "/growth/prospecting": F("growth.prospecting"),
  "/growth/prospecting/leads/[id]": F("growth.prospecting"),
  "/growth/prospecting/trips/[id]": F("growth.prospecting"),
  "/growth/marketing": F("growth.marketing"),
  "/settings/shipping-methods": F("fulfillment.setup"),
  "/sales-data": F("fulfillment.sales_data"),
  "/settings/variant-mapping": F("fulfillment.sales_data"),
  "/stats": F("fulfillment.stats"),

  "/compliance/sops": F("compliance.sops"),
  "/compliance/sops/[id]": F("compliance.sops"),
  "/compliance/sops/[id]/edit": F("compliance.sops"),
  "/compliance/logs": F("compliance.logs"),
  "/compliance/logs/[slug]": F("compliance.logs"),
  "/compliance/logs/[slug]/new": F("compliance.logs"),
  // Receive Stock on Raw Materials opens the receiving entry form.
  "/compliance/logs/receiving/new": F("compliance.logs", "inventory.raw_materials"),
  "/compliance/logs/entries/[id]": F("compliance.logs"),
  "/compliance/coas": F("compliance.coas"),

  "/microgreens": F("minileaf.guide"),
  "/yield": F("minileaf.yield_logging"),
  "/microgreen-optimization": F("minileaf.optimization"),
};

/** Every API route in src/app/api. */
export const API_RULES: Record<string, Rule> = {
  "/api/cron/notifications": SYSTEM, // CRON_SECRET
  "/api/webhooks/orders-create": SYSTEM, // Shopify HMAC
  "/api/webhooks/orders-create/status": SYSTEM, // public diagnostics (booleans only)

  "/api/account/me": SIGNED_IN,
  "/api/account/set-password": SIGNED_IN,
  "/api/account/complete-profile": SIGNED_IN,
  "/api/account/employees": ALWAYS, // active employee names, for "trainer" and "Authorized by" pickers
  "/api/notifications/digest": ALWAYS,

  "/api/admin/employees": ADMIN,
  "/api/admin/employees/[accountId]/resend": ADMIN,
  "/api/admin/employees/[accountId]/revoke": ADMIN,
  "/api/admin/employees/[accountId]/roles": ADMIN,
  "/api/admin/employees/[accountId]/status": ADMIN,
  "/api/admin/employees/[accountId]/delete": ADMIN,
  "/api/admin/roles": ADMIN,
  "/api/admin/roles/[roleId]": ADMIN,
  "/api/admin/unrecognized": ADMIN,
  "/api/admin/unrecognized/[userId]": ADMIN,
  "/api/admin/activity": ADMIN,

  // Old Finished Products page (/finished-products) and an unused replay tool.
  "/api/inventory": ADMIN,
  "/api/inventory/cycle-count": ADMIN,
  "/api/inventory/sync": ADMIN,
  "/api/production/replay-sheets-webhook": ADMIN,

  "/api/production/complete-botaniqals": F("production.planner"),
  "/api/production/next-batch-codes": F("production.planner"),

  "/api/finished-goods/overview": F("inventory.finished_products", "production.optimization"),
  "/api/finished-goods/count": F("inventory.finished_products"),
  "/api/finished-goods/manual-batch": F("inventory.finished_products"),

  "/api/purchase-orders": F("inventory.purchase_orders"),
  // Procurement (suppliers, buy links, Create PO) shares the Purchase Orders feature.
  "/api/procurement": F("inventory.purchase_orders"),
  "/api/procurement/po-prefill": F("inventory.purchase_orders"),
  "/api/procurement/suppliers": F("inventory.purchase_orders"),
  "/api/procurement/suppliers/[supplierId]": F("inventory.purchase_orders"),
  "/api/procurement/suppliers/[supplierId]/archive": F("inventory.purchase_orders"),
  "/api/procurement/links": F("inventory.purchase_orders"),
  "/api/procurement/links/[linkId]": F("inventory.purchase_orders"),
  "/api/procurement/links/[linkId]/archive": F("inventory.purchase_orders"),
  "/api/procurement/links/[linkId]/preferred": F("inventory.purchase_orders"),
  // Procurement › Equipment tab (same feature).
  "/api/procurement/categories": F("inventory.purchase_orders"),
  "/api/procurement/categories/reorder": F("inventory.purchase_orders"),
  "/api/procurement/categories/[categoryId]": F("inventory.purchase_orders"),
  "/api/procurement/categories/[categoryId]/archive": F("inventory.purchase_orders"),
  "/api/procurement/equipment": F("inventory.purchase_orders"),
  "/api/procurement/equipment/[equipmentId]": F("inventory.purchase_orders"),
  "/api/procurement/equipment/[equipmentId]/archive": F("inventory.purchase_orders"),
  "/api/procurement/equipment/[equipmentId]/restore": F("inventory.purchase_orders"),
  "/api/procurement/equipment/[equipmentId]/delete": ADMIN,
  "/api/procurement/equipment/[equipmentId]/delete-preview": ADMIN,
  "/api/procurement/equipment-links": F("inventory.purchase_orders"),
  "/api/procurement/equipment-links/[linkId]": F("inventory.purchase_orders"),
  "/api/procurement/equipment-links/[linkId]/archive": F("inventory.purchase_orders"),
  "/api/procurement/equipment-links/[linkId]/preferred": F("inventory.purchase_orders"),
  "/api/purchase-orders/[id]": F("inventory.purchase_orders"),
  "/api/purchase-orders/company-profiles/[id]/logo": F("inventory.purchase_orders"),
  "/api/purchase-orders/company-profiles/[id]/logo-url": F("inventory.purchase_orders"),
  "/api/purchase-orders/company-profiles/logo-upload-url": F("inventory.purchase_orders"),

  "/api/growth/employees": F("growth.launches", "growth.prospecting", "growth.marketing"),
  "/api/growth/prospecting": F("growth.prospecting"),
  "/api/growth/prospecting/follow-ups": F("growth.prospecting"),
  "/api/growth/prospecting/settings": F("growth.prospecting"),
  "/api/growth/prospecting/leads": F("growth.prospecting"),
  "/api/growth/prospecting/leads/[leadId]": F("growth.prospecting"),
  "/api/growth/prospecting/leads/[leadId]/activities": F("growth.prospecting"),
  "/api/growth/prospecting/leads/[leadId]/activities/[activityId]/void": F("growth.prospecting"),
  "/api/growth/prospecting/trips": F("growth.prospecting"),
  "/api/growth/prospecting/trips/[tripId]": F("growth.prospecting"),
  "/api/growth/prospecting/trips/[tripId]/stops": F("growth.prospecting"),
  // Admin only inside the feature (the route also checks Admin).
  "/api/growth/prospecting/leads/[leadId]/convert": ADMIN,
  "/api/growth/marketing": F("growth.marketing"),
  "/api/growth/marketing/profiles/[productId]": F("growth.marketing"),
  "/api/growth/marketing/claims": F("growth.marketing"),
  "/api/growth/marketing/claims/[claimId]": F("growth.marketing"),
  "/api/growth/marketing/claims/[claimId]/submit": F("growth.marketing"),
  "/api/growth/marketing/assets": F("growth.marketing"),
  "/api/growth/marketing/assets/upload-url": F("growth.marketing"),
  "/api/growth/marketing/assets/finalize": F("growth.marketing"),
  "/api/growth/marketing/assets/signed-urls": F("growth.marketing"),
  "/api/growth/marketing/assets/[assetId]": F("growth.marketing"),
  "/api/growth/marketing/assets/[assetId]/thumbnail-url": F("growth.marketing"),
  "/api/growth/marketing/assets/[assetId]/thumbnail": F("growth.marketing"),
  "/api/growth/marketing/posts": F("growth.marketing"),
  "/api/growth/marketing/posts/[postId]": F("growth.marketing"),
  "/api/growth/marketing/templates": F("growth.marketing"),
  "/api/growth/marketing/templates/[templateId]": F("growth.marketing"),
  "/api/growth/marketing/pillars": F("growth.marketing"),
  "/api/growth/marketing/pillars/[pillarId]": F("growth.marketing"),
  "/api/growth/marketing/pillars/reletter": F("growth.marketing"),
  "/api/growth/marketing/series": F("growth.marketing"),
  "/api/growth/marketing/series/[seriesId]": F("growth.marketing"),
  "/api/growth/marketing/library": F("growth.marketing"),
  "/api/growth/marketing/library/[premadeId]": F("growth.marketing"),
  "/api/growth/marketing/library/[premadeId]/action": F("growth.marketing"),
  "/api/growth/marketing/library/bulk": F("growth.marketing"),
  "/api/growth/marketing/closing-lines": F("growth.marketing"),
  "/api/growth/marketing/closing-lines/[lineId]": F("growth.marketing"),
  "/api/growth/marketing/library/[premadeId]/needs": F("growth.marketing"),
  "/api/growth/marketing/library/needs": F("growth.marketing"),
  "/api/growth/marketing/library/[premadeId]/schedule": F("growth.marketing"),
  "/api/growth/marketing/posts/[postId]/sync": F("growth.marketing"),
  "/api/growth/marketing/assets/bulk": F("growth.marketing"),
  "/api/growth/marketing/ingredient-tags": F("growth.marketing"),
  "/api/growth/marketing/asset-categories": F("growth.marketing"),
  "/api/growth/marketing/asset-categories/[key]/delete": F("growth.marketing"),
  "/api/growth/marketing/ingredient-tags/[tagId]": F("growth.marketing"),
  "/api/growth/marketing/windows/[windowId]": F("growth.marketing"),
  "/api/growth/marketing/rhythm": F("growth.marketing"),
  "/api/growth/marketing/rhythm/[rhythmId]": F("growth.marketing"),
  // Admin only (not assignable): claim review and the risky-word list.
  "/api/growth/marketing/claims/[claimId]/review": ADMIN,
  "/api/growth/marketing/risky-words": ADMIN,
  "/api/growth/marketing/risky-words/[wordId]": ADMIN,
  "/api/growth/marketing/ingredient-tags/raw-materials": ADMIN,
  "/api/growth/marketing/avoid-phrases": ADMIN,
  "/api/growth/marketing/avoid-phrases/[phraseId]": ADMIN,
  "/api/growth/launches": F("growth.launches"),
  "/api/growth/launches/tasks-due": F("growth.launches"),
  "/api/growth/launches/[launchId]": F("growth.launches"),
  "/api/growth/launches/[launchId]/shift": F("growth.launches"),
  "/api/growth/launches/[launchId]/sync": F("growth.launches"),
  "/api/growth/launches/[launchId]/tasks": F("growth.launches"),
  "/api/growth/launches/[launchId]/tasks/reorder": F("growth.launches"),
  "/api/growth/launches/[launchId]/tasks/[taskId]": F("growth.launches"),
  "/api/growth/launches/[launchId]/ingredients/[rowId]": F("growth.launches"),

  "/api/retail": ADMIN,
  "/api/retail/settings": ADMIN,
  "/api/retail/retailers": ADMIN,
  "/api/retail/retailers/[retailerId]": ADMIN,
  "/api/retail/retailers/[retailerId]/archive": ADMIN,
  "/api/retail/retailers/[retailerId]/restore": ADMIN,
  "/api/retail/retailers/[retailerId]/prices": ADMIN,
  "/api/retail/retailers/[retailerId]/prices/tools": ADMIN,
  "/api/retail/invoices": ADMIN,
  "/api/retail/invoices/preview": ADMIN,
  "/api/retail/invoices/check-order": ADMIN,
  "/api/retail/invoices/[invoiceId]": ADMIN,
  "/api/retail/invoices/[invoiceId]/delete": ADMIN,
  "/api/retail/invoices/[invoiceId]/restore": ADMIN,
  "/api/retail/invoices/[invoiceId]/pdf": ADMIN,
  "/api/retail/line-sheets": ADMIN,
  "/api/retail/line-sheets/preview": ADMIN,
  "/api/retail/line-sheets/[sheetId]": ADMIN,
  "/api/retail/line-sheets/[sheetId]/duplicate": ADMIN,
  "/api/retail/line-sheets/[sheetId]/delete": ADMIN,
  "/api/retail/line-sheets/[sheetId]/pdf": ADMIN,

  "/api/fulfillments": F("fulfillment.orders"),
  "/api/fulfillments/flagged": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/batches": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/buy-label": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/mark-fulfilled": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/packaging": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/print-label": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/rates": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/refund": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/shopify-tracking": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/unflag": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/update-address": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/void-label": F("fulfillment.orders"),
  "/api/fulfillments/[orderId]/pick": F("fulfillment.pick_list"),
  "/api/fulfillments/[orderId]/return-to-picking": F("fulfillment.pick_list", "fulfillment.orders"),
  "/api/fulfillments/warehouse": F("fulfillment.pick_list", "fulfillment.orders"),
  "/api/staging-boxes": F("fulfillment.pick_list"),
  "/api/staging-boxes/[boxId]/release": F("fulfillment.pick_list"),
  "/api/staging-boxes/[boxId]/retire": F("fulfillment.pick_list"),
  "/api/fulfillments/packaging-preview": F("fulfillment.setup"),

  "/api/sales-data/import": F("fulfillment.sales_data"),
  "/api/sales-data/import-csv": F("fulfillment.sales_data"),

  "/api/compliance/sops": F("compliance.sops"),
  "/api/compliance/sops/[id]/draft": F("compliance.sops"),
  "/api/compliance/sops/[id]/images": F("compliance.sops"),
  "/api/compliance/sops/[id]/images/upload-url": F("compliance.sops"),
  "/api/compliance/sops/[id]/publish": F("compliance.sops"),
  "/api/compliance/sops/[id]/versions": F("compliance.sops"),
  "/api/compliance/sops/[id]/versions/[versionId]/signed-url": F("compliance.sops"),
  "/api/compliance/sops/upload-url": F("compliance.sops"),
  // Rendering an SOP (images) also happens from the receiving form's SOP link.
  "/api/compliance/sops/images/signed-urls": F("compliance.sops"),
  // Formulation pages sync their formula into the product's SOP.
  "/api/compliance/sops/by-product/[productId]": F("compliance.sops", "production.formulation"),
  "/api/compliance/sops/sync-formula": F("compliance.sops", "production.formulation"),
  "/api/compliance/sops/reconcile": F("compliance.sops", "production.formulation"),

  "/api/compliance/logs/receiving": F("compliance.logs", "inventory.raw_materials"),
  "/api/compliance/logs/documents/upload-url": F("compliance.logs", "inventory.raw_materials"),
  "/api/compliance/logs/entries/[id]/documents": F("compliance.logs", "inventory.raw_materials"),
  "/api/compliance/logs/entries/[id]/documents/[fileId]/signed-url": F("compliance.logs", "inventory.raw_materials"),
};

// --- Matching -----------------------------------------------------------------
function matchPattern(pattern: string, pathname: string): number | null {
  const p = pattern.split("/").filter(Boolean);
  const s = pathname.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  let score = 0;
  for (let i = 0; i < p.length; i++) {
    if (/^\[.+\]$/.test(p[i])) continue;
    if (p[i] !== s[i]) return null;
    score += 1;
  }
  return score;
}

function resolve(rules: Record<string, Rule>, pathname: string): { pattern: string; rule: Rule } | null {
  const clean = (pathname.split("?")[0].replace(/\/+$/, "") || "/").replace(/\/{2,}/g, "/");
  let best: { pattern: string; rule: Rule; score: number } | null = null;
  for (const [pattern, rule] of Object.entries(rules)) {
    const score = matchPattern(pattern, clean);
    if (score === null) continue;
    if (!best || score > best.score) best = { pattern, rule, score };
  }
  return best ? { pattern: best.pattern, rule: best.rule } : null;
}

/** The rule for a page path. Unregistered paths are Admin only. */
export function pageRule(pathname: string): Rule {
  return resolve(PAGE_RULES, pathname)?.rule ?? ADMIN;
}
/** The rule for an API path. Unregistered paths are Admin only. */
export function apiRule(pathname: string): Rule {
  return resolve(API_RULES, pathname)?.rule ?? ADMIN;
}

export type AccessSummary = { active: boolean; isAdmin: boolean; features: ReadonlySet<string> };

/** Decides a rule for an access summary (already computed from the database). */
export function allows(rule: Rule, access: AccessSummary | null, signedIn: boolean): boolean {
  switch (rule.kind) {
    case "public":
      return true;
    case "signed_in":
      return signedIn;
    case "system":
      return true; // the route checks its own secret
    case "always":
      return !!access?.active;
    case "admin":
      return !!access?.active && access.isAdmin;
    case "feature":
      return !!access?.active && (access.isAdmin || rule.features.some((f) => access.features.has(f)));
  }
}

export function hasFeature(access: AccessSummary | null, key: FeatureKey): boolean {
  return !!access?.active && (access.isAdmin || access.features.has(key));
}
export function hasAnyFeature(access: AccessSummary | null, keys: readonly FeatureKey[]): boolean {
  return keys.some((k) => hasFeature(access, k));
}

// --- Sidebar ------------------------------------------------------------------
export type NavLeaf = { href: string; label: string };
export type NavCategory = { title: string; items: NavLeaf[] };
export type NavSection = { title: string; items?: NavLeaf[]; categories?: NavCategory[] };

type NavItemDef = NavLeaf & { feature?: FeatureKey; admin?: boolean };

/** Top items. Dashboard, Schedule and Alerts are for everyone; Notification Settings is Admin only. */
export const TOP_ITEMS: NavItemDef[] = [
  { href: "/", label: "Dashboard" },
  { href: "/schedule", label: "Schedule" },
  { href: "/notifications", label: "Alerts" },
  { href: "/settings/notifications", label: "Notification Settings", admin: true },
];

/** Admin only, directly above the BotanIQals section. */
export const EMPLOYEES_ITEM: NavItemDef = { href: "/employees", label: "Employees", admin: true };

/** Catalog group keys (stable ids for the sidebar groups; the title is what people see). */
export type NavGroupKey = "production" | "inventory" | "fulfillment" | "compliance" | "marketing_sales";

const SECTION_DEFS: Array<{ title: string; categories?: Array<{ key?: NavGroupKey; title: string; items: NavItemDef[] }>; items?: NavItemDef[] }> = [
  {
    title: "BotanIQals",
    categories: [
      {
        key: "production",
        title: "Production",
        items: [
          { href: "/calibration", label: "Freeze Dryer Calibration", feature: "production.calibration" },
          { href: "/products", label: "Products & BOM", feature: "production.products_bom" },
          { href: "/formulation", label: "Formulation", feature: "production.formulation" },
          { href: "/cycles", label: "Production Cycles & Planner", feature: "production.planner" },
          { href: "/production-optimization", label: "Production Optimization", feature: "production.optimization" },
        ],
      },
      {
        key: "inventory",
        title: "Inventory",
        items: [
          { href: "/finished-products-inventory", label: "Finished Products Inventory", feature: "inventory.finished_products" },
          { href: "/inventory", label: "Raw Materials", feature: "inventory.raw_materials" },
          { href: "/inventory/procurement", label: "Procurement", feature: "inventory.purchase_orders" },
        ],
      },
      {
        key: "fulfillment",
        title: "Fulfillment",
        items: [
          { href: "/fulfillments", label: "Fulfillments", feature: "fulfillment.orders" },
          { href: "/fulfillments/pick-list", label: "Pick List", feature: "fulfillment.pick_list" },
        ],
      },
      {
        key: "compliance",
        title: "Compliance",
        items: [
          { href: "/compliance/sops", label: "SOPs", feature: "compliance.sops" },
          { href: "/compliance/logs", label: "Logs", feature: "compliance.logs" },
          { href: "/compliance/coas", label: "COAs", feature: "compliance.coas" },
        ],
      },
      {
        // The last BotanIQals group. Sales Data, Sales Stats and Retail moved
        // here from Fulfillment; their URLs, features and rules are unchanged.
        key: "marketing_sales",
        title: "Marketing & Sales",
        items: [
          { href: "/growth/launches", label: "Launch Pipeline", feature: "growth.launches" },
          { href: "/growth/prospecting", label: "Prospecting", feature: "growth.prospecting" },
          { href: "/growth/marketing", label: "Marketing Hub", feature: "growth.marketing" },
          // Admin only, never assignable.
          { href: "/fulfillment/retail", label: "Retail", admin: true },
          { href: "/sales-data", label: "Sales Data", feature: "fulfillment.sales_data" },
          { href: "/stats", label: "Sales Stats", feature: "fulfillment.stats" },
        ],
      },
    ],
  },
  {
    title: "MiniLeaf",
    items: [
      { href: "/microgreens", label: "Microgreens Guide", feature: "minileaf.guide" },
      { href: "/yield", label: "Yield Logging", feature: "minileaf.yield_logging" },
      { href: "/microgreen-optimization", label: "Microgreens Optimization", feature: "minileaf.optimization" },
    ],
  },
];

const strip = ({ href, label }: NavItemDef): NavLeaf => ({ href, label });
const itemAllowed = (it: NavItemDef, access: AccessSummary | null) =>
  it.admin ? !!access?.active && access.isAdmin : it.feature ? hasFeature(access, it.feature) : !!access?.active;

/** The full sidebar (what an Admin sees), without filtering. */
export const ALL_SECTIONS: NavSection[] = SECTION_DEFS.map((s) => ({
  title: s.title,
  ...(s.categories ? { categories: s.categories.map((c) => ({ title: c.title, items: c.items.map(strip) })) } : {}),
  ...(s.items ? { items: s.items.map(strip) } : {}),
}));

export type Sidebar = { top: NavLeaf[]; employees: NavLeaf | null; sections: NavSection[] };

/**
 * The sidebar for an access summary. A dropdown group shows only if one of its
 * items is allowed; the BotanIQals header only if one of its groups shows; the
 * MiniLeaf section only if one MiniLeaf item is allowed.
 */
export function buildSidebar(access: AccessSummary | null): Sidebar {
  const top = TOP_ITEMS.filter((it) => itemAllowed(it, access)).map(strip);
  const employees = itemAllowed(EMPLOYEES_ITEM, access) ? strip(EMPLOYEES_ITEM) : null;
  const sections: NavSection[] = [];
  for (const s of SECTION_DEFS) {
    if (s.categories) {
      const categories = s.categories
        .map((c) => ({ title: c.title, items: c.items.filter((it) => itemAllowed(it, access)).map(strip) }))
        .filter((c) => c.items.length > 0);
      if (categories.length > 0) sections.push({ title: s.title, categories });
    } else if (s.items) {
      const items = s.items.filter((it) => itemAllowed(it, access)).map(strip);
      if (items.length > 0) sections.push({ title: s.title, items });
    }
  }
  return { top, employees, sections };
}

/**
 * Pages that keep a sidebar item highlighted besides its own href. Purchase
 * Orders is opened from Procurement, so Procurement stays highlighted there.
 */
const ACTIVE_PREFIXES: Record<string, readonly string[]> = {
  "/inventory/procurement": ["/inventory/procurement/", "/inventory/purchase-orders"],
  "/fulfillment/retail": ["/fulfillment/retail/"],
  "/growth/launches": ["/growth/launches/"],
  "/growth/prospecting": ["/growth/prospecting/"],
  "/growth/marketing": ["/growth/marketing/"],
};

/** Whether a sidebar item is the current page. */
export function navItemActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (pathname === href) return true;
  return (ACTIVE_PREFIXES[href] ?? []).some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/** Sidebar labels a set of features would show (role editor preview). */
export function previewSidebarLabels(features: Iterable<string>): string[] {
  const sb = buildSidebar({ active: true, isAdmin: false, features: new Set(features) });
  const out: string[] = [];
  for (const s of sb.sections) {
    for (const c of s.categories ?? []) for (const it of c.items) out.push(`${s.title} › ${c.title} › ${it.label}`);
    for (const it of s.items ?? []) out.push(`${s.title} › ${it.label}`);
  }
  return out;
}
