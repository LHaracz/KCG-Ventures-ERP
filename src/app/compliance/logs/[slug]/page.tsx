"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { fetchActiveEmployees, type Employee } from "@/lib/employees";
import { isLateEntry, supersedingEntryId, type LogEntry, type LogEntryFile, type LogType } from "@/lib/complianceLogs";
import { generateLogEntriesPdf } from "@/lib/logEntryPdfExport";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export default function LogEntriesPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const { user, supabase } = useSupabase();

  const [logType, setLogType] = useState<LogType | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [reviewedEntryIds, setReviewedEntryIds] = useState<Set<string>>(new Set());
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [performedByFilter, setPerformedByFilter] = useState("");
  const [outOfSpecOnly, setOutOfSpecOnly] = useState(false);

  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportPdfError, setExportPdfError] = useState<string | null>(null);

  const load = async () => {
    if (!slug) return;
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
      setLogType(typeRow as LogType);

      const [entriesResult, employeesResult] = await Promise.all([
        supabase
          .from("log_entries")
          .select("*")
          .eq("log_type_id", typeRow.id)
          .order("entry_number", { ascending: false }),
        fetchActiveEmployees(supabase),
      ]);
      if (entriesResult.error) throw new Error(entriesResult.error.message);
      const entryRows = (entriesResult.data ?? []) as LogEntry[];
      setEntries(entryRows);
      setEmployees(employeesResult);

      const entryIds = entryRows.map((e) => e.id);
      if (entryIds.length) {
        const { data: reviewRows } = await supabase
          .from("log_entry_reviews")
          .select("log_entry_id")
          .in("log_entry_id", entryIds);
        setReviewedEntryIds(new Set((reviewRows ?? []).map((r: any) => r.log_entry_id)));
      } else {
        setReviewedEntryIds(new Set());
      }
    } catch (err: any) {
      setLoadError(err.message || "Failed to load this log.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, slug]);

  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (dateFrom && entry.performed_at < dateFrom) return false;
      if (dateTo && entry.performed_at > `${dateTo}T23:59:59`) return false;
      if (performedByFilter && entry.performed_by_employee_id !== performedByFilter) return false;
      if (outOfSpecOnly && !entry.is_out_of_spec) return false;
      return true;
    });
  }, [entries, dateFrom, dateTo, performedByFilter, outOfSpecOnly]);

  const keyValueSummary = (entry: LogEntry): string => {
    const fields = entry.template_snapshot?.fields ?? [];
    return fields
      .slice(0, 3)
      .map((f) => {
        const value = entry.values?.[f.key];
        if (value === undefined || value === null || value === "") return null;
        const display = Array.isArray(value) ? value.join(", ") : String(value);
        return `${f.label}: ${display}`;
      })
      .filter(Boolean)
      .join(" · ");
  };

  const handleExportCsv = () => {
    if (!logType) return;
    const allFieldKeys = Array.from(
      new Set(filteredEntries.flatMap((e) => (e.template_snapshot?.fields ?? []).map((f) => f.key))),
    );
    const fieldLabelByKey = new Map<string, string>();
    for (const entry of filteredEntries) {
      for (const f of entry.template_snapshot?.fields ?? []) fieldLabelByKey.set(f.key, f.label);
    }
    const header = [
      "Entry #",
      "Performed at",
      "Performed by",
      "Out of spec",
      "Corrective action",
      ...allFieldKeys.map((k) => fieldLabelByKey.get(k) ?? k),
    ];
    const rows = filteredEntries.map((entry) => [
      String(entry.entry_number),
      entry.performed_at,
      entry.performed_by_name,
      entry.is_out_of_spec ? "Yes" : "No",
      entry.corrective_action ?? "",
      ...allFieldKeys.map((k) => {
        const v = entry.values?.[k];
        if (v === undefined || v === null) return "";
        return Array.isArray(v) ? v.join("; ") : String(v);
      }),
    ]);
    const csv = [header, ...rows].map((row) => row.map((cell) => csvEscape(String(cell))).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${logType.slug}-entries.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPdf = async () => {
    if (!logType) return;
    setExportPdfError(null);
    setExportingPdf(true);
    try {
      const entryIds = filteredEntries.map((e) => e.id);
      let filesByEntryId = new Map<string, LogEntryFile[]>();
      if (entryIds.length) {
        const { data: fileRows, error: filesError } = await supabase
          .from("log_entry_files")
          .select("*")
          .in("log_entry_id", entryIds)
          .order("added_at");
        if (filesError) throw new Error(filesError.message);
        filesByEntryId = new Map();
        for (const file of (fileRows ?? []) as LogEntryFile[]) {
          const list = filesByEntryId.get(file.log_entry_id) ?? [];
          list.push(file);
          filesByEntryId.set(file.log_entry_id, list);
        }
      }
      const correctedEntryIds = new Set(
        filteredEntries.filter((e) => supersedingEntryId(e.id, entries) != null).map((e) => e.id),
      );
      await generateLogEntriesPdf({
        logType,
        dateFrom,
        dateTo,
        entries: filteredEntries,
        filesByEntryId,
        reviewedEntryIds,
        correctedEntryIds,
      });
    } catch (err: any) {
      setExportPdfError(err.message || "Failed to generate the PDF.");
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-4">
        <Link href="/compliance/logs" className="inline-block text-[11px] font-medium text-emerald-700 underline">
          ← Back to Logs
        </Link>

        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        ) : logType ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-2xl font-semibold text-zinc-900">{logType.name}</h1>
                {logType.description && <p className="text-sm text-black">{logType.description}</p>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={handleExportPdf}
                  disabled={exportingPdf}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {exportingPdf ? "Preparing PDF…" : "Export PDF"}
                </button>
                <Link
                  href={`/compliance/logs/${logType.slug}/new`}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
                >
                  New Entry
                </Link>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3 rounded-md border border-zinc-200 bg-white p-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-700">From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-700">To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-700">Performed by</label>
                <select
                  value={performedByFilter}
                  onChange={(e) => setPerformedByFilter(e.target.value)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
                >
                  <option value="">Anyone</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.full_name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-black">
                <input
                  type="checkbox"
                  checked={outOfSpecOnly}
                  onChange={(e) => setOutOfSpecOnly(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Out of spec only
              </label>
            </div>

            {exportPdfError && (
              <p className="text-xs text-red-600" role="alert">
                {exportPdfError}
              </p>
            )}

            <section className="rounded-md border border-zinc-200 bg-white p-4">
              {filteredEntries.length === 0 ? (
                <p className="text-xs text-black">No entries match these filters.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full border-collapse text-left text-xs">
                    <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">#</th>
                        <th className="px-2 py-1.5 font-medium">Performed</th>
                        <th className="px-2 py-1.5 font-medium">By</th>
                        <th className="px-2 py-1.5 font-medium">Key values</th>
                        <th className="px-2 py-1.5 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEntries.map((entry) => {
                        const corrected = supersedingEntryId(entry.id, entries) != null;
                        const late = isLateEntry(entry.performed_at, entry.created_at);
                        const reviewed = reviewedEntryIds.has(entry.id);
                        return (
                          <tr key={entry.id} className="border-b border-zinc-100">
                            <td className="px-2 py-1.5 text-zinc-700">
                              <Link href={`/compliance/logs/entries/${entry.id}`} className="text-emerald-700 underline">
                                #{entry.entry_number}
                              </Link>
                            </td>
                            <td className="px-2 py-1.5 text-zinc-700">{formatDate(entry.performed_at)}</td>
                            <td className="px-2 py-1.5 text-zinc-700">{entry.performed_by_name}</td>
                            <td className="px-2 py-1.5 text-zinc-700">{keyValueSummary(entry) || "—"}</td>
                            <td className="px-2 py-1.5">
                              <div className="flex flex-wrap gap-1">
                                {entry.is_out_of_spec && (
                                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                                    Out of spec
                                  </span>
                                )}
                                {late && (
                                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                                    Late entry
                                  </span>
                                )}
                                {corrected && (
                                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                                    Corrected
                                  </span>
                                )}
                                {reviewed && (
                                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                                    Reviewed
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </AuthGuard>
  );
}
