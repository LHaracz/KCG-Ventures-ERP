/**
 * Shared types and small pure helpers for the Compliance Logs feature
 * (log_types / log_fields / log_entries / log_entry_files / log_entry_reviews).
 * Used by the hub, entries table, dynamic form, entry detail, template
 * builder, the receiving log, the release-warnings panel, and export.
 */

export type ScheduleType = "none" | "daily" | "weekly" | "monthly" | "per_cycle";

export type LogFieldType =
  | "text"
  | "longtext"
  | "number"
  | "select"
  | "checklist"
  | "date"
  | "datetime"
  | "pass_fail"
  | "yes_no"
  | "employee"
  | "sop"
  | "production_cycle"
  | "raw_material";

export const LOG_FIELD_TYPES: { value: LogFieldType; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "longtext", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select (one option)" },
  { value: "checklist", label: "Checklist (multiple)" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date & time" },
  { value: "pass_fail", label: "Pass / Fail" },
  { value: "yes_no", label: "Yes / No" },
  { value: "employee", label: "Employee (roster)" },
  { value: "sop", label: "Linked SOP" },
  { value: "production_cycle", label: "Production cycle" },
  { value: "raw_material", label: "Raw material" },
];

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export type LogType = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  linked_sop_id: string | null;
  schedule_type: ScheduleType;
  schedule_days: WeekdayKey[];
  include_in_release_check: boolean;
  special_type: "receiving" | null;
  is_seeded: boolean;
  archived_at: string | null;
  created_at: string;
};

export type LogField = {
  id: string;
  log_type_id: string;
  key: string;
  label: string;
  field_type: LogFieldType;
  required: boolean;
  options: string[] | null;
  min_value: number | null;
  max_value: number | null;
  unit: string | null;
  help_text: string | null;
  sort_order: number;
  archived_at: string | null;
};

// What a field looked like at the moment an entry was submitted — frozen
// onto the entry so a later template edit never rewrites history.
export type TemplateSnapshotField = {
  key: string;
  label: string;
  field_type: LogFieldType;
  required: boolean;
  options: string[] | null;
  min_value: number | null;
  max_value: number | null;
  unit: string | null;
  help_text: string | null;
};

export type TemplateSnapshot = {
  logTypeName: string;
  fields: TemplateSnapshotField[];
};

export type OutOfSpecDetail = {
  key: string;
  label: string;
  reason: "below_min" | "above_max" | "fail";
  value: unknown;
  limit?: number;
};

export type LogEntry = {
  id: string;
  log_type_id: string;
  entry_number: number;
  performed_at: string;
  performed_by_employee_id: string | null;
  performed_by_name: string;
  values: Record<string, unknown>;
  template_snapshot: TemplateSnapshot;
  production_cycle_id: string | null;
  is_out_of_spec: boolean;
  out_of_spec_details: OutOfSpecDetail[] | null;
  corrective_action: string | null;
  corrects_entry_id: string | null;
  correction_reason: string | null;
  created_at: string;
  created_by_account: string | null;
};

export type LogEntryFile = {
  id: string;
  log_entry_id: string;
  file_path: string;
  original_filename: string;
  file_size_bytes: number;
  document_type: "coa" | "sds" | "invoice" | "spec_sheet" | "other";
  label: string | null;
  added_at: string;
  added_by_name: string;
  added_after_submit: boolean;
};

export type LogEntryReview = {
  id: string;
  log_entry_id: string;
  reviewed_by_employee_id: string | null;
  reviewed_by_name: string;
  reviewed_at: string;
  note: string | null;
};

/** Client-safe filename check used to pick a viewer (PdfViewer vs. an image tag). */
export function isImageFilename(filename: string): boolean {
  const lower = filename.toLowerCase().trim();
  return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg");
}

export const DOCUMENT_TYPES: { value: LogEntryFile["document_type"]; label: string }[] = [
  { value: "coa", label: "COA" },
  { value: "sds", label: "SDS" },
  { value: "invoice", label: "Invoice / Packing slip" },
  { value: "spec_sheet", label: "Spec sheet" },
  { value: "other", label: "Other" },
];

/** Only non-archived fields, in display order — what a form/snapshot uses. */
export function activeFieldsSorted(fields: LogField[]): LogField[] {
  return fields
    .filter((f) => !f.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function buildTemplateSnapshot(logTypeName: string, fields: LogField[]): TemplateSnapshot {
  return {
    logTypeName,
    fields: activeFieldsSorted(fields).map((f) => ({
      key: f.key,
      label: f.label,
      field_type: f.field_type,
      required: f.required,
      options: f.options,
      min_value: f.min_value,
      max_value: f.max_value,
      unit: f.unit,
      help_text: f.help_text,
    })),
  };
}

/**
 * Out of spec = a number field outside its min/max, or a pass_fail field
 * marked "fail". The caller still saves the entry regardless (the record
 * must reflect the truth) — this only decides the flag, the required
 * corrective-action prompt, and the out_of_spec_details payload.
 */
export function evaluateOutOfSpec(
  fields: TemplateSnapshotField[],
  values: Record<string, unknown>,
): { isOutOfSpec: boolean; details: OutOfSpecDetail[] } {
  const details: OutOfSpecDetail[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (field.field_type === "number") {
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      if (field.min_value != null && num < field.min_value) {
        details.push({ key: field.key, label: field.label, reason: "below_min", value: num, limit: field.min_value });
      } else if (field.max_value != null && num > field.max_value) {
        details.push({ key: field.key, label: field.label, reason: "above_max", value: num, limit: field.max_value });
      }
    } else if (field.field_type === "pass_fail" && value === "fail") {
      details.push({ key: field.key, label: field.label, reason: "fail", value });
    }
  }
  return { isOutOfSpec: details.length > 0, details };
}

/** "Late entry" badge: performed_at backdated/postdated more than 24h from created_at. */
export function isLateEntry(performedAt: string, createdAt: string): boolean {
  const performed = new Date(performedAt).getTime();
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(performed) || !Number.isFinite(created)) return false;
  return Math.abs(created - performed) > 24 * 60 * 60 * 1000;
}

/** An entry is "superseded" the moment some other entry corrects it — computed, never stored. */
export function supersedingEntryId(entryId: string, allEntriesForType: LogEntry[]): string | null {
  const corrector = allEntriesForType.find((e) => e.corrects_entry_id === entryId);
  return corrector ? corrector.id : null;
}

export function formatScheduleSummary(logType: Pick<LogType, "schedule_type" | "schedule_days">): string {
  switch (logType.schedule_type) {
    case "none":
      return "No schedule";
    case "daily":
      return `Daily (${logType.schedule_days.map((d) => WEEKDAY_LABELS[d]).join(", ")})`;
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "per_cycle":
      return "Per production cycle";
    default:
      return "";
  }
}
