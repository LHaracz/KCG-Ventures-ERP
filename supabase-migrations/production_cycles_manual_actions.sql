-- Production Cycles & Planner: Existing Cycles table redesign support.
--
-- "Produced but not completed" already has a home in the data model —
-- production_cycles.raw_materials_deducted_at (non-null = produced) and
-- status <> 'completed' together mean exactly that. No new status is added.
--
-- What's actually missing:
--   1) A creation timestamp to sort the In Progress tab by (newest first).
--   2) A completion timestamp to sort the Completed tab by (newest first),
--      with created_at as the documented fallback for cycles completed
--      before this migration existed.
--   3) A new inventory_transactions type for Reopen Production's
--      finished-goods reversal (BotanIQals cycles only).
--
-- Run in the Supabase SQL editor.

-- 1) created_at. DEFAULT now() means every pre-existing row is backfilled to
--    this migration's run time (their true creation time isn't recoverable
--    from existing data) — this only affects relative ordering among cycles
--    created before today; every cycle created from here on gets an
--    accurate timestamp.
ALTER TABLE production_cycles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- 2) completed_at. Set by the app when a cycle's status is set to
--    'completed' (Complete Production), cleared back to NULL by Reopen
--    Production. NULL for any cycle completed before this migration — the
--    Completed tab's sort falls back to created_at for those.
ALTER TABLE production_cycles ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- 3) inventory_transactions.type: add 'production_reversal'. Looked up the
--    existing CHECK constraint by introspection rather than assuming its
--    auto-generated name, so this can't silently leave the old constraint
--    in place alongside a new one.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'inventory_transactions'
      AND con.contype = 'c'
      AND att.attname = 'type'
  LOOP
    EXECUTE format('ALTER TABLE inventory_transactions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_type_check
  CHECK (type IN ('sale_decrease', 'production_increase', 'cycle_count_adjustment', 'production_reversal'));
