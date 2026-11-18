"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { Badge, ConfirmDialog, Dialog, btn, btnPrimary, card, errorBox, fmtDate, input, warnBox } from "@/components/growth/GrowthUi";
import { LeadEditor, LogActivityDialog, categoryLabel, outcomeLabel, touch, typeLabel } from "@/components/growth/ProspectingForms";
import { convertLeadApi, fetchLead, fetchProspecting, tripStopsApi, updateLeadApi, voidActivityApi, type ConvertResult } from "@/lib/growth/client";
import { LEAD_STATUS_LABEL, addressLine, mapsPlaceUrl } from "@/lib/growth/prospecting";
import type { AssignableEmployee } from "@/lib/growth/employees";
import type { Lead, LeadActivity, Trip } from "@/lib/growth/prospectingService";

export default function LeadPage() {
  return (
    <AuthGuard>
      <LeadInner />
    </AuthGuard>
  );
}

type Data = { lead: Lead; activities: LeadActivity[]; trips: Trip[]; retailer: { id: string; name: string } | null; is_admin: boolean };

function LeadInner() {
  const { user } = useSupabase();
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Data | null>(null);
  const [employees, setEmployees] = useState<AssignableEmployee[]>([]);
  const [openTrips, setOpenTrips] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [tripOpen, setTripOpen] = useState(false);
  const [voiding, setVoiding] = useState<LeadActivity | null>(null);
  const [convert, setConvert] = useState<ConvertResult | "ask" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [lead, all] = await Promise.all([fetchLead(id), fetchProspecting()]);
      setD(lead);
      setEmployees(all.employees);
      setOpenTrips(all.trips.filter((t) => t.status === "planned"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runConvert = async (body: Record<string, unknown>) => {
    setActionError(null);
    setBusy(true);
    try {
      const r = await convertLeadApi(d!.lead.id, body);
      if (r.retailer) {
        setConvert(r);
        await load();
      } else setConvert(r);
    } catch (e) {
      setActionError((e as Error).message);
      setConvert(null);
    } finally {
      setBusy(false);
    }
  };

  if (error && !d) {
    return (
      <div className="mx-auto max-w-5xl space-y-3 text-black">
        <Link href="/growth/prospecting" className="text-xs font-medium underline">← Back to Prospecting</Link>
        <p className={errorBox} role="alert">{error}</p>
      </div>
    );
  }
  if (!d) return <p className="text-xs text-black">Loading…</p>;
  const l = d.lead;
  const addr = addressLine(l);

  return (
    <div className="mx-auto max-w-5xl space-y-4 text-black">
      <Link href="/growth/prospecting" className="text-xs font-medium underline">← Back to Prospecting</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">{l.name}</h1>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge tone={l.status === "won" ? "emerald" : l.status === "lost" ? "red" : "blue"}>{LEAD_STATUS_LABEL[l.status]}</Badge>
            <Badge>{categoryLabel(l.category)}</Badge>
            {l.archived_at && <Badge>Archived</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setLogging(true)}>Log activity</button>
          <button type="button" className={`${btn} ${touch}`} onClick={() => setTripOpen(true)} disabled={!!l.archived_at}>Add to trip</button>
          <button type="button" className={`${btn} ${touch}`} onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className={`${btn} ${touch}`} onClick={() => act(() => updateLeadApi(l.id, l.archived_at ? { restore: true } : { archive: true }))} disabled={busy}>
            {l.archived_at ? "Restore" : "Archive"}
          </button>
          {d.is_admin && !l.retailer_id && (
            <button type="button" className={`${btn} ${touch}`} onClick={() => setConvert("ask")}>Convert to retailer</button>
          )}
          {d.is_admin && (
            <Link className={`${btn} ${touch} inline-flex items-center`} href={`/fulfillment/retail/line-sheets/new?prepared_for=${encodeURIComponent(l.name)}`}>
              Line sheet
            </Link>
          )}
        </div>
      </div>
      {actionError && <p className={errorBox} role="alert">{actionError}</p>}
      {d.retailer && (
        <p className={warnBox}>
          Converted to the Retail retailer{" "}
          <Link href={`/fulfillment/retail/retailers/${d.retailer.id}`} className="font-medium underline">{d.retailer.name}</Link>.
        </p>
      )}

      <section className={`${card} grid grid-cols-1 gap-4 text-sm md:grid-cols-3`}>
        <div className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide">Store</h2>
          <p>{addr ?? "No address"}</p>
          {addr && <a href={mapsPlaceUrl(addr)} target="_blank" rel="noopener noreferrer" className="underline">Open in Maps</a>}
          {l.phone && <p><a href={`tel:${l.phone.replace(/[^\d+]/g, "")}`} className="underline">{l.phone}</a></p>}
          {l.website_url && <p><a href={l.website_url} target="_blank" rel="noopener noreferrer" className="underline">{l.website_url}</a></p>}
        </div>
        <div className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide">Contact</h2>
          <p>{l.contact_name ?? "—"}{l.contact_title ? `, ${l.contact_title}` : ""}</p>
          {l.contact_email && <p><a href={`mailto:${l.contact_email}`} className="underline">{l.contact_email}</a></p>}
          <p>Assigned: {employees.find((e) => e.id === l.assigned_account_id)?.name ?? "Nobody"}</p>
          {l.source && <p>Source: {l.source}</p>}
        </div>
        <div className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide">Follow-up</h2>
          <p>Next follow-up: {fmtDate(l.next_follow_up_date)}</p>
          {l.status === "lost" && l.lost_reason && <p>Lost: {l.lost_reason}</p>}
          {d.trips.length > 0 && (
            <p>
              Trips:{" "}
              {d.trips.map((t, i) => (
                <span key={t.id}>
                  {i > 0 && ", "}
                  <Link href={`/growth/prospecting/trips/${t.id}`} className="underline">{t.name}</Link>
                </span>
              ))}
            </p>
          )}
        </div>
        {l.notes && <p className="whitespace-pre-line md:col-span-3">{l.notes}</p>}
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold">Activity</h2>
        {d.activities.length === 0 ? (
          <p className="text-sm">Nothing logged yet.</p>
        ) : (
          <ol className="space-y-2" data-testid="activity-timeline">
            {d.activities.map((a) => (
              <li key={a.id} className={`rounded-md border border-zinc-200 p-2 text-sm ${a.voided_at ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={a.voided_at ? "line-through" : ""}>
                    <span className="font-medium">{fmtDate(a.activity_date)}</span> · {typeLabel(a.type)}
                    {a.outcome && ` · ${outcomeLabel(a.outcome)}`} · {a.by_name ?? "Unknown"}
                  </span>
                  {a.voided_at ? <Badge>Voided</Badge> : <button type="button" className={btn} onClick={() => setVoiding(a)}>Void</button>}
                </div>
                {a.summary && <p className="mt-1 whitespace-pre-line">{a.summary}</p>}
                {a.next_step && <p className="mt-1">Next step: {a.next_step}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {editing && <LeadEditor lead={l} employees={employees} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />}
      {logging && <LogActivityDialog lead={l} onClose={() => setLogging(false)} onSaved={() => { setLogging(false); void load(); }} />}
      {voiding && (
        <ConfirmDialog title="Void this activity?" confirmLabel="Void" busy={busy} error={null} onConfirm={async () => { await act(() => voidActivityApi(l.id, voiding.id)); setVoiding(null); }} onClose={() => setVoiding(null)}>
          <p>It stays in the timeline, crossed out. Activities are never deleted.</p>
        </ConfirmDialog>
      )}
      {tripOpen && <AddToTripDialog lead={l} trips={openTrips} onClose={() => setTripOpen(false)} onDone={() => { setTripOpen(false); void load(); }} />}
      {convert === "ask" && (
        <ConfirmDialog title={`Convert ${l.name} to a retailer?`} confirmLabel="Create retailer" busy={busy} error={null} onConfirm={() => runConvert({})} onClose={() => setConvert(null)}>
          <p>This creates a Retail retailer with the store&apos;s name, address, contact and website, and its notes as the description. No payment terms or prices are set. The lead is marked Won and linked to it.</p>
        </ConfirmDialog>
      )}
      {convert && convert !== "ask" && convert.needs === "confirm_not_won" && (
        <ConfirmDialog title="This lead isn't marked Won" confirmLabel="Convert anyway" busy={busy} error={null} onConfirm={() => runConvert({ confirm_not_won: true })} onClose={() => setConvert(null)}>
          <p>Converting marks it Won. Continue?</p>
        </ConfirmDialog>
      )}
      {convert && convert !== "ask" && convert.needs === "confirm_duplicate" && (
        <ConfirmDialog
          title="A retailer with this name already exists"
          confirmLabel="Create another retailer"
          busy={busy}
          error={null}
          onConfirm={() => runConvert({ confirm_not_won: true, confirm_duplicate: true })}
          onClose={() => setConvert(null)}
        >
          <p>
            <Link href={`/fulfillment/retail/retailers/${convert.existing!.id}`} className="underline">{convert.existing!.name}</Link> is already in Retail. Creating another one adds &quot;(from Prospecting)&quot; to the name.
          </p>
        </ConfirmDialog>
      )}
      {convert && convert !== "ask" && convert.retailer && (
        <Dialog title="Retailer created" onClose={() => setConvert(null)}>
          <p className="text-sm text-black">
            <Link href={`/fulfillment/retail/retailers/${convert.retailer.id}`} className="font-medium underline">Open {convert.retailer.name}</Link> to add payment terms and prices.
          </p>
        </Dialog>
      )}
    </div>
  );
}

function AddToTripDialog({ lead, trips, onClose, onDone }: { lead: Lead; trips: Trip[]; onClose: () => void; onDone: () => void }) {
  const [tripId, setTripId] = useState(trips[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Add ${lead.name} to a trip`} onClose={onClose}>
      <div className="space-y-3 text-black">
        {trips.length === 0 ? (
          <p className="text-sm">No planned trips. Create one on the Trips tab.</p>
        ) : (
          <select aria-label="Trip" value={tripId} onChange={(e) => setTripId(e.target.value)} className={`${input} ${touch}`}>
            {trips.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({fmtDate(t.trip_date)})</option>
            ))}
          </select>
        )}
        {error && <p className="text-xs text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`${btnPrimary} ${touch}`}
            disabled={!tripId}
            onClick={async () => {
              try {
                await tripStopsApi(tripId, { action: "add", lead_ids: [lead.id] });
                onDone();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Add to trip
          </button>
        </div>
      </div>
    </Dialog>
  );
}
