-- Migration 2 of 2: Employee accounts, admin-defined roles, feature-level access
-- Database policies.
--
-- Run this only after migration 1 (employee_accounts_roles.sql) and after
-- bootstrap_admins() has given at least one signed-in person the Admin role.
-- The first statement stops the migration if there is no active Admin yet,
-- so nobody can be locked out of the app.
--
-- What it does:
--   1) Every table the browser uses gets new policies from the matrix below.
--      All existing policies on those tables are dropped first, whatever they
--      were called (open "authenticated" policies and owner-only
--      auth.uid() = user_id policies alike). Production data is shared:
--      anyone with the feature sees and edits every row; user_id stays as
--      "created by".
--   2) Any other public table that still has a policy keeps the same
--      commands but now requires an active employee account
--      (is_active_employee()). Each one is listed with RAISE NOTICE.
--   3) shopify_auth_tokens and inventory_production_events: RLS on, no
--      browser policies (server code only).
--   4) The private Storage buckets the browser touches get feature-based
--      policies.
--
-- Server routes use the service role, which is not limited by RLS; they are
-- guarded in code by guardApi(). Safe to run more than once.
--
-- Matrix (also in src/lib/access/tableMatrix.ts; a test keeps them equal).
-- Every rule also requires an active employee account. Admins hold every
-- feature. "none" means the browser may not do it (server code only).
--
--   access_audit_log                read: Admin | insert: none | update: none | delete: none
--   batch_compliance_reviews        read: production.planner | insert: production.planner | update: none | delete: none
--   bom_lines                       read: production.planner, production.products_bom, production.formulation, production.optimization, inventory.raw_materials, compliance.sops | insert: production.products_bom, production.formulation | update: production.products_bom, production.formulation | delete: production.products_bom, production.formulation, inventory.raw_materials
--   botaniqals_production_batches   read: production.planner | insert: none | update: none | delete: none
--   calibration                     read: production.planner, production.calibration | insert: production.calibration | update: production.calibration | delete: production.calibration
--   company_profiles                read: inventory.purchase_orders | insert: inventory.purchase_orders | update: inventory.purchase_orders | delete: none
--   cycle_completion_snapshots      read: production.planner | insert: none | update: none | delete: none
--   deleted_mapping_components      read: production.products_bom | insert: production.products_bom | update: production.products_bom | delete: production.products_bom
--   demand_calibration_overrides    read: production.optimization | insert: production.optimization | update: production.optimization | delete: production.optimization
--   demand_calibration_settings     read: production.optimization | insert: production.optimization | update: production.optimization | delete: production.optimization
--   employee_accounts               read: Admin | insert: none | update: none | delete: none
--   employee_roles                  read: Admin | insert: none | update: none | delete: none
--   employees                       read: any active employee | insert: Admin | update: Admin | delete: Admin
--   finished_goods                  read: Admin | insert: Admin | update: Admin | delete: Admin
--   finished_goods_batches          read: inventory.finished_products, production.planner, fulfillment.orders, fulfillment.pick_list, production.optimization | insert: none | update: none | delete: none
--   finished_products_inventory     read: inventory.finished_products, production.optimization, production.planner, fulfillment.orders, fulfillment.pick_list | insert: inventory.finished_products | update: inventory.finished_products | delete: none
--   formulation_lines               read: production.formulation, production.products_bom, compliance.sops | insert: production.formulation | update: production.formulation | delete: production.formulation
--   formulation_products            read: production.formulation, production.products_bom, compliance.sops | insert: production.formulation | update: production.formulation, production.products_bom | delete: production.formulation
--   formulations                    read: production.formulation, production.products_bom, compliance.sops | insert: production.formulation | update: production.formulation | delete: production.formulation
--   freeze_dryer_machine_settings   read: production.calibration, production.planner | insert: production.calibration | update: production.calibration | delete: production.calibration
--   freeze_dryer_profiles           read: production.calibration, production.planner, production.products_bom | insert: production.calibration | update: production.calibration | delete: production.calibration
--   fulfillment_log                 read: fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   fulfillment_orders_cache        read: fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   fulfillment_orders_cache_state  read: fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   fulfillments_settings           read: fulfillment.setup, fulfillment.orders, fulfillment.pick_list | insert: fulfillment.setup | update: fulfillment.setup | delete: fulfillment.setup
--   inventory_adjustments           read: inventory.raw_materials, production.planner | insert: inventory.raw_materials, production.planner | update: inventory.raw_materials, production.planner | delete: inventory.raw_materials, production.planner
--   inventory_items                 read: inventory.raw_materials, production.planner, production.products_bom, production.formulation, production.optimization, compliance.logs, compliance.sops | insert: inventory.raw_materials, production.formulation, production.planner | update: inventory.raw_materials, production.formulation, production.planner | delete: inventory.raw_materials, production.formulation, production.planner
--   inventory_transactions          read: inventory.finished_products | insert: none | update: none | delete: none
--   log_entries                     read: compliance.logs, inventory.raw_materials, compliance.coas, production.planner | insert: compliance.logs, inventory.raw_materials | update: none | delete: none
--   log_entry_files                 read: compliance.logs, inventory.raw_materials, compliance.coas, production.planner | insert: compliance.logs, inventory.raw_materials | update: none | delete: none
--   log_entry_reviews               read: compliance.logs, inventory.raw_materials, compliance.coas, production.planner | insert: compliance.logs, inventory.raw_materials | update: none | delete: none
--   log_fields                      read: compliance.logs, inventory.raw_materials, compliance.coas, production.planner | insert: Admin | update: Admin | delete: Admin
--   log_types                       read: compliance.logs, inventory.raw_materials, compliance.coas, production.planner | insert: Admin | update: Admin | delete: Admin
--   markets                         read: fulfillment.stats | insert: Admin | update: Admin | delete: Admin
--   microgreen_mix_components       read: minileaf.optimization | insert: minileaf.optimization | update: minileaf.optimization | delete: minileaf.optimization
--   microgreen_mixes                read: minileaf.optimization | insert: minileaf.optimization | update: minileaf.optimization | delete: minileaf.optimization
--   microgreens                     read: minileaf.guide, minileaf.optimization, minileaf.yield_logging, production.planner, production.calibration, production.products_bom | insert: minileaf.guide, minileaf.yield_logging | update: minileaf.guide, minileaf.yield_logging | delete: minileaf.guide, minileaf.yield_logging
--   notification_config             read: Admin | insert: Admin | update: Admin | delete: Admin
--   notifications                   read: own rows | insert: none | update: own rows | delete: none
--   optimization_runs               read: production.optimization | insert: production.optimization | update: production.optimization | delete: production.optimization
--   order_address_verification      read: fulfillment.orders | insert: none | update: none | delete: none
--   order_batch_picks               read: inventory.finished_products, fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   order_events                    read: fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   order_line_items                read: production.optimization, fulfillment.sales_data, fulfillment.stats | insert: fulfillment.sales_data | update: fulfillment.sales_data | delete: fulfillment.sales_data
--   order_packaging                 read: fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   order_status                    read: fulfillment.orders, fulfillment.pick_list | insert: fulfillment.orders | update: fulfillment.orders | delete: none
--   orders                          read: production.optimization, fulfillment.sales_data, fulfillment.stats | insert: fulfillment.sales_data | update: fulfillment.sales_data | delete: fulfillment.sales_data
--   package_presets                 read: fulfillment.orders, fulfillment.pick_list, fulfillment.setup | insert: fulfillment.setup | update: fulfillment.setup | delete: fulfillment.setup
--   po_counters                     read: inventory.purchase_orders | insert: none | update: none | delete: none
--   po_lines                        read: inventory.purchase_orders | insert: inventory.purchase_orders | update: none | delete: inventory.purchase_orders
--   product_packaging_rules         read: fulfillment.orders, fulfillment.pick_list, fulfillment.setup | insert: fulfillment.setup | update: fulfillment.setup | delete: fulfillment.setup
--   product_variants                read: production.products_bom, production.planner, production.optimization, fulfillment.sales_data | insert: production.products_bom | update: production.products_bom | delete: production.products_bom
--   production_cycles               read: production.planner, compliance.logs, production.products_bom | insert: production.planner | update: production.planner | delete: production.planner
--   production_plan_lines           read: production.planner | insert: production.planner | update: production.planner | delete: production.planner
--   production_targets              read: production.planner, production.products_bom | insert: production.planner | update: production.planner | delete: production.planner
--   products                        read: any feature | insert: production.products_bom, production.formulation | update: production.products_bom, production.formulation | delete: production.products_bom
--   purchase_orders                 read: inventory.purchase_orders | insert: inventory.purchase_orders | update: inventory.purchase_orders | delete: none
--   receiving_details               read: inventory.raw_materials, compliance.logs, production.planner, compliance.coas | insert: inventory.raw_materials, compliance.logs | update: none | delete: none
--   role_features                   read: Admin | insert: none | update: none | delete: none
--   roles                           read: Admin | insert: none | update: none | delete: none
--   sales_import_state              read: fulfillment.sales_data | insert: fulfillment.sales_data | update: fulfillment.sales_data | delete: fulfillment.sales_data
--   schedule_events                 read: production.planner | insert: production.planner | update: production.planner | delete: production.planner
--   shipping_method_map             read: fulfillment.setup | insert: fulfillment.setup | update: fulfillment.setup | delete: fulfillment.setup
--   sop_formula_refs                read: compliance.sops, production.products_bom, production.formulation | insert: none | update: none | delete: none
--   sop_images                      read: compliance.sops | insert: none | update: none | delete: none
--   sop_versions                    read: compliance.sops | insert: none | update: none | delete: none
--   sops                            read: compliance.sops, compliance.logs, production.products_bom, production.formulation | insert: none | update: compliance.sops | delete: none
--   staging_box_assignments         read: fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   staging_boxes                   read: fulfillment.orders, fulfillment.pick_list | insert: none | update: none | delete: none
--   stats_settings                  read: fulfillment.stats | insert: fulfillment.stats | update: fulfillment.stats | delete: fulfillment.stats
--   test_batches                    read: production.formulation | insert: production.formulation | update: production.formulation | delete: production.formulation
--   unmapped_line_items             read: fulfillment.sales_data | insert: fulfillment.sales_data, production.products_bom | update: fulfillment.sales_data, production.products_bom | delete: fulfillment.sales_data, production.products_bom
--   variant_component_map           read: fulfillment.orders, fulfillment.pick_list, production.optimization, production.products_bom, fulfillment.sales_data, fulfillment.stats | insert: fulfillment.sales_data, production.products_bom | update: fulfillment.sales_data, production.products_bom | delete: fulfillment.sales_data, production.products_bom
--   yield_entries                   read: minileaf.yield_logging, minileaf.optimization, production.planner | insert: minileaf.yield_logging, minileaf.optimization | update: none | delete: none
--
-- Storage buckets: company-assets -> inventory.purchase_orders;
--   log-entry-docs -> compliance.logs, inventory.raw_materials;
--   sops -> compliance.sops. (sop-images is only reached through
--   server-signed URLs and keeps no browser policy.)

