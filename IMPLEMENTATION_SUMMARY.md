# MiniLeaf / BotanIQals Production Planning — Implementation Summary

## What Was Fully Implemented

- **Schema and migrations**
  - `production_cycles`: `business_type` (MiniLeaf | BotanIQals), `harvest_date` (nullable). Backfill from existing `brand`.
  - `products`: `is_microgreen` enforced as not null.
  - `product_variants`: New table (id, user_id, product_id, name, size_oz, sku, is_active, created_at) with RLS.
  - `bom_lines`: `line_type`, `microgreen_id`, `freeze_dryer_profile_id` added if missing.
  - `production_targets`: `product_variant_id`, `quantity_to_produce`, `extra_full_trays` added.
  - `production_plan_lines`: `business_type`, `product_variant_id`, `drain_date` added.
  - `schedule_events`: Table created/updated with required columns and RLS.

- **Cycle creation UI and validation**
  - Required business type selector: MiniLeaf | BotanIQals.
  - MiniLeaf: Required harvest date; validation blocks submit if missing.
  - BotanIQals: Required start and end date; validation enforces end ≥ start.
  - Cycle list shows business type and harvest date or date range.

- **Product variants**
  - CRUD for `product_variants` on Products page when a microgreen product is selected.
  - Variants define name, size_oz, sku, is_active. MiniLeaf planner uses `size_oz` for ounce math.

- **Production targets model**
  - MiniLeaf: product + product_variant_id + quantity_to_produce + extra_full_trays; saved to `production_targets`.
  - BotanIQals: product + quantity_to_produce only.

- **MiniLeaf planner logic**
  - Product selection limited to `is_microgreen === true`; variant selection from `product_variants` for chosen product.
  - Microgreen from **product.microgreen only** (single source of truth).
  - Ounces: `quantity_to_produce * variant.size_oz`; aggregated by microgreen.
  - Yield-based tray estimate from `yield_entries` (avg fresh yield per tray, g→oz); **final_trays = estimated_trays + extra_full_trays**.
  - Backward schedule from **cycle.harvest_date**: soak, drain (if applicable), sow, move_to_light, harvest using Microgreen Guide fields.
  - Plan lines and **schedule_events** generated (soak, drain, sow, move_to_light, harvest).
  - Feasibility/warning when yield data is missing.

- **BotanIQals planner logic**
  - Product selection limited to `is_microgreen === false`.
  - BOM explosion: all BOM lines × quantity_to_produce; aggregated by type (ingredients, packaging, raw/dried microgreens).
  - Dried microgreen: dried grams from BOM; fresh input via `dry_matter_fraction` (freeze_dryer_profiles or calibration); per-run capacity from machine settings + profile overrides.
  - **One facility-wide freeze dryer schedule**: runs placed in [start_date, end_date] in 3-day blocks; shared pool with conflict-free assignment across machine numbers.
  - Upstream grow schedule backward from each freeze_dry_start (harvest on freeze_dry_start day; soak, drain, sow, move_to_light, harvest, then freeze_dry_start, freeze_dry_end).
  - Plan lines and **schedule_events** generated for grow + freeze_dry_start / freeze_dry_end.

- **Schedule events generation**
  - On Generate/Regenerate: **delete all `schedule_events`** for the cycle, then **delete all `production_plan_lines`** for the cycle, then recalculate and insert both.
  - Event types: soak, drain, sow, move_to_light, harvest, freeze_dry_start, freeze_dry_end (and warning if used).
  - Status: planned, warning, infeasible. Events store business_type, product_id, product_variant_id, microgreen_id, quantity, trays, run_number, machine_number, notes.

- **Regenerate rule**
  - No duplication: old schedule_events and production_plan_lines for the cycle are deleted before new ones are created.

- **Feasibility and shortage reporting**
  - Shortages: BOM requirements vs inventory on hand; grouped by item; shown for both modes.
  - MiniLeaf: feasibility reflects yield data presence and tray math.
  - BotanIQals: feasibility reflects freeze dryer capacity and window fit; warning when runs don’t fit.

- **Schedule/calendar UI**
  - Schedule page: events grouped by date (chronological); expandable row for business_type, quantity, trays, notes, status.
  - Event types and status clearly shown.

---

## Files Changed

| File | Changes |
|------|--------|
| `instant.schema.ts` | production_cycles (business_type, harvest_date), product_variants entity, production_targets (product_variant_id, quantity_to_produce, extra_full_trays), production_plan_lines (business_type, product_variant_id, drain_date), products (is_microgreen, sale_price_per_unit optional) |
| `instant.perms.ts` | product_variants read/write by user |
| `src/app/cycles/page.tsx` | Form uses business_type (MiniLeaf/BotanIQals); MiniLeaf requires harvest_date; BotanIQals requires start/end with end ≥ start; list shows business type and harvest or range |
| `src/app/cycles/[id]/plan/page.tsx` | Full refactor: load yield_entries, product_variants, freeze_dryer_machine_settings, freeze_dryer_profiles; MiniLeaf demand (product → variant, quantity_to_produce, extra_full_trays); BotanIQals demand (product, quantity_to_produce); minileafAggregate (oz, yield-based trays, final_trays); feasibility split by mode; handleGeneratePlan deletes schedule_events + plan_lines then generates for MiniLeaf (harvest_date anchor) or BotanIQals (BOM, dried mg, shared freeze dryer, upstream grow); schedule_events inserts for both modes; tray plan table includes drain_date |
| `src/app/products/page.tsx` | Load product_variants; Variants CRUD section for microgreen products (name, size_oz, sku, is_active); product list shows variant count; required Microgreen dropdown when Is Microgreen is checked; payload includes microgreen; validation when is_microgreen and no microgreen_id |
| `src/app/schedule/page.tsx` | Events grouped by date; extended type (business_type, product_variant_id, run_number, notes); expandable detail row |
| `src/lib/units.ts` | Added `gramsToOz` for display |

