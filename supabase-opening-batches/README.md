1. Run `00-backup.sql` in the Supabase SQL editor (copies finished goods counts and transactions to backup tables).
2. Run `01-preview.sql` and review every row (it changes nothing).
3. Run `02-apply.sql` (one transaction; running it a second time creates nothing), then count the real boxes with "Count boxes" on Active Batches.
