"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { Badge, Checkbox, Dialog, ErrorSummary, TextArea, TextField, UrlTabs, btn, btnPrimary, card, errorBox, fmtDate, input } from "@/components/growth/GrowthUi";
import { LeadEditor, LogActivityDialog, STATUS_OPTIONS, categoryLabel, touch } from "@/components/growth/ProspectingForms";
import { createLeadApi, createTripApi, fetchProspecting, saveGoalApi, updateLeadApi, type GrowthApiError, type ProspectingData } from "@/lib/growth/client";
import { LEAD_STATUSES, LEAD_STATUS_LABEL, type LeadStatus } from "@/lib/growth/prospecting";
import { LEAD_CATEGORIES } from "@/lib/growth/prospectingConstants";
import type { LeadListRow } from "@/lib/growth/prospectingService";

type Tab = "leads" | "trips" | "follow-ups";

export default function ProspectingPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <ProspectingInner />
      </Suspense>
    </AuthGuard>
  );
}

function ProspectingInner() {
  const { user } = useSupabase();
  const params = useSearchParams();
  const tab = (["trips", "follow-ups"].includes(params.get("tab") ?? "") ? params.get("tab") : "leads") as Tab;
  const [data, setData] = useState<ProspectingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "">("");

  const load = useCallback(async () => {
    try {
      const next = await fetchProspecting();
      setData(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    void load();
  }, [user, load]);

  const goalText = data?.settings.goal_retailers
    ? `Won ${data.goal.won} of ${data.settings.goal_retailers}${data.settings.goal_date ? ` by ${fmtDate(data.settings.goal_date)}` : ""}`
    : "No goal set";

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div>
        <h1 className="text-2xl font-semibold text-black">Retail Prospecting</h1>
        <p className="text-sm text-black">Stores to visit, what happened, and when to follow up.</p>
      </div>
      {error && <p className={errorBox} role="alert">{error}</p>}
      {actionError && <p className={errorBox} role="alert">{actionError}</p>}
      {!data && !error && <p className="text-xs text-black">Loading…</p>}
      {data && (
        <section className={`${card} grid grid-cols-1 gap-3 md:grid-cols-[14rem_1fr_10rem]`} data-testid="prospecting-summary">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide">Goal</p>
            <p className="font-semibold" data-testid="goal-text">{goalText}</p>
            {data.goal.percent !== null && (
              <>
                <div className="mt-1 h-2 rounded bg-zinc-200" aria-hidden="true">
                  <div className="h-2 rounded bg-emerald-600" style={{ width: `${data.goal.percent}%` }} />
                </div>
                <p className="text-[11px]">
                  {data.goal.percent}% {data.goal.daysRemaining !== null ? `· ${data.goal.daysRemaining >= 0 ? `${data.goal.daysRemaining} days left` : `${-data.goal.daysRemaining} days past the date`}` : ""}
                </p>
              </>
            )}
            <button type="button" className="mt-1 text-xs font-medium underline" onClick={() => setGoalOpen(true)}>Set goal</button>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide">Funnel (tap to filter)</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {LEAD_STATUSES.map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => setStatusFilter(statusFilter === s ? "" : s)}
                  aria-pressed={statusFilter === s}
                  className={`rounded-md border px-2 py-1 text-xs ${touch} inline-flex items-center ${statusFilter === s ? "border-emerald-600 bg-emerald-50" : "border-zinc-200 bg-white"}`}
                  data-testid={`funnel-${s}`}
                >
                  {LEAD_STATUS_LABEL[s]}: <span className="ml-1 font-semibold">{data.funnel[s] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide">Follow-ups due</p>
            <Link href="/growth/prospecting?tab=follow-ups" className="text-2xl font-semibold underline" data-testid="follow-ups-count">{data.followUps.length}</Link>
          </div>
        </section>
      )}
      <UrlTabs base="/growth/prospecting" current={tab} tabs={[{ key: "leads", label: "Leads" }, { key: "trips", label: "Trips" }, { key: "follow-ups", label: "Follow-ups" }]} />
      {data && tab === "leads" && <LeadsTab data={data} statusFilter={statusFilter} setStatusFilter={setStatusFilter} reload={load} setActionError={setActionError} />}
      {data && tab === "trips" && <TripsTab data={data} />}
      {data && tab === "follow-ups" && <FollowUpsTab data={data} reload={load} />}
      {goalOpen && data && <GoalDialog data={data} onClose={() => setGoalOpen(false)} onSaved={() => { setGoalOpen(false); void load(); }} />}
    </div>
  );
}

function LeadsTab({
  data,
  statusFilter,
  setStatusFilter,
  reload,
  setActionError,
}: {
  data: ProspectingData;
  statusFilter: LeadStatus | "";
  setStatusFilter: (s: LeadStatus | "") => void;
  reload: () => Promise<void>;
  setActionError: (s: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [city, setCity] = useState("");
  const [assigned, setAssigned] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<LeadListRow | "new" | null>(null);
  const [quick, setQuick] = useState({ name: "", address: "", phone: "", notes: "", category: "other" });
  const [quickError, setQuickError] = useState<string | null>(null);
  const cities = useMemo(() => [...new Set(data.leads.map((l) => (l.city ?? "").trim()).filter(Boolean))].sort(), [data.leads]);
  const rows = data.leads.filter((l) => {
    if (!!l.archived_at !== archived) return false;
    if (statusFilter && l.status !== statusFilter) return false;
    if (category && l.category !== category) return false;
    if (city && (l.city ?? "").trim() !== city) return false;
    if (assigned && (assigned === "none" ? l.assigned_account_id : l.assigned_account_id !== assigned)) return false;
    if (dueOnly && !l.follow_up_due) return false;
    const s = q.trim().toLowerCase();
    return !s || [l.name, l.city, l.contact_name, l.address_line1].some((x) => (x ?? "").toLowerCase().includes(s));
  });

  const quickAdd = async () => {
    setQuickError(null);
    try {
      // Quick add: "street, city, state zip" is split only on commas; anything else goes in the street line.
      const parts = quick.address.split(",").map((x) => x.trim()).filter(Boolean);
      const [line1, cityPart, stateZip] = [parts[0] ?? "", parts[1] ?? "", parts.slice(2).join(" ")];
      const m = /^([A-Za-z]{2})\s*(\d{5}(-\d{4})?)?$/.exec(stateZip.trim());
      await createLeadApi({
        name: quick.name,
        category: quick.category,
        phone: quick.phone,
        notes: quick.notes,
        address_line1: line1,
        city: cityPart,
        state: m ? m[1].toUpperCase() : stateZip,
        zip: m?.[2] ?? "",
      });
      setQuick({ name: "", address: "", phone: "", notes: "", category: quick.category });
      await reload();
    } catch (e) {
      setQuickError((e as GrowthApiError).fields?.name ?? (e as Error).message);
    }
  };
  const [lostFor, setLostFor] = useState<LeadListRow | null>(null);
  const [lostReason, setLostReason] = useState("");
  const setStatus = async (l: LeadListRow, status: string, reason?: string) => {
    setActionError(null);
    if (status === "lost" && !l.lost_reason && !reason) {
      setLostReason("");
      setLostFor(l);
      return;
    }
    try {
      await updateLeadApi(l.id, reason ? { status, lost_reason: reason } : { status });
      setLostFor(null);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <section className="space-y-3">
      <div className={`${card} space-y-2`}>
        <h2 className="text-sm font-semibold">Quick add</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1.5fr_10rem_10rem_1fr_auto]">
          <input aria-label="Store name" placeholder="Store name" value={quick.name} onChange={(e) => setQuick({ ...quick, name: e.target.value })} className={`${input} ${touch}`} />
          <input aria-label="Address" placeholder="Street, City, ST 12345" value={quick.address} onChange={(e) => setQuick({ ...quick, address: e.target.value })} className={`${input} ${touch}`} />
          <input aria-label="Phone" type="tel" placeholder="Phone" value={quick.phone} onChange={(e) => setQuick({ ...quick, phone: e.target.value })} className={`${input} ${touch}`} />
          <select aria-label="Category" value={quick.category} onChange={(e) => setQuick({ ...quick, category: e.target.value })} className={`${input} ${touch}`}>
            {LEAD_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <input aria-label="Notes" placeholder="Notes" value={quick.notes} onChange={(e) => setQuick({ ...quick, notes: e.target.value })} className={`${input} ${touch}`} />
          <button type="button" className={`${btnPrimary} ${touch}`} onClick={quickAdd}>Add</button>
        </div>
        {quickError && <p className="text-[11px] text-red-700">{quickError}</p>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <input aria-label="Search stores" placeholder="Search stores" value={q} onChange={(e) => setQ(e.target.value)} className={`${input} ${touch} w-56`} />
        <select aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "")} className={`${input} ${touch} w-40`}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select aria-label="Category filter" value={category} onChange={(e) => setCategory(e.target.value)} className={`${input} ${touch} w-40`}>
          <option value="">All categories</option>
          {LEAD_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select aria-label="City" value={city} onChange={(e) => setCity(e.target.value)} className={`${input} ${touch} w-36`}>
          <option value="">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select aria-label="Assigned" value={assigned} onChange={(e) => setAssigned(e.target.value)} className={`${input} ${touch} w-40`}>
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {data.employees.map((x) => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </select>
        <Checkbox name="due" label="Follow-up due" checked={dueOnly} onChange={setDueOnly} />
        <Checkbox name="archived" label="Show archived" checked={archived} onChange={setArchived} />
        <button type="button" className={`${btn} ${touch} ml-auto`} onClick={() => setEditing("new")}>Add with all details</button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">{data.leads.length === 0 ? "No stores yet. Add one above." : "No stores match."}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-sm text-black" data-testid="leads-table">
            <thead className="bg-zinc-50 text-xs">
              <tr>
                {["Store", "Category", "City", "Status", "Contact", "Next follow-up", "Assigned", "Last activity"].map((h) => (
                  <th key={h} className="px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className={`border-t border-zinc-100 align-top ${l.follow_up_due ? "bg-amber-50" : ""}`} data-testid="lead-row">
                  <td className="px-3 py-2">
                    <Link href={`/growth/prospecting/leads/${l.id}`} className="font-medium text-black underline">{l.name}</Link>
                    {l.retailer_id && <span className="ml-1"><Badge tone="emerald">Retailer</Badge></span>}
                    {l.phone && <div><a href={`tel:${l.phone.replace(/[^\d+]/g, "")}`} className="text-xs underline">{l.phone}</a></div>}
                  </td>
                  <td className="px-3 py-2">{categoryLabel(l.category)}</td>
                  <td className="px-3 py-2">{l.city ?? "—"}</td>
                  <td className="px-3 py-2">
                    <select aria-label={`Status of ${l.name}`} value={l.status} onChange={(e) => setStatus(l, e.target.value)} className={`${input} ${touch} w-36`}>
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">{l.contact_name ?? "—"}</td>
                  <td className="px-3 py-2">{fmtDate(l.next_follow_up_date)}</td>
                  <td className="px-3 py-2">{l.assigned_name ?? "—"}</td>
                  <td className="px-3 py-2">{fmtDate(l.last_activity_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lostFor && (
        <Dialog title={`Why was ${lostFor.name} lost?`} onClose={() => setLostFor(null)}>
          <div className="space-y-3 text-black">
            <TextField name="lost-reason" label="Reason" value={lostReason} onChange={setLostReason} required />
            <div className="flex justify-end gap-2">
              <button type="button" className={`${btn} ${touch}`} onClick={() => setLostFor(null)}>Cancel</button>
              <button type="button" className={`${btnPrimary} ${touch}`} disabled={!lostReason.trim()} onClick={() => setStatus(lostFor, "lost", lostReason.trim())}>Mark lost</button>
            </div>
          </div>
        </Dialog>
      )}
      {editing && (
        <LeadEditor
          lead={editing === "new" ? null : editing}
          employees={data.employees}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function TripsTab({ data }: { data: ProspectingData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ name: "", trip_date: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = async () => {
    try {
      const r = await createTripApi(v);
      router.push(`/growth/prospecting/trips/${r.trip.id}`);
    } catch (e) {
      setErrors((e as GrowthApiError).fields ?? { form: (e as Error).message });
    }
  };
  return (
    <section className="space-y-3">
      <div className="flex justify-end">
        <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setOpen(true)}>New trip</button>
      </div>
      {data.trips.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">No trips yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
          {data.trips.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm">
              <Link href={`/growth/prospecting/trips/${t.id}`} className="font-medium underline">{t.name}</Link>
              <span>
                {fmtDate(t.trip_date)} · {t.stops} stop{t.stops === 1 ? "" : "s"} · <Badge tone={t.status === "completed" ? "emerald" : t.status === "cancelled" ? "zinc" : "blue"}>{t.status === "planned" ? "Planned" : t.status === "completed" ? "Completed" : "Cancelled"}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Dialog title="New trip" onClose={() => setOpen(false)}>
          <div className="space-y-3 text-black">
            <ErrorSummary message={errors.form ?? null} errors={{}} />
            <TextField name="trip-name" label="Name" value={v.name} onChange={(x) => setV({ ...v, name: x })} required error={errors.name} />
            <TextField name="trip-date" label="Date" type="date" value={v.trip_date} onChange={(x) => setV({ ...v, trip_date: x })} required error={errors.trip_date} />
            <TextArea name="trip-notes" label="Notes" value={v.notes} onChange={(x) => setV({ ...v, notes: x })} />
            <div className="flex justify-end gap-2">
              <button type="button" className={`${btn} ${touch}`} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className={`${btnPrimary} ${touch}`} onClick={create}>Create trip</button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function FollowUpsTab({ data, reload }: { data: ProspectingData; reload: () => Promise<void> }) {
  const [logging, setLogging] = useState<LeadListRow | null>(null);
  const byId = new Map(data.leads.map((l) => [l.id, l]));
  const due = data.followUps.map((id) => byId.get(id)!).filter(Boolean);
  return (
    <section className="space-y-2">
      {due.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">No follow-ups due.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white" data-testid="follow-ups">
          {due.map((l) => {
            const overdue = l.next_follow_up_date! < data.today;
            return (
              <li key={l.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm ${overdue ? "bg-red-50" : ""}`}>
                <span>
                  <Link href={`/growth/prospecting/leads/${l.id}`} className="font-medium underline">{l.name}</Link>
                  {l.city ? ` · ${l.city}` : ""} · {LEAD_STATUS_LABEL[l.status]}
                  <span className={`ml-2 ${overdue ? "font-semibold text-red-700" : ""}`}>{overdue ? "Overdue since" : "Due"} {fmtDate(l.next_follow_up_date)}</span>
                </span>
                <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setLogging(l)}>Log activity</button>
              </li>
            );
          })}
        </ul>
      )}
      {logging && <LogActivityDialog lead={logging} defaultType="call" onClose={() => setLogging(null)} onSaved={() => { setLogging(null); void reload(); }} />}
    </section>
  );
}

function GoalDialog({ data, onClose, onSaved }: { data: ProspectingData; onClose: () => void; onSaved: () => void }) {
  const [goal, setGoal] = useState(data.settings.goal_retailers ? String(data.settings.goal_retailers) : "");
  const [date, setDate] = useState(data.settings.goal_date ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = async () => {
    try {
      await saveGoalApi({ goal_retailers: goal, goal_date: date });
      onSaved();
    } catch (e) {
      setErrors((e as GrowthApiError).fields ?? { goal_retailers: (e as Error).message });
    }
  };
  return (
    <Dialog title="Retailer goal" onClose={onClose}>
      <div className="space-y-3 text-black">
        <TextField name="goal-n" label="Retailers to win" value={goal} onChange={setGoal} inputMode="numeric" error={errors.goal_retailers} />
        <TextField name="goal-date" label="By" type="date" value={date} onChange={setDate} error={errors.goal_date} />
        <p className="text-[11px]">Progress counts leads marked Won.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={onClose}>Cancel</button>
          <button type="button" className={`${btnPrimary} ${touch}`} onClick={save}>Save goal</button>
        </div>
      </div>
    </Dialog>
  );
}
