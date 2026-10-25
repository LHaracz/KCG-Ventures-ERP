"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { normalizeBusinessType } from "@/lib/businessType";
import { formatScheduleSummary, type LogEntry, type LogType } from "@/lib/complianceLogs";
import {
  computePerCycleOverdue,
  computeScheduledOverdue,
  isCycleRelevantForPerCycleCheck,
  type CycleForOverdue,
} from "@/lib/complianceOverdue";

type CycleRow = CycleForOverdue & { label: string };

export default function ComplianceLogsHubPage() {
  const { user, supabase } = useSupabase();

  const [logTypes, setLogTypes] = useState<LogType[]>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cycles, setCycles] = useState<CycleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [typesResult, entriesResult, cyclesResult] = await Promise.all([
          supabase.from("log_types").select("*").is("archived_at", null).order("name"),
          supabase
            .from("log_entries")
            .select(
              "id, log_type_id, entry_number, performed_at, performed_by_employee_id, performed_by_name, values, template_snapshot, production_cycle_id, is_out_of_spec, out_of_spec_details, corrective_action, corrects_entry_id, correction_reason, created_at, created_by_account",
            )
            .order("performed_at", { ascending: false })
            .limit(3000),
          supabase
            .from("production_cycles")
            .select("id, status, completed_at, start_date, end_date, harvest_date, business_type, brand"),
        ]);
        if (cancelled) return;
        if (typesResult.error) throw new Error(typesResult.error.message);
        if (entriesResult.error) throw new Error(entriesResult.error.message);
        if (cyclesResult.error) throw new Error(cyclesResult.error.message);

        setLogTypes((typesResult.data ?? []) as LogType[]);
        setEntries((entriesResult.data ?? []) as LogEntry[]);
        setCycles(
          ((cyclesResult.data ?? []) as any[]).map((c) => ({
            id: c.id,
            status: c.status,
            completed_at: c.completed_at,
            start_date: c.start_date,
            businessType: normalizeBusinessType(c, { defaultType: "BotanIQals" }) ?? "BotanIQals",
            label: c.harvest_date
              ? `Harvest: ${formatDate(c.harvest_date)}`
              : `${formatDate(c.start_date)} – ${formatDate(c.end_date)}`,
          })),
        );
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message || "Failed to load the Logs hub.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const entriesByType = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of entries) {
      const list = map.get(entry.log_type_id) ?? [];
      list.push(entry);
      map.set(entry.log_type_id, list);
    }
    return map;
  }, [entries]);

  const relevantCycles = useMemo(
    () => cycles.filter((c) => isCycleRelevantForPerCycleCheck(c)).map((c) => ({ ...c, label: c.label })),
    [cycles],
  );

  const cardData = useMemo(() => {
    const now = new Date();
    return logTypes.map((logType) => {
      const typeEntries = entriesByType.get(logType.id) ?? [];
      const lastEntryAt = typeEntries.length
        ? typeEntries.reduce((max, e) => (e.performed_at > max ? e.performed_at : max), typeEntries[0].performed_at)
        : null;

      let isOverdue = false;
      let overdueDetail = "";
      if (logType.schedule_type === "per_cycle") {
        const result = computePerCycleOverdue(relevantCycles, typeEntries);
        isOverdue = result.isOverdue;
        overdueDetail = result.missingForCycles.length
          ? `No entry for: ${result.missingForCycles.map((c) => c.label).join(", ")}`
          : "";
      } else if (logType.schedule_type !== "none") {
        const result = computeScheduledOverdue(logType, typeEntries, now);
        isOverdue = result.isOverdue;
        overdueDetail = result.missedPeriods.length
          ? `Missed: ${result.missedPeriods.slice(0, 3).map((p) => p.label).join(", ")}${
              result.missedPeriods.length > 3 ? `, +${result.missedPeriods.length - 3} more` : ""
            }`
          : "";
      }

      return { logType, lastEntryAt, isOverdue, overdueDetail };
    });
  }, [logTypes, entriesByType, relevantCycles]);

  const overdueCards = cardData.filter((c) => c.isOverdue);

  const recentEntries = useMemo(() => {
    const typeById = new Map(logTypes.map((t) => [t.id, t]));
    return entries.slice(0, 15).map((entry) => ({ entry, logType: typeById.get(entry.log_type_id) }));
  }, [entries, logTypes]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Compliance Logs</h1>
            <p className="text-sm text-black">
              Sanitation, equipment, receiving, batch records, training, and calibration logs.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings/employees"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Employees
            </Link>
            <Link
              href="/compliance/logs/settings"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Template Settings
            </Link>
          </div>
        </div>

        {loadError && (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        )}

        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : (
          <>
            {overdueCards.length > 0 && (
              <section className="rounded-md border border-amber-300 bg-amber-50 p-4">
                <h2 className="mb-2 text-sm font-semibold text-amber-900">
                  Overdue ({overdueCards.length})
                </h2>
                <ul className="space-y-1.5 text-xs text-amber-900">
                  {overdueCards.map(({ logType, overdueDetail, lastEntryAt }) => (
                    <li key={logType.id}>
                      <Link href={`/compliance/logs/${logType.slug}`} className="font-medium underline">
                        {logType.name}
                      </Link>
                      {overdueDetail ? ` — ${overdueDetail}` : ""}
                      {" · "}
                      Last entry: {lastEntryAt ? formatDate(lastEntryAt) : "never"}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {logTypes.length === 0 ? (
              <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs text-black">
                No log types yet.{" "}
                <Link href="/compliance/logs/settings" className="font-medium text-emerald-700 underline">
                  Create one in Template Settings
                </Link>
                .
              </section>
            ) : (
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {cardData.map(({ logType, lastEntryAt, isOverdue }) => (
                  <Link
                    key={logType.id}
                    href={`/compliance/logs/${logType.slug}`}
                    className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm hover:border-emerald-300"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-zinc-900">{logType.name}</h3>
                      {isOverdue && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                          Overdue
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-500">{formatScheduleSummary(logType)}</p>
                    <p className="mt-2 text-xs text-zinc-700">
                      Last entry: {lastEntryAt ? formatDate(lastEntryAt) : "never"}
                    </p>
                  </Link>
                ))}
              </section>
            )}

            <section className="rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">Recent entries</h2>
              {recentEntries.length === 0 ? (
                <p className="text-xs text-black">No entries yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full border-collapse text-left text-xs">
                    <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Log</th>
                        <th className="px-2 py-1.5 font-medium">Entry #</th>
                        <th className="px-2 py-1.5 font-medium">Performed</th>
                        <th className="px-2 py-1.5 font-medium">By</th>
                        <th className="px-2 py-1.5 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentEntries.map(({ entry, logType }) => (
                        <tr key={entry.id} className="border-b border-zinc-100">
                          <td className="px-2 py-1.5 text-zinc-900">{logType?.name ?? "—"}</td>
                          <td className="px-2 py-1.5 text-zinc-700">
                            <Link href={`/compliance/logs/entries/${entry.id}`} className="text-emerald-700 underline">
                              #{entry.entry_number}
                            </Link>
                          </td>
                          <td className="px-2 py-1.5 text-zinc-700">{formatDate(entry.performed_at)}</td>
                          <td className="px-2 py-1.5 text-zinc-700">{entry.performed_by_name}</td>
                          <td className="px-2 py-1.5">
                            {entry.is_out_of_spec && (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                                Out of spec
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </AuthGuard>
  );
}
