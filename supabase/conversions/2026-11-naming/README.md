1. Run `00-backup.sql` in the Supabase SQL editor (copies the affected tables into tables named with today's date).
2. Run `01-preview.sql` and review every result (the posts with a subtopic in another topic, and the duplicate names, must both be empty).
3. Run `02-apply.sql` (one transaction; running it again does nothing).
