/**
 * Who the database lets read and write each table from the browser.
 *
 * This is the source of truth for migration 2
 * (supabase-migrations/employee_access_policies.sql). The migration carries
 * the same matrix as JSON between the TABLE_MATRIX markers, and
 * tests/unit/tableMatrix.test.ts fails if the two ever differ.
 *
 * Server code uses the service role and is not limited by these rules; it is
 * guarded by guardApi() instead. "Browser write: none" means the app only
 * writes that table from server routes.
 *
 * Every rule also requires an active employee account (is_active_employee()).
 * A feature list means "holds any of these features"; Admins hold every
 * feature. Production data is shared: anyone with the feature sees and edits
 * every row, and user_id only records who created a row.
 */
import type { FeatureKey } from "./catalog";

export type Who = readonly FeatureKey[] | "active" | "admin" | "own";

export type TablePolicy = {
  read: Who;
  insert?: Who;
  update?: Who;
  delete?: Who;
};

const CAL = "production.calibration";
const BOM = "production.products_bom";
const PLAN = "production.planner";
const OPT = "production.optimization";
const FORM = "production.formulation";
const FG = "inventory.finished_products";
const RAW = "inventory.raw_materials";
const PO = "inventory.purchase_orders";
const ORD = "fulfillment.orders";
const PICK = "fulfillment.pick_list";
const SALES = "fulfillment.sales_data";
const STATS = "fulfillment.stats";
const SETUP = "fulfillment.setup";
const SOP = "compliance.sops";
const LOGS = "compliance.logs";
const COA = "compliance.coas";
const MG = "minileaf.guide";
const MOPT = "minileaf.optimization";
const YIELD = "minileaf.yield_logging";

const ALL_FEATURES: FeatureKey[] = [
  CAL, BOM, PLAN, OPT, FORM, FG, RAW, PO, ORD, PICK, SALES, STATS, SETUP, SOP, LOGS, COA, MG, MOPT, YIELD,
];

const crud = (who: Who) => ({ insert: who, update: who, delete: who });

