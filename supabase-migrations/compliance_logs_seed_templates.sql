-- Compliance Logs: seeded templates (Phase 3). Run compliance_logs_core.sql
-- and compliance_logs_receiving.sql first. Run in the Supabase SQL editor.
--
-- Creates exactly the 6 log types the spec calls out as starting points —
-- all editable afterward via the template builder (/compliance/logs/settings),
-- and all is_seeded = true. Idempotent: re-running this file is a no-op once
-- the rows exist (slug is unique on log_types, (log_type_id, key) is unique
-- on log_fields).
--
-- Do not add anything beyond these 6 here — more log types (temperature,
-- pest control, complaints/adverse events, deviations, QC release) are
-- meant to be created later through the template builder, per spec.

-- 1) Sanitation Log — daily (Mon-Fri), included in release check ----------
insert into log_types (name, slug, description, schedule_type, schedule_days, include_in_release_check, is_seeded)
values (
  'Sanitation Log',
  'sanitation-log',
  'Daily sanitation and pre-operation inspection of production areas.',
  'daily',
  '["mon","tue","wed","thu","fri"]'::jsonb,
  true,
  true
)
on conflict (slug) do nothing;

insert into log_fields (log_type_id, key, label, field_type, required, options, sort_order)
select id, v.key, v.label, v.field_type, v.required, v.options, v.sort_order
from log_types, (values
  ('area', 'Area', 'select', true, '["Production room", "Packing area", "Storage", "Handwash/Restroom"]'::jsonb, 10),
  ('pre_operation_inspection', 'Pre-operation inspection', 'pass_fail', true, null::jsonb, 20),
  ('checklist', 'Checklist', 'checklist', false, '["Surfaces cleaned and sanitized", "Floors cleaned", "Trash removed", "Handwash station stocked", "Equipment cleaned per SOP", "Sanitizer concentration verified"]'::jsonb, 30),
  ('sanitizer_concentration_ppm', 'Sanitizer concentration', 'number', false, null::jsonb, 40),
  ('notes', 'Notes', 'longtext', false, null::jsonb, 50)
) as v(key, label, field_type, required, options, sort_order)
where log_types.slug = 'sanitation-log'
on conflict (log_type_id, key) do nothing;

update log_fields set unit = 'ppm' where key = 'sanitizer_concentration_ppm'
  and log_type_id = (select id from log_types where slug = 'sanitation-log');

-- 2) Equipment Cleaning & Line Clearance — per cycle, included ------------
insert into log_types (name, slug, description, schedule_type, include_in_release_check, is_seeded)
values (
  'Equipment Cleaning & Line Clearance',
  'equipment-cleaning-line-clearance',
  'Cleaning and line-clearance verification between production runs.',
  'per_cycle',
  true,
  true
)
on conflict (slug) do nothing;

insert into log_fields (log_type_id, key, label, field_type, required, sort_order)
select id, v.key, v.label, v.field_type, v.required, v.sort_order
from log_types, (values
  ('production_cycle', 'Production cycle', 'production_cycle', true, 10),
  ('equipment', 'Equipment', 'text', false, 20),
  ('previous_product', 'Previous product', 'text', false, 30),
  ('next_product', 'Next product', 'text', false, 40),
  ('cleaning_method_agent', 'Cleaning method and agent', 'text', false, 50),
  ('visual_inspection', 'Visual inspection', 'pass_fail', false, 60),
  ('line_cleared', 'Line cleared of previous product/labels/materials', 'yes_no', true, 70),
  ('notes', 'Notes', 'longtext', false, 80)
) as v(key, label, field_type, required, sort_order)
where log_types.slug = 'equipment-cleaning-line-clearance'
on conflict (log_type_id, key) do nothing;

-- 3) Receiving Log — special form, no schedule -----------------------------
-- Fields are code-defined in ReceivingEntryForm, not log_fields rows — see
-- compliance_logs_receiving.sql. Not included in the per-type release
-- check (include_in_release_check = false): its own dedicated "COA on file
-- per BOM ingredient" check covers it (release-warnings panel, Phase 5).
insert into log_types (name, slug, description, schedule_type, include_in_release_check, special_type, is_seeded)
values (
  'Receiving Log',
  'receiving',
  'Incoming raw material receipts — supplier, lot, quantity, and documents.',
  'none',
  false,
  'receiving',
  true
)
on conflict (slug) do nothing;