-- 0) Guard: stop unless an active, linked account holds the Admin role -------
DO $$
BEGIN
  IF to_regprocedure('public.access_active_admin_count(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Run migration 1 (employee_accounts_roles.sql) first.'
      USING HINT = 'migration_1_missing';
  END IF;
  IF public.access_active_admin_count(NULL) < 1 THEN
    RAISE EXCEPTION 'No active Admin account yet. Run bootstrap_admins() and check that at least one Admin is active before running this migration.'
      USING HINT = 'no_active_admin';
  END IF;
END $$;

-- Builds the policy expression for one rule from the matrix.
CREATE OR REPLACE FUNCTION pg_temp.access_policy_expr(who jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[];
BEGIN
  IF who IS NULL OR who = 'null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(who) = 'string' THEN
    CASE who #>> '{}'
      WHEN 'active' THEN RETURN 'public.is_active_employee()';
      WHEN 'admin' THEN RETURN 'public.is_active_employee() AND public.is_admin()';
      WHEN 'own' THEN RETURN 'public.is_active_employee() AND user_id = auth.uid()';
      ELSE RAISE EXCEPTION 'Unknown rule %', who;
    END CASE;
  END IF;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_array_elements_text(who) AS k;
  IF keys IS NULL OR array_length(keys, 1) IS NULL THEN RETURN NULL; END IF;
  RETURN format('public.is_active_employee() AND public.has_any_feature(%L::text[])', keys::text);
END $$;

-- 1) Tables in the matrix ----------------------------------------------------
DO $do$
DECLARE
  matrix jsonb := $table_matrix$
{
  "access_audit_log": {"read":"admin"},
  "batch_compliance_reviews": {"read":["production.planner"],"insert":["production.planner"]},
  "bom_lines": {"read":["production.planner","production.products_bom","production.formulation","production.optimization","inventory.raw_materials","compliance.sops"],"insert":["production.products_bom","production.formulation"],"update":["production.products_bom","production.formulation"],"delete":["production.products_bom","production.formulation","inventory.raw_materials"]},
  "botaniqals_production_batches": {"read":["production.planner"]},
  "calibration": {"read":["production.planner","production.calibration"],"insert":["production.calibration"],"update":["production.calibration"],"delete":["production.calibration"]},
  "company_profiles": {"read":["inventory.purchase_orders"],"insert":["inventory.purchase_orders"],"update":["inventory.purchase_orders"]},
  "cycle_completion_snapshots": {"read":["production.planner"]},
  "deleted_mapping_components": {"read":["production.products_bom"],"insert":["production.products_bom"],"update":["production.products_bom"],"delete":["production.products_bom"]},
  "demand_calibration_overrides": {"read":["production.optimization"],"insert":["production.optimization"],"update":["production.optimization"],"delete":["production.optimization"]},
  "demand_calibration_settings": {"read":["production.optimization"],"insert":["production.optimization"],"update":["production.optimization"],"delete":["production.optimization"]},
  "employee_accounts": {"read":"admin"},
  "employee_roles": {"read":"admin"},
  "employees": {"read":"active","insert":"admin","update":"admin","delete":"admin"},
  "finished_goods": {"read":"admin","insert":"admin","update":"admin","delete":"admin"},
  "finished_goods_batches": {"read":["inventory.finished_products","production.planner","fulfillment.orders","fulfillment.pick_list","production.optimization"]},
  "finished_products_inventory": {"read":["inventory.finished_products","production.optimization","production.planner","fulfillment.orders","fulfillment.pick_list"],"insert":["inventory.finished_products"],"update":["inventory.finished_products"]},
  "formulation_lines": {"read":["production.formulation","production.products_bom","compliance.sops"],"insert":["production.formulation"],"update":["production.formulation"],"delete":["production.formulation"]},
  "formulation_products": {"read":["production.formulation","production.products_bom","compliance.sops"],"insert":["production.formulation"],"update":["production.formulation","production.products_bom"],"delete":["production.formulation"]},
  "formulations": {"read":["production.formulation","production.products_bom","compliance.sops"],"insert":["production.formulation"],"update":["production.formulation"],"delete":["production.formulation"]},
  "freeze_dryer_machine_settings": {"read":["production.calibration","production.planner"],"insert":["production.calibration"],"update":["production.calibration"],"delete":["production.calibration"]},
  "freeze_dryer_profiles": {"read":["production.calibration","production.planner","production.products_bom"],"insert":["production.calibration"],"update":["production.calibration"],"delete":["production.calibration"]},
  "fulfillment_log": {"read":["fulfillment.orders","fulfillment.pick_list"]},
  "fulfillment_orders_cache": {"read":["fulfillment.orders","fulfillment.pick_list"]},
  "fulfillment_orders_cache_state": {"read":["fulfillment.orders","fulfillment.pick_list"]},
  "fulfillments_settings": {"read":["fulfillment.setup","fulfillment.orders","fulfillment.pick_list"],"insert":["fulfillment.setup"],"update":["fulfillment.setup"],"delete":["fulfillment.setup"]},
  "inventory_adjustments": {"read":["inventory.raw_materials","production.planner"],"insert":["inventory.raw_materials","production.planner"],"update":["inventory.raw_materials","production.planner"],"delete":["inventory.raw_materials","production.planner"]},
  "inventory_items": {"read":["inventory.raw_materials","production.planner","production.products_bom","production.formulation","production.optimization","compliance.logs","compliance.sops"],"insert":["inventory.raw_materials","production.formulation","production.planner"],"update":["inventory.raw_materials","production.formulation","production.planner"],"delete":["inventory.raw_materials","production.formulation","production.planner"]},
  "inventory_transactions": {"read":["inventory.finished_products"]},
  "log_entries": {"read":["compliance.logs","inventory.raw_materials","compliance.coas","production.planner"],"insert":["compliance.logs","inventory.raw_materials"]},
  "log_entry_files": {"read":["compliance.logs","inventory.raw_materials","compliance.coas","production.planner"],"insert":["compliance.logs","inventory.raw_materials"]},
  "log_entry_reviews": {"read":["compliance.logs","inventory.raw_materials","compliance.coas","production.planner"],"insert":["compliance.logs","inventory.raw_materials"]},
  "log_fields": {"read":["compliance.logs","inventory.raw_materials","compliance.coas","production.planner"],"insert":"admin","update":"admin","delete":"admin"},
  "log_types": {"read":["compliance.logs","inventory.raw_materials","compliance.coas","production.planner"],"insert":"admin","update":"admin","delete":"admin"},
  "markets": {"read":["fulfillment.stats"],"insert":"admin","update":"admin","delete":"admin"},
  "microgreen_mix_components": {"read":["minileaf.optimization"],"insert":["minileaf.optimization"],"update":["minileaf.optimization"],"delete":["minileaf.optimization"]},
  "microgreen_mixes": {"read":["minileaf.optimization"],"insert":["minileaf.optimization"],"update":["minileaf.optimization"],"delete":["minileaf.optimization"]},
  "microgreens": {"read":["minileaf.guide","minileaf.optimization","minileaf.yield_logging","production.planner","production.calibration","production.products_bom"],"insert":["minileaf.guide","minileaf.yield_logging"],"update":["minileaf.guide","minileaf.yield_logging"],"delete":["minileaf.guide","minileaf.yield_logging"]},
  "notification_config": {"read":"admin","insert":"admin","update":"admin","delete":"admin"},
  "notifications": {"read":"own","update":"own"},
  "optimization_runs": {"read":["production.optimization"],"insert":["production.optimization"],"update":["production.optimization"],"delete":["production.optimization"]},
  "order_address_verification": {"read":["fulfillment.orders"]},
  "order_batch_picks": {"read":["inventory.finished_products","fulfillment.orders","fulfillment.pick_list"]},
  "order_events": {"read":["fulfillment.orders","fulfillment.pick_list"]},
  "order_line_items": {"read":["production.optimization","fulfillment.sales_data","fulfillment.stats"],"insert":["fulfillment.sales_data"],"update":["fulfillment.sales_data"],"delete":["fulfillment.sales_data"]},
  "order_packaging": {"read":["fulfillment.orders","fulfillment.pick_list"]},
  "order_status": {"read":["fulfillment.orders","fulfillment.pick_list"],"insert":["fulfillment.orders"],"update":["fulfillment.orders"]},
  "orders": {"read":["production.optimization","fulfillment.sales_data","fulfillment.stats"],"insert":["fulfillment.sales_data"],"update":["fulfillment.sales_data"],"delete":["fulfillment.sales_data"]},
  "package_presets": {"read":["fulfillment.orders","fulfillment.pick_list","fulfillment.setup"],"insert":["fulfillment.setup"],"update":["fulfillment.setup"],"delete":["fulfillment.setup"]},
  "po_counters": {"read":["inventory.purchase_orders"]},
  "po_lines": {"read":["inventory.purchase_orders"],"insert":["inventory.purchase_orders"],"delete":["inventory.purchase_orders"]},
  "product_packaging_rules": {"read":["fulfillment.orders","fulfillment.pick_list","fulfillment.setup"],"insert":["fulfillment.setup"],"update":["fulfillment.setup"],"delete":["fulfillment.setup"]},
  "product_variants": {"read":["production.products_bom","production.planner","production.optimization","fulfillment.sales_data"],"insert":["production.products_bom"],"update":["production.products_bom"],"delete":["production.products_bom"]},
  "production_cycles": {"read":["production.planner","compliance.logs","production.products_bom"],"insert":["production.planner"],"update":["production.planner"],"delete":["production.planner"]},
  "production_plan_lines": {"read":["production.planner"],"insert":["production.planner"],"update":["production.planner"],"delete":["production.planner"]},
  "production_targets": {"read":["production.planner","production.products_bom"],"insert":["production.planner"],"update":["production.planner"],"delete":["production.planner"]},
  "products": {"read":["production.calibration","production.products_bom","production.planner","production.optimization","production.formulation","inventory.finished_products","inventory.raw_materials","inventory.purchase_orders","fulfillment.orders","fulfillment.pick_list","fulfillment.sales_data","fulfillment.stats","fulfillment.setup","compliance.sops","compliance.logs","compliance.coas","minileaf.guide","minileaf.optimization","minileaf.yield_logging"],"insert":["production.products_bom","production.formulation"],"update":["production.products_bom","production.formulation"],"delete":["production.products_bom"]},
  "purchase_orders": {"read":["inventory.purchase_orders"],"insert":["inventory.purchase_orders"],"update":["inventory.purchase_orders"]},
  "receiving_details": {"read":["inventory.raw_materials","compliance.logs","production.planner","compliance.coas"],"insert":["inventory.raw_materials","compliance.logs"]},
  "role_features": {"read":"admin"},
  "roles": {"read":"admin"},
  "sales_import_state": {"read":["fulfillment.sales_data"],"insert":["fulfillment.sales_data"],"update":["fulfillment.sales_data"],"delete":["fulfillment.sales_data"]},
  "schedule_events": {"read":["production.planner"],"insert":["production.planner"],"update":["production.planner"],"delete":["production.planner"]},
  "shipping_method_map": {"read":["fulfillment.setup"],"insert":["fulfillment.setup"],"update":["fulfillment.setup"],"delete":["fulfillment.setup"]},
  "sop_formula_refs": {"read":["compliance.sops","production.products_bom","production.formulation"]},
  "sop_images": {"read":["compliance.sops"]},
  "sop_versions": {"read":["compliance.sops"]},
  "sops": {"read":["compliance.sops","compliance.logs","production.products_bom","production.formulation"],"update":["compliance.sops"]},
  "staging_box_assignments": {"read":["fulfillment.orders","fulfillment.pick_list"]},
  "staging_boxes": {"read":["fulfillment.orders","fulfillment.pick_list"]},
  "stats_settings": {"read":["fulfillment.stats"],"insert":["fulfillment.stats"],"update":["fulfillment.stats"],"delete":["fulfillment.stats"]},
  "test_batches": {"read":["production.formulation"],"insert":["production.formulation"],"update":["production.formulation"],"delete":["production.formulation"]},
  "unmapped_line_items": {"read":["fulfillment.sales_data"],"insert":["fulfillment.sales_data","production.products_bom"],"update":["fulfillment.sales_data","production.products_bom"],"delete":["fulfillment.sales_data","production.products_bom"]},
  "variant_component_map": {"read":["fulfillment.orders","fulfillment.pick_list","production.optimization","production.products_bom","fulfillment.sales_data","fulfillment.stats"],"insert":["fulfillment.sales_data","production.products_bom"],"update":["fulfillment.sales_data","production.products_bom"],"delete":["fulfillment.sales_data","production.products_bom"]},
  "yield_entries": {"read":["minileaf.yield_logging","minileaf.optimization","production.planner"],"insert":["minileaf.yield_logging","minileaf.optimization"]}
}
$table_matrix$::jsonb;
  t text;
  spec jsonb;
  pol record;
  e text;
BEGIN
  FOR t, spec IN SELECT key, value FROM jsonb_each(matrix) ORDER BY key LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'Skipped % (table not found)', t;
      CONTINUE;
    END IF;
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    e := pg_temp.access_policy_expr(spec -> 'read');
    IF e IS NOT NULL THEN
      EXECUTE format('CREATE POLICY access_select ON public.%I FOR SELECT TO authenticated USING (%s)', t, e);
    END IF;
    e := pg_temp.access_policy_expr(spec -> 'insert');
    IF e IS NOT NULL THEN
      EXECUTE format('CREATE POLICY access_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', t, e);
    END IF;
    e := pg_temp.access_policy_expr(spec -> 'update');
    IF e IS NOT NULL THEN
      EXECUTE format('CREATE POLICY access_update ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', t, e, e);
    END IF;
    e := pg_temp.access_policy_expr(spec -> 'delete');
    IF e IS NOT NULL THEN
      EXECUTE format('CREATE POLICY access_delete ON public.%I FOR DELETE TO authenticated USING (%s)', t, e);
    END IF;
  END LOOP;

  -- 2) Other public tables that still have policies: same commands, but an
  --    active employee account is now required. Restrictive policies only
  --    narrow access and are left as they are.
  FOR pol IN
    SELECT p.tablename, p.policyname, p.cmd
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.permissive = 'PERMISSIVE'
      AND NOT (matrix ? p.tablename)
      AND p.tablename NOT IN ('shopify_auth_tokens', 'inventory_production_events')
    ORDER BY p.tablename, p.policyname
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, pol.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR %s TO authenticated %s',
      pol.policyname, pol.tablename, pol.cmd,
      CASE pol.cmd
        WHEN 'SELECT' THEN 'USING (public.is_active_employee())'
        WHEN 'DELETE' THEN 'USING (public.is_active_employee())'
        WHEN 'INSERT' THEN 'WITH CHECK (public.is_active_employee())'
        ELSE 'USING (public.is_active_employee()) WITH CHECK (public.is_active_employee())'
      END);
    RAISE NOTICE 'Active employees only (no feature mapping): %.%', pol.tablename, pol.policyname;
  END LOOP;