---

## Files Added

| File | Purpose |
|------|--------|
| `supabase-migrations/production_planning_minileaf_botaniqals.sql` | Migration: business_type + harvest_date on production_cycles; is_microgreen on products; product_variants table; bom_lines columns; production_targets columns; production_plan_lines columns; schedule_events create/alter and RLS |
| `IMPLEMENTATION_SUMMARY.md` | This summary |

---

## Migrations

1. **Run order**
   - `bom_lines_nullable_inventory_item.sql` (if not already applied)
   - `is_microgreen_variants_brand.sql` (if not already applied)
   - **`production_planning_minileaf_botaniqals.sql`** (new)

2. **Backfill**
   - `production_cycles.business_type` is backfilled from `brand` ('minileaf' → 'MiniLeaf', 'botaniqals' → 'BotanIQals') in the new migration.
   - No backfill for `product_variants`; create variants in the UI for MiniLeaf products.

---

## Assumptions

- **product.microgreen** (FK to microgreens) is the single source of truth for which microgreen a MiniLeaf product is; variants only define pack size (size_oz). The product form now requires a microgreen selection when “Is Microgreen” is checked.
- **Supabase** column names: `user_id`, `production_cycle`, `production_cycle_id` as used in the app (production_cycles and production_plan_lines use `production_cycle`; schedule_events uses `production_cycle_id`).
- **freeze_dryer_machine_settings** and **freeze_dryer_profiles** exist and are used for BotanIQals; calibration table is still used as fallback when machine settings are missing.
- **schedule_events** are only written by the app (no DB triggers).
- **brand** column may remain on production_cycles for backward compatibility; the app uses **business_type** for logic and display.
- **RLS**: New tables (product_variants, schedule_events) use `auth.uid() = user_id` in the migration.

---

## Manual Testing Checklist

1. **Migrations**
   - Run `production_planning_minileaf_botaniqals.sql` on the target Supabase project; confirm no errors and that existing cycles have `business_type` set.

2. **Cycle creation**
   - Create a MiniLeaf cycle: select MiniLeaf, set harvest date, status; submit. Expect success. Try without harvest date; expect validation error.
   - Create a BotanIQals cycle: select BotanIQals, set start and end (end ≥ start), status; submit. Expect success. Try end < start; expect validation error.
   - Confirm cycle list shows business type and harvest date or range.

3. **Product variants**
   - On Products, create or select a product with “Is Microgreen” checked. Add variants (name, size_oz, sku). Edit/delete a variant. Confirm list shows variant count for microgreen products.

4. **MiniLeaf planner**
   - Open a MiniLeaf cycle’s planner. Add targets: select microgreen product → variant → quantity → optional extra full trays. Save. Confirm demand list shows product (variant) and quantity and extra trays.
   - Confirm feasibility shows harvest date and per-microgreen table (total oz, avg yield/tray, estimated trays, extra trays, final trays). If a microgreen has no yield entries, expect a warning.
   - Click “Generate / Regenerate Plan”. Confirm plan lines and tray table (soak, drain, sow, light, harvest) and that harvest date matches cycle harvest date. Open Schedule page; confirm events grouped by date (soak, drain, sow, move_to_light, harvest).

5. **BotanIQals planner**
   - Open a BotanIQals cycle’s planner. Add targets for a product that has BOM with dried_microgreen lines. Save. Confirm feasibility shows total dried/fresh, capacity, required cycles.
   - Click “Generate / Regenerate Plan”. Confirm plan lines and schedule_events for grow + freeze_dry_start, freeze_dry_end; runs in 3-day blocks within cycle window. Schedule page shows events by date.

6. **Regenerate**
   - Generate plan, then add/change a target and regenerate. Confirm no duplicate schedule_events or plan lines; old ones removed, new set created.

7. **Shortages**
   - With BOM and inventory set, confirm shortage table shows required vs on hand and shortage for both MiniLeaf and BotanIQals cycles when applicable.

8. **Schedule UI**
   - Confirm events are grouped by date; expand an event and confirm business_type, quantity, trays, notes, status where present.

---

## What Was Not Implemented

- **Week/month calendar view**: Schedule page uses a chronological list grouped by date only; no week/month grid calendar view.
- **Explicit “fallback” yield**: When there is no yield history, the spec says to use a fallback only if one exists explicitly in the system; no such fallback table or field was added; the UI shows a warning and does not invent a number.

---

## What Still Needs Manual Follow-up

1. **Apply migration**  
   Run `supabase-migrations/production_planning_minileaf_botaniqals.sql` on your Supabase project (e.g. via Supabase dashboard SQL editor or CLI).

2. **Product–microgreen link**  
   The product form now has a required “Microgreen” dropdown when “Is Microgreen” is checked; ensure existing microgreen products are edited and saved with a microgreen selected, or backfill `product.microgreen` in the DB for existing rows.

3. **Optional backfill of product_variants**  
   If you previously used BOM lines as “variants” for MiniLeaf, optionally create `product_variants` rows from those BOM lines (e.g. one variant per raw_microgreen line with qty_per_unit as size_oz if unit is oz) and then point production_targets to variant IDs where appropriate.

4. **RLS for schedule_events**  
   Migration adds RLS and a user policy; confirm in Supabase that `schedule_events` is only readable/writable by the owning user.

5. **Existing cycles**  
   Cycles created before the migration will have `business_type` backfilled from `brand`. Cycles that had no `brand` will get `BotanIQals`. Verify and adjust in DB if needed.
