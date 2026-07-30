-- Fix BotanIQals batch uniqueness (NULL-safe)
-- Replaces legacy cycle+user unique (blocks multi-product cycles) and the plain
-- UNIQUE (cycle, product, variant) which does not enforce uniqueness when
-- product_variant_id IS NULL (Postgres treats NULLs as distinct).
--
-- Apply manually in the Supabase SQL editor.
-- Live diagnostic (2026-07-30): 0 duplicate groups; DELETE is a no-op on current data.
-- Re-run the diagnostic SELECTs below before applying if data may have changed.

-- =============================================================================
-- 0) DIAGNOSTIC (run first; review results before enabling DELETE in section 2)
-- =============================================================================
-- Null-variant duplicate groups (cycle + product):
-- SELECT
--   production_cycle_id,
--   product_id,
--   count(*) AS row_count,
--   array_agg(id ORDER BY coalesce(completed_at, created_at) DESC) AS ids,
--   array_agg(quantity_produced ORDER BY coalesce(completed_at, created_at) DESC) AS qtys,
--   array_agg(completed_at ORDER BY coalesce(completed_at, created_at) DESC) AS completed_ats,
--   array_agg(created_at ORDER BY coalesce(completed_at, created_at) DESC) AS created_ats
-- FROM public.botaniqals_production_batches
-- WHERE product_variant_id IS NULL
-- GROUP BY production_cycle_id, product_id
-- HAVING count(*) > 1;
--
-- Non-null-variant duplicate groups (cycle + product + variant):
-- SELECT
--   production_cycle_id,
--   product_id,
--   product_variant_id,
--   count(*) AS row_count,
--   array_agg(id ORDER BY coalesce(completed_at, created_at) DESC) AS ids,
--   array_agg(quantity_produced ORDER BY coalesce(completed_at, created_at) DESC) AS qtys,
--   array_agg(completed_at ORDER BY coalesce(completed_at, created_at) DESC) AS completed_ats,
--   array_agg(created_at ORDER BY coalesce(completed_at, created_at) DESC) AS created_ats
-- FROM public.botaniqals_production_batches
-- WHERE product_variant_id IS NOT NULL
-- GROUP BY production_cycle_id, product_id, product_variant_id
-- HAVING count(*) > 1;
--
-- If either query returns rows, review quantities/timestamps before running section 2.

-- =============================================================================
-- 1) Drop legacy unique constraints
-- =============================================================================
ALTER TABLE public.botaniqals_production_batches
  DROP CONSTRAINT IF EXISTS botaniqals_batches_unique_cycle_user;

ALTER TABLE public.botaniqals_production_batches
  DROP CONSTRAINT IF EXISTS botaniqals_batches_unique_per_cycle;

-- =============================================================================
-- 2) Deduplicate (keep newest by completed_at, then created_at)
-- Only deletes extras within a duplicate group. Safe when diagnostic shows 0 groups.
-- =============================================================================
DELETE FROM public.botaniqals_production_batches b
USING public.botaniqals_production_batches newer
WHERE b.product_variant_id IS NULL
  AND newer.product_variant_id IS NULL
  AND b.production_cycle_id = newer.production_cycle_id
  AND b.product_id = newer.product_id
  AND b.id <> newer.id
  AND (
    coalesce(newer.completed_at, newer.created_at)
    > coalesce(b.completed_at, b.created_at)
    OR (
      coalesce(newer.completed_at, newer.created_at)
      = coalesce(b.completed_at, b.created_at)
      AND newer.id > b.id
    )
  );

DELETE FROM public.botaniqals_production_batches b
USING public.botaniqals_production_batches newer
WHERE b.product_variant_id IS NOT NULL
  AND newer.product_variant_id IS NOT NULL
  AND b.production_cycle_id = newer.production_cycle_id
  AND b.product_id = newer.product_id
  AND b.product_variant_id = newer.product_variant_id
  AND b.id <> newer.id
  AND (
    coalesce(newer.completed_at, newer.created_at)
    > coalesce(b.completed_at, b.created_at)
    OR (
      coalesce(newer.completed_at, newer.created_at)
      = coalesce(b.completed_at, b.created_at)
      AND newer.id > b.id
    )
  );

-- =============================================================================
-- 3) NULL-safe partial unique indexes
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_botaniqals_batches_cycle_product_null_variant
  ON public.botaniqals_production_batches (production_cycle_id, product_id)
  WHERE product_variant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_botaniqals_batches_cycle_product_variant
  ON public.botaniqals_production_batches (production_cycle_id, product_id, product_variant_id)
  WHERE product_variant_id IS NOT NULL;