END $do$;

-- 3) Server-only tables: RLS on, no browser policies -------------------------
DO $$
DECLARE t text; pol record;
BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_auth_tokens', 'inventory_production_events'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 4) Storage buckets ---------------------------------------------------------
DO $do$
DECLARE
  buckets jsonb := $bucket_matrix${"company-assets":["inventory.purchase_orders"],"log-entry-docs":["compliance.logs","inventory.raw_materials"],"sops":["compliance.sops"]}$bucket_matrix$::jsonb;
  b text;
  keys jsonb;
  pol record;
  e text;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN RETURN; END IF;
  FOR b, keys IN SELECT key, value FROM jsonb_each(buckets) ORDER BY key LOOP
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND position(quote_literal(b) IN coalesce(qual, '') || ' ' || coalesce(with_check, '')) > 0
    LOOP
      EXECUTE format('DROP POLICY %I ON storage.objects', pol.policyname);
    END LOOP;
    e := pg_temp.access_policy_expr(keys);
    EXECUTE format(
      'CREATE POLICY %I ON storage.objects FOR ALL TO authenticated USING (bucket_id = %L AND %s) WITH CHECK (bucket_id = %L AND %s)',
      'access_' || replace(b, '-', '_') || '_objects', b, e, b, e);
  END LOOP;
END $do$;

DROP FUNCTION IF EXISTS pg_temp.access_policy_expr(jsonb);

NOTIFY pgrst, 'reload schema';
