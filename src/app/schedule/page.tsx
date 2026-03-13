"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";

type ScheduleEvent = {
  id: string;
  production_cycle_id: string;
  business_type: string | null;
  product_id: string | null;
  product_variant_id: string | null;
  microgreen_id: string | null;
  freeze_dryer_profile_id: string | null;
  event_type: string;
  title: string;
  start_at: string;
  end_at: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  trays: number | null;
  run_number: number | null;
  machine_number: number | null;
  status: string;
  notes: string | null;
};

export default function SchedulePage() {
  const { user, supabase } = useSupabase();
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("schedule_events")
        .select("*")
        .eq("user_id", user.id)
        .order("start_at", { ascending: true });
      if (error) setError(error.message);
      else setEvents((data || []) as ScheduleEvent[]);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const eventsByDate = useMemo(() => {
    const map: Record<string, ScheduleEvent[]> = {};
    for (const ev of events) {
      const dateKey = ev.start_at.slice(0, 10);
      if (!map[dateKey]) map[dateKey] = [];
      map[dateKey].push(ev);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Production Schedule
          </h1>
          <p className="text-sm text-zinc-600">
            View grow, harvest, freeze-dryer, and packaging events generated for
            your production cycles. Events are grouped by date.
          </p>
        </header>

        {isLoading ? (
          <p className="text-sm text-black">Loading schedule…</p>
        ) : error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : events.length === 0 ? (
          <p className="text-sm text-black">
            No scheduled events yet. Generate a schedule from a production cycle
            planner to see tasks appear here.
          </p>
        ) : (
          <section className="space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <h2 className="text-sm font-semibold text-zinc-900">
              Agenda view (by date)
            </h2>
            <div className="max-h-[36rem] space-y-4 overflow-y-auto">
              {eventsByDate.map(([dateKey, dayEvents]) => (
                <div key={dateKey}>
                  <div className="mb-1.5 text-[11px] font-semibold text-zinc-700">
                    {formatDate(dateKey)}
                  </div>
                  <div className="space-y-2">
                    {dayEvents.map((ev) => (
                      <div
                        key={ev.id}
                        className="rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                      >
                        <div
                          className="flex cursor-pointer items-start justify-between"
                          onClick={() =>
                            setExpandedId(expandedId === ev.id ? null : ev.id)
                          }
                        >
                          <div>
                            <div className="text-[11px] font-semibold text-zinc-900">
                              {ev.title}
                            </div>
                            <div className="text-[11px] text-zinc-600">
                              <span className="capitalize">{ev.event_type}</span>
                              {ev.trays != null && ` · Trays: ${ev.trays}`}
                              {ev.quantity != null && ev.quantity_unit && ` · ${ev.quantity} ${ev.quantity_unit}`}
                              {ev.machine_number != null && ` · Machine #${ev.machine_number}`}
                              {ev.run_number != null && ` · Run #${ev.run_number}`}
                            </div>
                            <div className="mt-0.5 text-[10px] text-zinc-500">
                              Status:{" "}
                              <span className="capitalize">{ev.status || "planned"}</span>
                            </div>
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              ev.status === "infeasible"
                                ? "bg-red-100 text-red-700"
                                : ev.status === "warning"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-emerald-100 text-emerald-700"
                            }`}
                          >
                            {ev.event_type}
                          </span>
                        </div>
                        {expandedId === ev.id && (
                          <div className="mt-2 border-t border-zinc-200 pt-2 text-[10px] text-zinc-600">
                            {ev.business_type && (
                              <div>Business: {ev.business_type}</div>
                            )}
                            {ev.quantity != null && ev.quantity_unit && (
                              <div>
                                Quantity: {ev.quantity} {ev.quantity_unit}
                              </div>
                            )}
                            {ev.trays != null && <div>Trays: {ev.trays}</div>}
                            {ev.notes && <div>Notes: {ev.notes}</div>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </AuthGuard>
  );
}
