"use client";

/**
 * Dashboard cards for Marketing & Sales. Each is rendered (and so fetches)
 * only when the Dashboard knows the person holds its feature.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchFollowUpsDue, fetchTasksDue, type DueFollowUp, type DueTask } from "@/lib/growth/client";
import { WidgetCard, fmtDate } from "./GrowthUi";

export function LaunchTasksDueWidget() {
  const [tasks, setTasks] = useState<DueTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchTasksDue()
      .then((r) => !cancelled && setTasks(r.tasks))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <WidgetCard title="Launch tasks due" href="/growth/launches?tab=mine">
      {error && <p className="text-xs text-red-700">{error}</p>}
      {!tasks && !error && <p className="text-xs text-black">Loading…</p>}
      {tasks && tasks.length === 0 && <p className="text-xs text-black">Nothing due in the next 7 days.</p>}
      {tasks && tasks.length > 0 && (
        <ul className="divide-y divide-zinc-100 text-xs text-black" data-testid="launch-tasks-due">
          {tasks.map((t) => (
            <li key={t.id} className={`py-1.5 ${t.overdue ? "text-red-700" : ""}`}>
              <Link href={`/growth/launches/${t.launch_id}`} className="font-medium underline">
                {t.title}
              </Link>
              <div>
                {t.launch_name} · {t.overdue ? "Overdue, due" : "Due"} {fmtDate(t.due_date)}
                {t.mine ? " · Yours" : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

export function FollowUpsDueWidget() {
  const [leads, setLeads] = useState<DueFollowUp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchFollowUpsDue()
      .then((r) => !cancelled && setLeads(r.leads))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <WidgetCard title="Follow-ups due" href="/growth/prospecting?tab=follow-ups">
      {error && <p className="text-xs text-red-700">{error}</p>}
      {!leads && !error && <p className="text-xs text-black">Loading…</p>}
      {leads && leads.length === 0 && <p className="text-xs text-black">No follow-ups due.</p>}
      {leads && leads.length > 0 && (
        <ul className="divide-y divide-zinc-100 text-xs text-black" data-testid="follow-ups-due">
          {leads.map((l) => (
            <li key={l.id} className={`py-1.5 ${l.overdue ? "text-red-700" : ""}`}>
              <Link href={`/growth/prospecting/leads/${l.id}`} className="font-medium underline">
                {l.name}
              </Link>
              <div>
                {l.city ? `${l.city} · ` : ""}
                {l.overdue ? "Overdue since" : "Due"} {fmtDate(l.next_follow_up_date)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}
