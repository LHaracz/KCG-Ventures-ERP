"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import {
  LOG_FIELD_TYPES,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  formatScheduleSummary,
  type LogField,
  type LogFieldType,
  type LogType,
  type ScheduleType,
  type WeekdayKey,
} from "@/lib/complianceLogs";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type LogTypeForm = {
  id?: string;
  name: string;
  slug: string;
  description: string;
  linked_sop_id: string;
  schedule_type: ScheduleType;
  schedule_days: WeekdayKey[];
  include_in_release_check: boolean;
};

type FieldForm = {
  id?: string;
  key: string;
  label: string;
  field_type: LogFieldType;
  required: boolean;
  optionsText: string; // newline-separated, for select/checklist
  min_value: string;
  max_value: string;
  unit: string;
  help_text: string;
};

const EMPTY_FIELD_FORM: FieldForm = {
  key: "",
  label: "",
  field_type: "text",
  required: false,
  optionsText: "",
  min_value: "",
  max_value: "",
  unit: "",
  help_text: "",
};

export default function LogTemplateSettingsPage() {
  const { user, supabase } = useSupabase();

  const [logTypes, setLogTypes] = useState<LogType[]>([]);
  const [fieldsByType, setFieldsByType] = useState<Map<string, LogField[]>>(new Map());
  const [sops, setSops] = useState<Array<{ id: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeModal, setTypeModal] = useState<LogTypeForm | null>(null);
  const [typeSaving, setTypeSaving] = useState(false);
  const [typeError, setTypeError] = useState<string | null>(null);

  const [fieldModal, setFieldModal] = useState<FieldForm | null>(null);
  const [fieldSaving, setFieldSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [typesResult, fieldsResult, sopsResult] = await Promise.all([
        supabase.from("log_types").select("*").order("name"),
        supabase.from("log_fields").select("*").order("sort_order"),
        supabase.from("sops").select("id, title").is("archived_at", null).order("title"),
      ]);
      if (typesResult.error) throw new Error(typesResult.error.message);
      if (fieldsResult.error) throw new Error(fieldsResult.error.message);
      setLogTypes((typesResult.data ?? []) as LogType[]);
      setSops((sopsResult.data ?? []) as Array<{ id: string; title: string }>);

      const map = new Map<string, LogField[]>();
      for (const field of (fieldsResult.data ?? []) as LogField[]) {
        const list = map.get(field.log_type_id) ?? [];
        list.push(field);
        map.set(field.log_type_id, list);
      }
      setFieldsByType(map);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load templates.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const sortedTypes = useMemo(
    () => [...logTypes].sort((a, b) => a.name.localeCompare(b.name)),
    [logTypes],
  );
  const selectedType = sortedTypes.find((t) => t.id === selectedId) ?? null;
  const selectedFields = selectedId ? (fieldsByType.get(selectedId) ?? []) : [];

  const handleNewType = () => {
    setTypeError(null);
    setTypeModal({
      name: "",
      slug: "",
      description: "",
      linked_sop_id: "",
      schedule_type: "none",
      schedule_days: ["mon", "tue", "wed", "thu", "fri"],
      include_in_release_check: false,
    });
  };

  const handleEditType = (logType: LogType) => {
    setTypeError(null);
    setTypeModal({
      id: logType.id,
      name: logType.name,
      slug: logType.slug,
      description: logType.description ?? "",
      linked_sop_id: logType.linked_sop_id ?? "",
      schedule_type: logType.schedule_type,
      schedule_days: logType.schedule_days.length ? logType.schedule_days : ["mon", "tue", "wed", "thu", "fri"],
      include_in_release_check: logType.include_in_release_check,
    });
  };

  const handleSaveType = async () => {
    if (!typeModal) return;
    if (!typeModal.name.trim()) {
      setTypeError("Name is required.");
      return;
    }
    const slug = (typeModal.slug.trim() || slugify(typeModal.name)).trim();
    if (!slug) {
      setTypeError("Slug is required.");
      return;
    }
    setTypeSaving(true);
    setTypeError(null);
    try {
      const payload = {
        name: typeModal.name.trim(),
        slug,
        description: typeModal.description.trim() || null,
        linked_sop_id: typeModal.linked_sop_id || null,
        schedule_type: typeModal.schedule_type,
        schedule_days: typeModal.schedule_type === "daily" ? typeModal.schedule_days : [],
        include_in_release_check: typeModal.include_in_release_check,
      };
      if (typeModal.id) {
        const { error } = await supabase.from("log_types").update(payload).eq("id", typeModal.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("log_types").insert(payload);
        if (error) throw new Error(error.message);
      }
      setTypeModal(null);
      await load();
    } catch (err: any) {
      setTypeError(err.message || "Failed to save this log type.");
    } finally {
      setTypeSaving(false);
    }
  };

  const handleArchiveType = async (logType: LogType) => {
    try {
      const { error } = await supabase
        .from("log_types")
        .update({ archived_at: logType.archived_at ? null : new Date().toISOString() })
        .eq("id", logType.id);
      if (error) throw new Error(error.message);
      await load();
    } catch (err: any) {
      setLoadError(err.message || "Failed to update this log type.");
    }
  };

  const handleNewField = () => {
    setFieldError(null);
    setFieldModal({ ...EMPTY_FIELD_FORM });
  };

  const handleEditField = (field: LogField) => {
    setFieldError(null);
    setFieldModal({
      id: field.id,
      key: field.key,
      label: field.label,
      field_type: field.field_type,
      required: field.required,
      optionsText: (field.options ?? []).join("\n"),
      min_value: field.min_value != null ? String(field.min_value) : "",
      max_value: field.max_value != null ? String(field.max_value) : "",
      unit: field.unit ?? "",
      help_text: field.help_text ?? "",
    });
  };

  const handleSaveField = async () => {
    if (!fieldModal || !selectedType) return;
    if (!fieldModal.label.trim()) {
      setFieldError("Label is required.");
      return;
    }
    const key = (fieldModal.id ? fieldModal.key : fieldModal.key.trim() || slugify(fieldModal.label)).replace(/-/g, "_");
    if (!key) {
      setFieldError("Could not derive a field key from this label.");
      return;
    }
    const needsOptions = fieldModal.field_type === "select" || fieldModal.field_type === "checklist";
    const options = needsOptions
      ? fieldModal.optionsText.split("\n").map((s) => s.trim()).filter(Boolean)
      : null;
    if (needsOptions && (!options || options.length === 0)) {
      setFieldError("Add at least one option, one per line.");
      return;
    }

    setFieldSaving(true);
    setFieldError(null);
    try {
      const payload = {
        log_type_id: selectedType.id,
        key,
        label: fieldModal.label.trim(),
        field_type: fieldModal.field_type,
        required: fieldModal.required,
        options,
        min_value: fieldModal.min_value.trim() === "" ? null : Number(fieldModal.min_value),
        max_value: fieldModal.max_value.trim() === "" ? null : Number(fieldModal.max_value),
        unit: fieldModal.unit.trim() || null,
        help_text: fieldModal.help_text.trim() || null,
      };
      if (fieldModal.id) {
        const { error } = await supabase.from("log_fields").update(payload).eq("id", fieldModal.id);
        if (error) throw new Error(error.message);
      } else {
        const existing = fieldsByType.get(selectedType.id) ?? [];
        const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((f) => f.sort_order)) + 1 : 0;
        const { error } = await supabase.from("log_fields").insert({ ...payload, sort_order: nextSortOrder });
        if (error) throw new Error(error.message);
      }
      setFieldModal(null);
      await load();
    } catch (err: any) {
      setFieldError(err.message || "Failed to save this field.");
    } finally {
      setFieldSaving(false);
    }
  };

  const handleArchiveField = async (field: LogField) => {
    try {
      const { error } = await supabase
        .from("log_fields")
        .update({ archived_at: field.archived_at ? null : new Date().toISOString() })
        .eq("id", field.id);
      if (error) throw new Error(error.message);
      await load();
    } catch (err: any) {
      setLoadError(err.message || "Failed to update this field.");
    }
  };

  const handleMoveField = async (field: LogField, direction: "up" | "down") => {
    const siblings = (fieldsByType.get(field.log_type_id) ?? [])
      .filter((f) => !f.archived_at)
      .sort((a, b) => a.sort_order - b.sort_order);
    const idx = siblings.findIndex((f) => f.id === field.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return;
    const other = siblings[swapIdx];
    try {
      await Promise.all([
        supabase.from("log_fields").update({ sort_order: other.sort_order }).eq("id", field.id),
        supabase.from("log_fields").update({ sort_order: field.sort_order }).eq("id", other.id),
      ]);
      await load();
    } catch (err: any) {
      setLoadError(err.message || "Failed to reorder fields.");
    }
  };

  const toggleScheduleDay = (day: WeekdayKey) => {
    if (!typeModal) return;
    const has = typeModal.schedule_days.includes(day);
    setTypeModal({
      ...typeModal,
      schedule_days: has
        ? typeModal.schedule_days.filter((d) => d !== day)
        : [...typeModal.schedule_days, day],
    });
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-4">
        <div>
          <Link
            href="/compliance/logs"
            className="mb-1 inline-block text-[11px] font-medium text-emerald-700 underline"
          >
            ← Back to Logs
          </Link>
          <h1 className="text-2xl font-semibold text-zinc-900">Log Templates</h1>
          <p className="text-sm text-black">
            Create and edit log types and their fields. Editing a template never changes past
            entries — each one keeps a snapshot of the template as it was when submitted.
          </p>
        </div>

        {loadError && (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <section className="rounded-md border border-zinc-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-900">Log types</h2>
              <button
                type="button"
                onClick={handleNewType}
                className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700"
              >
                New
              </button>
            </div>
            {loading ? (
              <p className="text-xs text-black">Loading…</p>
            ) : (
              <div className="space-y-1">
                {sortedTypes.map((logType) => (
                  <button
                    key={logType.id}
                    type="button"
                    onClick={() => setSelectedId(logType.id)}
                    className={`block w-full rounded-md px-2 py-1.5 text-left text-xs ${
                      selectedId === logType.id
                        ? "bg-emerald-600 text-white"
                        : "text-black hover:bg-zinc-50"
                    }`}
                  >
                    {logType.name}
                    {logType.archived_at && (
                      <span className="ml-1.5 text-[10px] opacity-75">(archived)</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-4">
            {!selectedType ? (
              <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs text-black">
                Select a log type on the left, or create a new one.
              </div>
            ) : (
              <>
                <div className="rounded-md border border-zinc-200 bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-zinc-900">{selectedType.name}</h2>
                      <p className="text-xs text-zinc-600">
                        /compliance/logs/{selectedType.slug} · {formatScheduleSummary(selectedType)}
                        {selectedType.include_in_release_check ? " · In release check" : ""}
                        {selectedType.special_type === "receiving" ? " · Receiving (special form)" : ""}
                      </p>
                      {selectedType.description && (
                        <p className="mt-1 text-xs text-zinc-600">{selectedType.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleEditType(selectedType)}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleArchiveType(selectedType)}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                      >
                        {selectedType.archived_at ? "Restore" : "Archive"}
                      </button>
                      <Link
                        href={`/compliance/logs/${selectedType.slug}`}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                      >
                        View entries
                      </Link>
                    </div>
                  </div>
                </div>

                <div className="rounded-md border border-zinc-200 bg-white p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-zinc-900">Fields</h3>
                    <button
                      type="button"
                      onClick={handleNewField}
                      className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700"
                    >
                      Add field
                    </button>
                  </div>
                  {selectedFields.length === 0 ? (
                    <p className="text-xs text-black">No fields yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full border-collapse text-left text-xs">
                        <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                          <tr>
                            <th className="px-2 py-1.5 font-medium">Order</th>
                            <th className="px-2 py-1.5 font-medium">Label</th>
                            <th className="px-2 py-1.5 font-medium">Type</th>
                            <th className="px-2 py-1.5 font-medium">Required</th>
                            <th className="px-2 py-1.5 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...selectedFields]
                            .sort((a, b) => a.sort_order - b.sort_order)
                            .map((field) => (
                              <tr key={field.id} className="border-b border-zinc-100">
                                <td className="px-2 py-1.5">
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => handleMoveField(field, "up")}
                                      className="rounded border border-zinc-300 px-1 text-zinc-700 hover:bg-zinc-50"
                                      aria-label="Move up"
                                    >
                                      ↑
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleMoveField(field, "down")}
                                      className="rounded border border-zinc-300 px-1 text-zinc-700 hover:bg-zinc-50"
                                      aria-label="Move down"
                                    >
                                      ↓
                                    </button>
                                  </div>
                                </td>
                                <td className="px-2 py-1.5 text-zinc-900">
                                  {field.label}
                                  {field.archived_at && (
                                    <span className="ml-1.5 text-[10px] text-zinc-500">(archived)</span>
                                  )}
                                </td>
                                <td className="px-2 py-1.5 text-zinc-700">
                                  {LOG_FIELD_TYPES.find((t) => t.value === field.field_type)?.label ?? field.field_type}
                                </td>
                                <td className="px-2 py-1.5 text-zinc-700">{field.required ? "Yes" : "No"}</td>
                                <td className="px-2 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleEditField(field)}
                                      className="text-emerald-700 underline"
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleArchiveField(field)}
                                      className="text-zinc-700 underline"
                                    >
                                      {field.archived_at ? "Restore" : "Archive"}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-zinc-500">
                    Fields are archived, never hard-deleted, once they&apos;ve shipped as part of a
                    template — past entries keep their own snapshot either way.
                  </p>
                </div>
              </>
            )}
          </section>
        </div>

        {typeModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">
                {typeModal.id ? "Edit Log Type" : "New Log Type"}
              </h2>
              <div className="mt-4 max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Name</label>
                  <input
                    value={typeModal.name}
                    onChange={(e) =>
                      setTypeModal({
                        ...typeModal,
                        name: e.target.value,
                        slug: typeModal.id ? typeModal.slug : slugify(e.target.value),
                      })
                    }
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Slug (used in the URL)</label>
                  <input
                    value={typeModal.slug}
                    onChange={(e) => setTypeModal({ ...typeModal, slug: slugify(e.target.value) })}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Description (optional)</label>
                  <textarea
                    value={typeModal.description}
                    onChange={(e) => setTypeModal({ ...typeModal, description: e.target.value })}
                    rows={2}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Linked SOP (optional)</label>
                  <select
                    value={typeModal.linked_sop_id}
                    onChange={(e) => setTypeModal({ ...typeModal, linked_sop_id: e.target.value })}
                    className={inputClassName}
                  >
                    <option value="">None</option>
                    {sops.map((sop) => (
                      <option key={sop.id} value={sop.id}>
                        {sop.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Schedule</label>
                  <select
                    value={typeModal.schedule_type}
                    onChange={(e) => setTypeModal({ ...typeModal, schedule_type: e.target.value as ScheduleType })}
                    className={inputClassName}
                  >
                    <option value="none">None</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="per_cycle">Per production cycle</option>
                  </select>
                </div>
                {typeModal.schedule_type === "daily" && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-800">Days</label>
                    <div className="flex flex-wrap gap-2">
                      {WEEKDAY_KEYS.map((day) => (
                        <button
                          key={day}
                          type="button"
                          onClick={() => toggleScheduleDay(day)}
                          className={`rounded-md border px-2 py-1 text-xs font-medium ${
                            typeModal.schedule_days.includes(day)
                              ? "border-emerald-600 bg-emerald-600 text-white"
                              : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
                          }`}
                        >
                          {WEEKDAY_LABELS[day]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-1.5 text-xs text-black">
                  <input
                    type="checkbox"
                    checked={typeModal.include_in_release_check}
                    onChange={(e) => setTypeModal({ ...typeModal, include_in_release_check: e.target.checked })}
                    className="h-3.5 w-3.5"
                  />
                  Include in the release-warnings check on Complete Production
                </label>
                {typeError && (
                  <p className="text-xs text-red-600" role="alert">
                    {typeError}
                  </p>
                )}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setTypeModal(null)}
                  disabled={typeSaving}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveType}
                  disabled={typeSaving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {typeSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}

        {fieldModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">
                {fieldModal.id ? "Edit Field" : "Add Field"}
              </h2>
              <div className="mt-4 max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Label</label>
                  <input
                    value={fieldModal.label}
                    onChange={(e) => setFieldModal({ ...fieldModal, label: e.target.value })}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">
                    Key {fieldModal.id ? "(fixed once created)" : "(auto from label, editable)"}
                  </label>
                  <input
                    value={fieldModal.key}
                    disabled={!!fieldModal.id}
                    onChange={(e) => setFieldModal({ ...fieldModal, key: e.target.value })}
                    placeholder={slugify(fieldModal.label)}
                    className={`${inputClassName} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Field type</label>
                  <select
                    value={fieldModal.field_type}
                    disabled={!!fieldModal.id}
                    onChange={(e) => setFieldModal({ ...fieldModal, field_type: e.target.value as LogFieldType })}
                    className={`${inputClassName} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                  >
                    {LOG_FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {fieldModal.id && (
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Type can&apos;t change once a field exists — past entries rely on its shape.
                    </p>
                  )}
                </div>
                {(fieldModal.field_type === "select" || fieldModal.field_type === "checklist") && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-800">Options (one per line)</label>
                    <textarea
                      value={fieldModal.optionsText}
                      onChange={(e) => setFieldModal({ ...fieldModal, optionsText: e.target.value })}
                      rows={4}
                      className={inputClassName}
                    />
                  </div>
                )}
                {fieldModal.field_type === "number" && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-800">Min</label>
                      <input
                        value={fieldModal.min_value}
                        onChange={(e) => setFieldModal({ ...fieldModal, min_value: e.target.value })}
                        className={inputClassName}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-800">Max</label>
                      <input
                        value={fieldModal.max_value}
                        onChange={(e) => setFieldModal({ ...fieldModal, max_value: e.target.value })}
                        className={inputClassName}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-800">Unit</label>
                      <input
                        value={fieldModal.unit}
                        onChange={(e) => setFieldModal({ ...fieldModal, unit: e.target.value })}
                        className={inputClassName}
                      />
                    </div>
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Help text (optional)</label>
                  <input
                    value={fieldModal.help_text}
                    onChange={(e) => setFieldModal({ ...fieldModal, help_text: e.target.value })}
                    className={inputClassName}
                  />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-black">
                  <input
                    type="checkbox"
                    checked={fieldModal.required}
                    onChange={(e) => setFieldModal({ ...fieldModal, required: e.target.checked })}
                    className="h-3.5 w-3.5"
                  />
                  Required
                </label>
                {fieldError && (
                  <p className="text-xs text-red-600" role="alert">
                    {fieldError}
                  </p>
                )}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setFieldModal(null)}
                  disabled={fieldSaving}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveField}
                  disabled={fieldSaving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {fieldSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
