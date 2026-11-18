"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { Badge, Dialog, Select, TextArea, TextField, btn, btnDanger, btnPrimary, card, errorBox, fmtLongDate, infoBox, input, warnBox } from "@/components/growth/GrowthUi";
import { LogActivityDialog, touch } from "@/components/growth/ProspectingForms";
import { fetchProspecting, fetchTrip, tripStopsApi, updateTripApi, type ProspectingData } from "@/lib/growth/client";
import { LEAD_STATUS_LABEL, MAPS_MAX_WAYPOINTS, addressLine, mapsPlaceUrl, mapsRouteUrls } from "@/lib/growth/prospecting";
import type { Lead, Trip, TripStop } from "@/lib/growth/prospectingService";

export default function TripPage() {
  return (
    <AuthGuard>
      <TripInner />
    </AuthGuard>
  );
}

type Stop = TripStop & { lead: Lead };

function TripInner() {
  const { user } = useSupabase();
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [all, setAll] = useState<ProspectingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState<Stop | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([fetchTrip(id), fetchProspecting()]);
      setTrip(t.trip);
      setStops(t.stops);
      setAll(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    void load();
  }, [user, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const reorder = (ids: string[]) => {
    setStops((s) => ids.map((x) => s.find((y) => y.id === x)!));
    void act(() => tripStopsApi(id, { action: "reorder", stop_ids: ids }));
  };
  const move = (stopId: string, delta: -1 | 1) => {
    const ids = stops.map((s) => s.id);
    const i = ids.indexOf(stopId);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };
  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = stops.map((s) => s.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setDragId(null);
    reorder(ids);
  };

  const route = useMemo(() => mapsRouteUrls(stops.map((s) => ({ label: s.lead.name, address: addressLine(s.lead) }))), [stops]);

  if (error && !trip) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 text-black">
        <Link href="/growth/prospecting?tab=trips" className="text-xs font-medium underline">← Back to Trips</Link>
        <p className={errorBox} role="alert">{error}</p>
      </div>
    );
  }
  if (!trip) return <p className="text-xs text-black">Loading…</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-4 text-black">
      <Link href="/growth/prospecting?tab=trips" className="text-xs font-medium underline">← Back to Trips</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">{trip.name}</h1>
          <p className="text-sm">
            {fmtLongDate(trip.trip_date)} · <Badge tone={trip.status === "completed" ? "emerald" : trip.status === "cancelled" ? "zinc" : "blue"}>{trip.status === "planned" ? "Planned" : trip.status === "completed" ? "Completed" : "Cancelled"}</Badge>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={() => setEditing(true)}>Edit trip</button>
          {trip.status === "planned" && (
            <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => act(() => updateTripApi(trip.id, { status: "completed" }))}>Mark completed</button>
          )}
        </div>
      </div>
      {trip.notes && <p className="whitespace-pre-line text-sm">{trip.notes}</p>}
      {actionError && <p className={errorBox} role="alert">{actionError}</p>}

      <section className={`${card} space-y-2`}>
        <h2 className="text-sm font-semibold">Route</h2>
        {route.links.length === 0 ? (
          <p className="text-sm">Add stops with addresses to get a route.</p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="route-links">
            {route.links.map((r) => (
              <a key={r.url} href={r.url} target="_blank" rel="noopener noreferrer" className={`${btnPrimary} ${touch} inline-flex items-center`}>
                Open route in Google Maps{route.links.length > 1 ? ` (${r.label})` : ""}
              </a>
            ))}
          </div>
        )}
        {route.links.length > 1 && <p className="text-[11px]">Google Maps takes up to {MAPS_MAX_WAYPOINTS + 1} stops per link, so longer trips are split. Open Part 2 when you reach the end of Part 1.</p>}
        <p className="text-[11px]">Routes start from where your phone is. A phone browser without the Google Maps app shows only the first few stops, so use the app.</p>
        {route.warnings.map((w) => <p key={w} className={warnBox}>{w}</p>)}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Stops ({stops.length})</h2>
          <div className="flex gap-2">
            <button type="button" className={`${btn} ${touch}`} onClick={() => act(() => tripStopsApi(id, { action: "sort_zip" }))} disabled={stops.length < 2}>Sort by ZIP code</button>
            <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setAdding(true)}>Add stores</button>
          </div>
        </div>
        {stops.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">No stops yet.</p>
        ) : (
          <ol className="space-y-2" data-testid="trip-stops">
            {stops.map((s, i) => {
              const addr = addressLine(s.lead);
              return (
                <li
                  key={s.id}
                  draggable
                  onDragStart={() => setDragId(s.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => drop(s.id)}
                  className={`${card} space-y-2`}
                  data-testid="trip-stop"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">
                        {i + 1}. <Link href={`/growth/prospecting/leads/${s.lead.id}`} className="underline">{s.lead.name}</Link>{" "}
                        <Badge>{LEAD_STATUS_LABEL[s.lead.status]}</Badge> {s.logged_at && <Badge tone="emerald">Visit logged</Badge>}
                      </p>
                      <p className="text-sm">{addr ?? "No address"}</p>
                    </div>
                    <div className="flex gap-1">
                      <button type="button" className={`${btn} ${touch}`} aria-label={`Move ${s.lead.name} up`} onClick={() => move(s.id, -1)}>↑</button>
                      <button type="button" className={`${btn} ${touch}`} aria-label={`Move ${s.lead.name} down`} onClick={() => move(s.id, 1)}>↓</button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setLogging(s)}>Log visit</button>
                    {addr && <a href={mapsPlaceUrl(addr)} target="_blank" rel="noopener noreferrer" className={`${btn} ${touch} inline-flex items-center`}>Open in Maps</a>}
                    {s.lead.phone && <a href={`tel:${s.lead.phone.replace(/[^\d+]/g, "")}`} className={`${btn} ${touch} inline-flex items-center`}>Call {s.lead.phone}</a>}
                    <button type="button" className={`${btnDanger} ${touch}`} onClick={() => act(() => tripStopsApi(id, { action: "remove", stop_id: s.id }))}>Remove</button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className="text-[11px]">Drag stops (or use ↑ ↓) to set the order. No automatic route optimization.</p>
      </section>

      {adding && all && <AddStopsDialog all={all} existing={new Set(stops.map((s) => s.lead_id))} onClose={() => setAdding(false)} onAdd={(ids) => act(() => tripStopsApi(id, { action: "add", lead_ids: ids })).then(() => setAdding(false))} />}
      {logging && (
        <LogActivityDialog lead={logging.lead} tripStopId={logging.id} visitOutcomes onClose={() => setLogging(null)} onSaved={() => { setLogging(null); void load(); }} />
      )}
      {editing && <EditTripDialog trip={trip} onClose={() => setEditing(false)} onSave={(v) => act(() => updateTripApi(trip.id, v)).then(() => setEditing(false))} />}
    </div>
  );
}

function AddStopsDialog({ all, existing, onClose, onAdd }: { all: ProspectingData; existing: Set<string>; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const [status, setStatus] = useState<"open" | "to_visit" | "follow_up" | "">("open");
  const [city, setCity] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const cities = [...new Set(all.leads.map((l) => (l.city ?? "").trim()).filter(Boolean))].sort();
  const leads = all.leads.filter(
    (l) =>
      !l.archived_at &&
      !existing.has(l.id) &&
      (status === "" || (status === "open" ? l.status === "to_visit" || l.status === "follow_up" : l.status === status)) &&
      (!city || (l.city ?? "").trim() === city),
  );
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Dialog title="Add stores to the trip" onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <div className="flex flex-wrap gap-2">
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={`${input} ${touch} w-48`}>
            <option value="open">To visit or Follow up</option>
            <option value="to_visit">To visit</option>
            <option value="follow_up">Follow up</option>
            <option value="">Any status</option>
          </select>
          <select aria-label="City" value={city} onChange={(e) => setCity(e.target.value)} className={`${input} ${touch} w-40`}>
            <option value="">All cities</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {leads.length === 0 ? (
          <p className={infoBox}>No stores match.</p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {leads.map((l) => (
              <li key={l.id}>
                <label className={`flex items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm ${touch}`}>
                  <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="h-5 w-5" />
                  <span className="font-medium">{l.name}</span>
                  <span>{[l.city, l.zip].filter(Boolean).join(" ")}</span>
                  <span className="ml-auto">{LEAD_STATUS_LABEL[l.status]}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={onClose}>Cancel</button>
          <button type="button" className={`${btnPrimary} ${touch}`} disabled={picked.size === 0} onClick={() => onAdd([...picked])}>
            Add {picked.size || ""} store{picked.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function EditTripDialog({ trip, onClose, onSave }: { trip: Trip; onClose: () => void; onSave: (v: Record<string, string>) => void }) {
  const [v, setV] = useState({ name: trip.name, trip_date: trip.trip_date, notes: trip.notes ?? "", status: trip.status as string });
  return (
    <Dialog title="Edit trip" onClose={onClose}>
      <div className="space-y-3 text-black">
        <TextField name="trip-name" label="Name" value={v.name} onChange={(x) => setV({ ...v, name: x })} required />
        <TextField name="trip-date" label="Date" type="date" value={v.trip_date} onChange={(x) => setV({ ...v, trip_date: x })} required />
        <Select name="trip-status" label="Status" value={v.status} onChange={(x) => setV({ ...v, status: x })} options={[{ value: "planned", label: "Planned" }, { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" }]} />
        <TextArea name="trip-notes" label="Notes" value={v.notes} onChange={(x) => setV({ ...v, notes: x })} />
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={onClose}>Cancel</button>
          <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => onSave(v)}>Save</button>
        </div>
      </div>
    </Dialog>
  );
}
