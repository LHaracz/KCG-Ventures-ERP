alter table if exists inventory_logs
  drop constraint if exists inventory_logs_reason_check;

alter table if exists inventory_logs
  add constraint inventory_logs_reason_check
  check (reason in ('production', 'order', 'shopify_override', 'cycle_count'));
