"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { ReceivingEntryForm } from "@/components/ReceivingEntryForm";
import { formatDate } from "@/lib/date";
import { fetchActiveEmployees, type Employee } from "@/lib/employees";
import {
  activeFieldsSorted,
  buildTemplateSnapshot,
  evaluateOutOfSpec,
  type LogField,
  type LogType,
} from "@/lib/complianceLogs";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2.5 text-sm text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const labelClassName = "mb-1 block text-sm font-medium text-zinc-800";

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function NewLogEntryPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-2xl p-4 text-xs text-black">Loading…</div>}>
      <NewLogEntryPageInner />
    </Suspense>
  );
}

function NewLogEntryPageInner() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const router = useRouter();
  const searchParams = useSearchParams();
  const correctsEntryId = searchParams.get("correctsEntryId");
  const preselectRawMaterialId = searchParams.get("rawMaterialId");
  const { user, supabase } = useSupabase();

  const [logType, setLogType] = useState<LogType | null>(null);
  const [fields, setFields] = useState<LogField[]>([]);
  const [linkedSop, setLinkedSop] = useState<{ id: string; title: string } | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [sopsForFields, setSopsForFields] = useState<Array<{ id: string; title: string }>>([]);
  const [cyclesForFields, setCyclesForFields] = useState<Array<{ id: string; label: string }>>([]);
  const [rawMaterialsForFields, setRawMaterialsForFields] = useState<Array<{ id: string; name: string; unit: string }>>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [performedByEmployeeId, setPerformedByEmployeeId] = useState("");
  const [performedAt, setPerformedAt] = useState(toDatetimeLocalValue(new Date().toISOString()));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [correctiveAction, setCorrectiveAction] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !slug) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data: typeRow, error: typeError } = await supabase
          .from("log_types")
          .select("*")
          .eq("slug", slug)
          .maybeSingle();
        if (typeError) throw new Error(typeError.message);
        if (!typeRow) throw new Error("Log type not found.");
        if (cancelled) return;
        setLogType(typeRow as LogType);

        const [fieldsResult, employeesResult, sopsResult, cyclesResult, itemsResult] = await Promise.all([
          supabase.from("log_fields").select("*").eq("log_type_id", typeRow.id).is("archived_at", null).order("sort_order"),
          fetchActiveEmployees(supabase),
          supabase.from("sops").select("id, title").is("archived_at", null).order("title"),
          supabase
            .from("production_cycles")
            .select("id, start_date, end_date, harvest_date")
            .order("start_date", { ascending: false })
            .limit(100),
          supabase.from("inventory_items").select("id, name, unit").order("name"),
        ]);
        if (cancelled) return;
        if (fieldsResult.error) throw new Error(fieldsResult.error.message);
        setFields((fieldsResult.data ?? []) as LogField[]);
        setEmployees(employeesResult);
        setSopsForFields((sopsResult.data ?? []) as Array<{ id: string; title: string }>);
        setCyclesForFields(
          ((cyclesResult.data ?? []) as any[]).map((c) => ({
            id: c.id,
            label: c.harvest_date
              ? `Harvest: ${formatDate(c.harvest_date)}`
              : `${formatDate(c.start_date)} – ${formatDate(c.end_date)}`,
          })),
        );
        setRawMaterialsForFields((itemsResult.data ?? []) as Array<{ id: string; name: string; unit: string }>);

        if (typeRow.linked_sop_id) {
          const { data: sopRow } = await supabase.from("sops").select("id, title").eq("id", typeRow.linked_sop_id).maybeSingle();
          if (!cancelled) setLinkedSop(sopRow as any);
        }

        // Correction mode: prefill values from the entry being corrected.
        // performed_by/performed_at are deliberately left for fresh
        // selection — the correction is its own submission event.
        if (correctsEntryId) {
          const { data: originalEntry } = await supabase
            .from("log_entries")
            .select("values")
            .eq("id", correctsEntryId)
            .maybeSingle();
          if (!cancelled && originalEntry?.values) setValues(originalEntry.values as Record<string, unknown>);
        }
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message || "Failed to load this form.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, slug, correctsEntryId]);

  const sortedFields = useMemo(() => activeFieldsSorted(fields), [fields]);

  const setFieldValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleChecklistValue = (key: string, option: string) => {
    setValues((prev) => {
      const current = Array.isArray(prev[key]) ? (prev[key] as string[]) : [];
      const next = current.includes(option) ? current.filter((o) => o !== option) : [...current, option];
      return { ...prev, [key]: next };
    });
  };

  const handleSubmit = async () => {
    if (!logType || !user) return;
    setSubmitError(null);

    if (!performedByEmployeeId) {
      setSubmitError('"Performed by" is required.');
      return;
    }
    const employee = employees.find((e) => e.id === performedByEmployeeId);
    if (!employee) {
      setSubmitError("Selected employee not found.");
      return;
    }

    for (const field of sortedFields) {
      if (!field.required) continue;
      const v = values[field.key];
      const missing =
        v === undefined ||
        v === null ||
        v === "" ||
        (Array.isArray(v) && v.length === 0);
      if (missing) {
        setSubmitError(`"${field.label}" is required.`);
        return;
      }
    }

    if (correctsEntryId && !correctionReason.trim()) {
      setSubmitError("A correction reason is required.");
      return;
    }

    const snapshot = buildTemplateSnapshot(logType.name, fields);
    const { isOutOfSpec, details } = evaluateOutOfSpec(snapshot.fields, values);
    if (isOutOfSpec && !correctiveAction.trim()) {
      setSubmitError("This entry is out of spec — a corrective action is required before saving.");
      return;
    }

    // If this template has a production_cycle-type field, mirror its value
    // onto the entry's own production_cycle_id column — that's what the
    // per_cycle overdue check and release-warnings panel query directly,
    // without needing to inspect the jsonb values.
    const cycleField = snapshot.fields.find((f) => f.field_type === "production_cycle");
    const productionCycleId = cycleField ? (values[cycleField.key] as string | undefined) || null : null;

    setSubmitting(true);
    try {
      const performedAtIso = new Date(performedAt).toISOString();
      const { data, error } = await supabase
        .from("log_entries")
        .insert({
          log_type_id: logType.id,
          performed_at: performedAtIso,
          performed_by_employee_id: employee.id,
          performed_by_name: employee.full_name,
          values,
          template_snapshot: snapshot,
          production_cycle_id: productionCycleId,
          is_out_of_spec: isOutOfSpec,
          out_of_spec_details: isOutOfSpec ? details : null,
          corrective_action: isOutOfSpec ? correctiveAction.trim() : null,
          corrects_entry_id: correctsEntryId || null,
          correction_reason: correctsEntryId ? correctionReason.trim() : null,
          created_by_account: user.id,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      router.push(`/compliance/logs/entries/${data.id}`);
    } catch (err: any) {
      setSubmitError(err.message || "Failed to save this entry.");
    } finally {
      setSubmitting(false);
    }
  };

  if (logType?.special_type === "receiving") {
    return (
      <AuthGuard>
        <div className="mx-auto max-w-2xl space-y-4 pb-16">
          <Link href={`/compliance/logs/${logType.slug}`} className="inline-block text-[11px] font-medium text-emerald-700 underline">
            ← Back
          </Link>
          {loading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : loadError ? (
            <p className="text-xs text-red-600" role="alert">
              {loadError}
            </p>
          ) : (
            <ReceivingEntryForm logType={logType} correctsEntryId={correctsEntryId} preselectRawMaterialId={preselectRawMaterialId} />
          )}
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="mx-auto max-w-2xl space-y-4 pb-16">
        <Link
          href={logType ? `/compliance/logs/${logType.slug}` : "/compliance/logs"}
          className="inline-block text-[11px] font-medium text-emerald-700 underline"
        >
          ← Back
        </Link>

        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        ) : logType ? (
          <>
            <div>
              <h1 className="text-2xl font-semibold text-zinc-900">
                {correctsEntryId ? `Correct ${logType.name} Entry` : `New ${logType.name} Entry`}
              </h1>
              {linkedSop && (
                <Link
                  href={`/compliance/sops/${linkedSop.id}`}
                  className="mt-1 inline-block text-xs font-medium text-emerald-700 underline"
                >
                  View SOP: {linkedSop.title}
                </Link>
              )}
            </div>

            <div className="space-y-4 rounded-md border border-zinc-200 bg-white p-4">
              {correctsEntryId && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-amber-900">
                    This creates a new entry linked to the original — the original stays visible
                    and is marked &ldquo;Corrected&rdquo;. Values below are prefilled from it.
                  </p>
                  <label className="mt-2 block text-sm font-medium text-amber-900">
                    Correction reason (required)
                  </label>
                  <textarea
                    value={correctionReason}
                    onChange={(e) => setCorrectionReason(e.target.value)}
                    rows={2}
                    className={`${inputClassName} mt-1`}
                  />
                </div>
              )}
              <div>
                <label className={labelClassName}>Performed by</label>
                <select
                  value={performedByEmployeeId}
                  onChange={(e) => setPerformedByEmployeeId(e.target.value)}
                  className={inputClassName}
                >
                  <option value="">Select…</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.full_name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-zinc-500">
                  A name selection from the roster, not a login or signature.
                </p>
              </div>

              <div>
                <label className={labelClassName}>Performed at</label>
                <input
                  type="datetime-local"
                  value={performedAt}
                  onChange={(e) => setPerformedAt(e.target.value)}
                  className={inputClassName}
                />
              </div>

              {sortedFields.map((field) => (
                <div key={field.id}>
                  <label className={labelClassName}>
                    {field.label}
                    {field.required && <span className="text-red-600"> *</span>}
                    {field.unit && <span className="text-zinc-500"> ({field.unit})</span>}
                  </label>

                  {field.field_type === "text" && (
                    <input
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    />
                  )}
                  {field.field_type === "longtext" && (
                    <textarea
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      rows={3}
                      className={inputClassName}
                    />
                  )}
                  {field.field_type === "number" && (
                    <input
                      type="number"
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value === "" ? "" : Number(e.target.value))}
                      className={inputClassName}
                    />
                  )}
                  {field.field_type === "date" && (
                    <input
                      type="date"
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    />
                  )}
                  {field.field_type === "datetime" && (
                    <input
                      type="datetime-local"
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    />
                  )}
                  {field.field_type === "select" && (
                    <select
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    >
                      <option value="">Select…</option>
                      {(field.options ?? []).map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  )}
                  {field.field_type === "checklist" && (
                    <div className="space-y-2">
                      {(field.options ?? []).map((opt) => {
                        const checked = Array.isArray(values[field.key]) && (values[field.key] as string[]).includes(opt);
                        return (
                          <label key={opt} className="flex items-center gap-2 text-sm text-black">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleChecklistValue(field.key, opt)}
                              className="h-4 w-4"
                            />
                            {opt}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {field.field_type === "pass_fail" && (
                    <div className="flex gap-2">
                      {(["pass", "fail"] as const).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setFieldValue(field.key, opt)}
                          className={`flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
                            values[field.key] === opt
                              ? opt === "pass"
                                ? "border-emerald-600 bg-emerald-600 text-white"
                                : "border-red-600 bg-red-600 text-white"
                              : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
                          }`}
                        >
                          {opt === "pass" ? "Pass" : "Fail"}
                        </button>
                      ))}
                    </div>
                  )}
                  {field.field_type === "yes_no" && (
                    <div className="flex gap-2">
                      {(["yes", "no"] as const).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setFieldValue(field.key, opt)}
                          className={`flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
                            values[field.key] === opt
                              ? "border-emerald-600 bg-emerald-600 text-white"
                              : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
                          }`}
                        >
                          {opt === "yes" ? "Yes" : "No"}
                        </button>
                      ))}
                    </div>
                  )}
                  {field.field_type === "employee" && (
                    <select
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    >
                      <option value="">Select…</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>
                          {emp.full_name}
                        </option>
                      ))}
                    </select>
                  )}
                  {field.field_type === "sop" && (
                    <select
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    >
                      <option value="">Select…</option>
                      {sopsForFields.map((sop) => (
                        <option key={sop.id} value={sop.id}>
                          {sop.title}
                        </option>
                      ))}
                    </select>
                  )}
                  {field.field_type === "production_cycle" && (
                    <select
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    >
                      <option value="">Select…</option>
                      {cyclesForFields.map((cycle) => (
                        <option key={cycle.id} value={cycle.id}>
                          {cycle.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {field.field_type === "raw_material" && (
                    <select
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      className={inputClassName}
                    >
                      <option value="">Select…</option>
                      {rawMaterialsForFields.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.unit})
                        </option>
                      ))}
                    </select>
                  )}

                  {field.help_text && <p className="mt-1 text-[11px] text-zinc-500">{field.help_text}</p>}
                </div>
              ))}

              {(() => {
                const snapshotPreview = buildTemplateSnapshot(logType.name, fields);
                const preview = evaluateOutOfSpec(snapshotPreview.fields, values);
                if (!preview.isOutOfSpec) return null;
                return (
                  <div className="rounded-md border border-red-300 bg-red-50 p-3">
                    <p className="text-sm font-semibold text-red-800">
                      Out of spec — this entry will be flagged.
                    </p>
                    <ul className="mt-1 list-inside list-disc text-xs text-red-700">
                      {preview.details.map((d) => (
                        <li key={d.key}>{d.label}</li>
                      ))}
                    </ul>
                    <label className="mt-2 block text-sm font-medium text-red-900">
                      Corrective action (required)
                    </label>
                    <textarea
                      value={correctiveAction}
                      onChange={(e) => setCorrectiveAction(e.target.value)}
                      rows={2}
                      className={`${inputClassName} mt-1`}
                    />
                  </div>
                );
              })()}

              {submitError && (
                <p className="text-sm text-red-600" role="alert">
                  {submitError}
                </p>
              )}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="w-full rounded-md bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Saving…" : "Save Entry"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </AuthGuard>
  );
}