-- 4) Batch Production Record — per cycle, included -------------------------
insert into log_types (name, slug, description, schedule_type, include_in_release_check, is_seeded)
values (
  'Batch Production Record',
  'batch-production-record',
  'Per-batch formula version, lot traceability, yield, and label reconciliation.',
  'per_cycle',
  true,
  true
)
on conflict (slug) do nothing;

insert into log_fields (log_type_id, key, label, field_type, required, sort_order)
select id, v.key, v.label, v.field_type, v.required, v.sort_order
from log_types, (values
  ('production_cycle', 'Production cycle', 'production_cycle', true, 10),
  ('formula_version_used', 'Formula version used', 'text', false, 20),
  ('ingredient_lot_numbers_used', 'Ingredient lot numbers used', 'longtext', false, 30),
  ('theoretical_yield', 'Theoretical yield', 'number', false, 40),
  ('actual_yield', 'Actual yield', 'number', false, 50),
  ('labels_issued', 'Labels issued', 'number', false, 60),
  ('labels_used', 'Labels used', 'number', false, 70),
  ('labels_destroyed_returned', 'Labels destroyed/returned', 'number', false, 80),
  ('notes', 'Notes', 'longtext', false, 90)
) as v(key, label, field_type, required, sort_order)
where log_types.slug = 'batch-production-record'
on conflict (log_type_id, key) do nothing;

-- 5) Training Record — no schedule -----------------------------------------
insert into log_types (name, slug, description, schedule_type, include_in_release_check, is_seeded)
values (
  'Training Record',
  'training-record',
  'Employee training sessions, assessments, and retraining due dates.',
  'none',
  false,
  true
)
on conflict (slug) do nothing;

insert into log_fields (log_type_id, key, label, field_type, required, options, help_text, sort_order)
select id, v.key, v.label, v.field_type, v.required, v.options, v.help_text, v.sort_order
from log_types, (values
  ('employee', 'Employee', 'employee', true, null::jsonb, null::text, 10),
  ('topic', 'Topic', 'text', false, null::jsonb, null::text, 20),
  ('linked_sop', 'Linked SOP', 'sop', false, null::jsonb, null::text, 30),
  ('trainer', 'Trainer', 'employee', false, null::jsonb, null::text, 40),
  ('training_date', 'Training date', 'date', false, null::jsonb, null::text, 50),
  ('method', 'Method', 'select', false, '["Read and understood", "Hands-on", "Video"]'::jsonb, null::text, 60),
  ('assessment', 'Assessment', 'pass_fail', false, null::jsonb, null::text, 70),
  ('retraining_due_date', 'Retraining due date', 'date', false, null::jsonb, 'Optional.', 80),
  ('notes', 'Notes', 'longtext', false, null::jsonb, null::text, 90)
) as v(key, label, field_type, required, options, help_text, sort_order)
where log_types.slug = 'training-record'
on conflict (log_type_id, key) do nothing;

-- 6) Calibration Log — monthly, included ------------------------------------
insert into log_types (name, slug, description, schedule_type, include_in_release_check, is_seeded)
values (
  'Calibration Log',
  'calibration-log',
  'Monthly equipment calibration against a reference standard.',
  'monthly',
  true,
  true
)
on conflict (slug) do nothing;

insert into log_fields (log_type_id, key, label, field_type, required, sort_order)
select id, v.key, v.label, v.field_type, v.required, v.sort_order
from log_types, (values
  ('equipment', 'Equipment', 'text', false, 10),
  ('reference_standard_used', 'Reference standard used', 'text', false, 20),
  ('expected_value', 'Expected value', 'number', false, 30),
  ('actual_reading', 'Actual reading', 'number', false, 40),
  ('result', 'Result', 'pass_fail', false, 50),
  ('next_calibration_due', 'Next calibration due', 'date', false, 60),
  ('notes', 'Notes', 'longtext', false, 70)
) as v(key, label, field_type, required, sort_order)
where log_types.slug = 'calibration-log'
on conflict (log_type_id, key) do nothing;