export const TABLE_MATRIX: Record<string, TablePolicy> = {
  batch_compliance_reviews: { read: [PLAN], insert: [PLAN] },
  bom_lines: { read: [PLAN, BOM, FORM, OPT, RAW, SOP], insert: [BOM, FORM], update: [BOM, FORM], delete: [BOM, FORM, RAW] },
  botaniqals_production_batches: { read: [PLAN] },
  calibration: { read: [PLAN, CAL], ...crud([CAL]) },
  company_profiles: { read: [PO], insert: [PO], update: [PO] },
  cycle_completion_snapshots: { read: [PLAN] },
  deleted_mapping_components: { read: [BOM], ...crud([BOM]) },
  demand_calibration_overrides: { read: [OPT], ...crud([OPT]) },
  demand_calibration_settings: { read: [OPT], ...crud([OPT]) },
  employees: { read: "active", ...crud("admin") },
  finished_goods: { read: "admin", ...crud("admin") },
  finished_goods_batches: { read: [FG, PLAN, ORD, PICK, OPT] },
  finished_products_inventory: { read: [FG, OPT, PLAN, ORD, PICK], insert: [FG], update: [FG] },
  formulations: { read: [FORM, BOM, SOP], ...crud([FORM]) },
  formulation_lines: { read: [FORM, BOM, SOP], ...crud([FORM]) },
  formulation_products: { read: [FORM, BOM, SOP], insert: [FORM], update: [FORM, BOM], delete: [FORM] },
  freeze_dryer_machine_settings: { read: [CAL, PLAN], ...crud([CAL]) },
  freeze_dryer_profiles: { read: [CAL, PLAN, BOM], ...crud([CAL]) },
  fulfillment_log: { read: [ORD, PICK] },
  fulfillment_orders_cache: { read: [ORD, PICK] },
  fulfillment_orders_cache_state: { read: [ORD, PICK] },
  fulfillments_settings: { read: [SETUP, ORD, PICK], ...crud([SETUP]) },
  inventory_adjustments: { read: [RAW, PLAN], ...crud([RAW, PLAN]) },
  inventory_items: { read: [RAW, PLAN, BOM, FORM, OPT, LOGS, SOP], ...crud([RAW, FORM, PLAN]) },
  inventory_transactions: { read: [FG] },
  log_entries: { read: [LOGS, RAW, COA, PLAN], insert: [LOGS, RAW] },
  log_entry_files: { read: [LOGS, RAW, COA, PLAN], insert: [LOGS, RAW] },
  log_entry_reviews: { read: [LOGS, RAW, COA, PLAN], insert: [LOGS, RAW] },
  log_types: { read: [LOGS, RAW, COA, PLAN], ...crud("admin") },
  log_fields: { read: [LOGS, RAW, COA, PLAN], ...crud("admin") },
  markets: { read: [STATS], ...crud("admin") },
  microgreen_mixes: { read: [MOPT], ...crud([MOPT]) },
  microgreen_mix_components: { read: [MOPT], ...crud([MOPT]) },
  microgreens: { read: [MG, MOPT, YIELD, PLAN, CAL, BOM], ...crud([MG, YIELD]) },
  notification_config: { read: "admin", ...crud("admin") },
  notifications: { read: "own", update: "own" },
  optimization_runs: { read: [OPT], ...crud([OPT]) },
  order_address_verification: { read: [ORD] },
  order_batch_picks: { read: [FG, ORD, PICK] },
  order_events: { read: [ORD, PICK] },
  order_line_items: { read: [OPT, SALES, STATS], ...crud([SALES]) },
  order_packaging: { read: [ORD, PICK] },
  order_status: { read: [ORD, PICK], insert: [ORD], update: [ORD] },
  orders: { read: [OPT, SALES, STATS], ...crud([SALES]) },
  package_presets: { read: [ORD, PICK, SETUP], ...crud([SETUP]) },
  po_counters: { read: [PO] },
  po_lines: { read: [PO], insert: [PO], delete: [PO] },
  purchase_orders: { read: [PO], insert: [PO], update: [PO] },
  product_packaging_rules: { read: [ORD, PICK, SETUP], ...crud([SETUP]) },
  product_variants: { read: [BOM, PLAN, OPT, SALES], ...crud([BOM]) },
  production_cycles: { read: [PLAN, LOGS, BOM], ...crud([PLAN]) },
  production_plan_lines: { read: [PLAN], ...crud([PLAN]) },
  production_targets: { read: [PLAN, BOM], ...crud([PLAN]) },
  products: { read: ALL_FEATURES, insert: [BOM, FORM], update: [BOM, FORM], delete: [BOM] },
  receiving_details: { read: [RAW, LOGS, PLAN, COA], insert: [RAW, LOGS] },
  sales_import_state: { read: [SALES], ...crud([SALES]) },
  schedule_events: { read: [PLAN], ...crud([PLAN]) },
  shipping_method_map: { read: [SETUP], ...crud([SETUP]) },
  sop_formula_refs: { read: [SOP, BOM, FORM] },
  sop_images: { read: [SOP] },
  sop_versions: { read: [SOP] },
  sops: { read: [SOP, LOGS, BOM, FORM], update: [SOP] },
  staging_boxes: { read: [ORD, PICK] },
  staging_box_assignments: { read: [ORD, PICK] },
  stats_settings: { read: [STATS], ...crud([STATS]) },
  test_batches: { read: [FORM], ...crud([FORM]) },
  unmapped_line_items: { read: [SALES], ...crud([SALES, BOM]) },
  variant_component_map: { read: [ORD, PICK, OPT, BOM, SALES, STATS], ...crud([SALES, BOM]) },
  yield_entries: { read: [YIELD, MOPT, PLAN], insert: [YIELD, MOPT] },

  // Permission tables: Admins can read them; only server code writes.
  employee_accounts: { read: "admin" },
  roles: { read: "admin" },
  role_features: { read: "admin" },
  employee_roles: { read: "admin" },
  access_audit_log: { read: "admin" },
};

/** Private Storage buckets the browser touches, and who may use them. */
export const BUCKET_MATRIX: Record<string, readonly FeatureKey[]> = {
  "company-assets": [PO],
  "log-entry-docs": [LOGS, RAW],
  sops: [SOP],
};

/** Tables with RLS turned on and no browser policy at all (server only). */
export const SERVER_ONLY_TABLES = ["shopify_auth_tokens", "inventory_production_events"] as const;

/** Plain-language form of a rule, for the matrix comment and docs. */
export function describeWho(who: Who | undefined): string {
  if (!who) return "none";
  if (who === "active") return "any active employee";
  if (who === "admin") return "Admin";
  if (who === "own") return "own rows";
  return who.length === ALL_FEATURES.length ? "any feature" : who.join(", ");
}
