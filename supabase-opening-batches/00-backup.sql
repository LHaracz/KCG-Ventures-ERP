-- Opening batches, step 1 of 3: backup.
-- Copies finished_products_inventory and inventory_transactions into new
-- tables named *_backup_YYYYMMDD (New York date). If a backup with today's
-- name already exists it is left as is (never overwritten).
DO $$
DECLARE
  v_suffix text := to_char(now() AT TIME ZONE 'America/New_York', 'YYYYMMDD');
BEGIN
  IF to_regclass('public.finished_products_inventory_backup_' || v_suffix) IS NULL THEN
    EXECUTE format('CREATE TABLE public.%I AS SELECT * FROM public.finished_products_inventory', 'finished_products_inventory_backup_' || v_suffix);
    RAISE NOTICE 'Created finished_products_inventory_backup_%', v_suffix;
  ELSE
    RAISE NOTICE 'finished_products_inventory_backup_% already exists; left unchanged', v_suffix;
  END IF;
  IF to_regclass('public.inventory_transactions_backup_' || v_suffix) IS NULL THEN
    EXECUTE format('CREATE TABLE public.%I AS SELECT * FROM public.inventory_transactions', 'inventory_transactions_backup_' || v_suffix);
    RAISE NOTICE 'Created inventory_transactions_backup_%', v_suffix;
  ELSE
    RAISE NOTICE 'inventory_transactions_backup_% already exists; left unchanged', v_suffix;
  END IF;
  -- Backups hold business data: keep them away from the app's roles.
  EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', 'finished_products_inventory_backup_' || v_suffix);
  EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', 'inventory_transactions_backup_' || v_suffix);
END $$;

SELECT 'finished_products_inventory_backup_' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYYMMDD') AS backup_table,
       (SELECT count(*) FROM finished_products_inventory) AS rows_in_source
UNION ALL
SELECT 'inventory_transactions_backup_' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYYMMDD'),
       (SELECT count(*) FROM inventory_transactions);
