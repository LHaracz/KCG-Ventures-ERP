-- Fix: "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" when completing a BotanIQals production cycle.
--
-- ROOT CAUSE
-- fix_botaniqals_batches_unique_null_safe.sql (applied ~2026-07-29) replaced the
-- old constraints on public.botaniqals_production_batches with two *partial*
-- unique indexes:
--   uq_botaniqals_batches_cycle_product_null_variant
--     ON (production_cycle_id, product_id) WHERE product_variant_id IS NULL
--   uq_botaniqals_batches_cycle_product_variant
--     ON (production_cycle_id, product_id, product_variant_id) WHERE product_variant_id IS NOT NULL
--
-- The cycle-completion code (src/app/cycles/page.tsx) does:
--   supabase.from("botaniqals_production_batches").upsert(batchRows, {
--     onConflict: "production_cycle_id,product_id",
--   })
-- which Postgres turns into `ON CONFLICT (production_cycle_id, product_id) DO UPDATE ...`
-- with no WHERE clause. Postgres will only use a *partial* unique index as the
-- ON CONFLICT arbiter when the ON CONFLICT clause repeats that index's WHERE
-- predicate -- and PostgREST/supabase-js's `onConflict` option has no way to pass
-- a predicate through. So neither partial index can ever be matched, and every
-- completion attempt throws this error.
--
-- The completion code never sets product_variant_id when writing a batch row (it
-- groups only by product_id, so the column is always NULL there), so this upsert
-- only ever needs a plain, non-partial unique constraint on
-- (production_cycle_id, product_id). This migration replaces the two partial
-- indexes with that.
--
-- No app code changes are needed -- src/app/cycles/page.tsx already targets
-- "production_cycle_id,product_id", which is exactly what this adds.
--
-- Apply manually in the Supabase SQL editor.

-- =============================================================================
-- 0) DIAGNOSTIC (run first) -- duplicate (cycle, product) groups that would
-- violate the new constraint. Review before running section 2 if this returns rows.
-- =============================================================================
-- SELECT
--   production_cycle_id,
--   product_id,
--   count(*) AS row_count,
--   array_agg(id ORDER BY coalesce(completed_at, created_at) DESC) AS ids,
--   array_agg(quantity_produced ORDER BY coalesce(completed_at, created_at) DESC) AS qtys,
--   array_agg(completed_at ORDER BY coalesce(completed_at, created_at) DESC) AS completed_ats,
--   array_agg(created_at ORDER BY coalesce(completed_at, created_at) DESC) AS created_ats
-- FROM public.botaniqals_production_batches
-- GROUP BY production_cycle_id, product_id
-- HAVING count(*) > 1;

-- =============================================================================
-- 1) Drop the partial indexes that can never satisfy the app's ON CONFLICT target
-- =============================================================================
DROP INDEX IF EXISTS public.uq_botaniqals_batches_cycle_product_null_variant;
DROP INDEX IF EXISTS public.uq_botaniqals_batches_cycle_product_variant;

-- =============================================================================
-- 2) Deduplicate (keep newest by completed_at, then created_at)
-- Safe no-op if the diagnostic above showed 0 duplicate groups.
-- =============================================================================
DELETE FROM public.botaniqals_production_batches b
USING public.botaniqals_production_batches newer
WHERE b.production_cycle_id = newer.production_cycle_id
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

-- =============================================================================
-- 3) Add a real (non-partial) unique constraint matching the app's upsert target
-- =============================================================================
ALTER TABLE public.botaniqals_production_batches
  ADD CONSTRAINT uq_botaniqals_batches_cycle_product UNIQUE (production_cycle_id, product_id);
