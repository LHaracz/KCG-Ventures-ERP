/**
 * Retail Prospecting server code (service role, after the route's feature
 * check): leads, their activity, trips and stops, the retailer goal, and
 * Convert to retailer (Admin only, checked by the route).
 */
import { GrowthError, idOrThrow, isUuid } from "./errors";
import { addDays, isIsoDate, todayNy } from "./dates";
import { LEAD_STATUSES, followUpDue, funnelCounts, goalProgress, type LeadStatus } from "./prospecting";
import { listAssignableEmployees } from "./employees";
import { createRetailer as createRetailRetailer, RetailError } from "@/lib/retail/service";
import type { Db } from "./routeHelpers";

import { ACTIVITY_TYPES, DEFAULT_FOLLOW_UP_DAYS, LEAD_CATEGORIES, OUTCOMES } from "./prospectingConstants";
export { ACTIVITY_TYPES, DEFAULT_FOLLOW_UP_DAYS, LEAD_CATEGORIES, OUTCOMES };

export type Lead = {
  id: string;
  name: string;
  category: string;
  status: LeadStatus;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  website_url: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  assigned_account_id: string | null;
  next_follow_up_date: string | null;
  source: string | null;
  notes: string | null;
  lost_reason: string | null;
  retailer_id: string | null;
  archived_at: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};
export type LeadActivity = {
  id: string;
  lead_id: string;
  activity_date: string;
  type: string;
  outcome: string | null;
  summary: string | null;
  next_step: string | null;
  by_name: string | null;
  voided_at: string | null;
  created_at: string;
};
export type Trip = { id: string; name: string; trip_date: string; status: "planned" | "completed" | "cancelled"; notes: string | null; created_at: string };
export type TripStop = { id: string; trip_id: string; lead_id: string; stop_order: number; logged_at: string | null };

const LEAD_COLUMNS =
  "id, name, category, status, address_line1, address_line2, city, state, zip, phone, website_url, contact_name, contact_title, contact_email, assigned_account_id, next_follow_up_date, source, notes, lost_reason, retailer_id, archived_at, created_by_name, created_at, updated_at";
const ACT_COLUMNS = "id, lead_id, activity_date, type, outcome, summary, next_step, by_name, voided_at, created_at";
const TRIP_COLUMNS = "id, name, trip_date, status, notes, created_at";
const STOP_COLUMNS = "id, trip_id, lead_id, stop_order, logged_at";

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && v ? v.slice(0, 10) : null);
const normLead = (l: Lead): Lead => ({ ...l, next_follow_up_date: iso(l.next_follow_up_date) });
const normAct = (a: LeadActivity): LeadActivity => ({ ...a, activity_date: iso(a.activity_date)! });
const normTrip = (t: Trip): Trip => ({ ...t, trip_date: iso(t.trip_date)! });

function fail(error: { message?: string; code?: string } | null, message: string): never {
  if (error?.code === "23514" || /check constraint/i.test(error?.message ?? "")) throw new GrowthError(`${message} A value is not valid.`, 400);
  throw new GrowthError(message, 500);
}

// --- Validation ------------------------------------------------------------------------------
type Errors = Record<string, string>;
const txt = (raw: Record<string, unknown>, k: string) => (raw[k] === null || raw[k] === undefined ? "" : String(raw[k]).trim());
const LEAD_TEXT: Array<[string, number, string]> = [
  ["address_line1", 200, "Address line 1"],
  ["address_line2", 200, "Address line 2"],
  ["city", 100, "City"],
  ["state", 50, "State"],
  ["zip", 20, "ZIP"],
  ["phone", 50, "Phone"],
  ["contact_name", 200, "Contact name"],
  ["contact_title", 200, "Contact title"],
  ["contact_email", 320, "Contact email"],
  ["source", 200, "Source"],
  ["notes", 4000, "Notes"],
  ["lost_reason", 500, "Reason"],
];

export function validateLead(input: unknown, opts: { partial?: boolean } = {}): { ok: true; value: Record<string, unknown> } | { ok: false; errors: Errors } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Errors = {};
  const out: Record<string, unknown> = {};
  const has = (k: string) => !opts.partial || k in raw;
  if (has("name")) {
    const n = txt(raw, "name");
    if (!n) errors.name = "Enter the store name.";
    else if (n.length > 200) errors.name = "Keep the name under 200 characters.";
    out.name = n;
  }
  if (has("category")) {
    const c = txt(raw, "category") || "other";
    if (!LEAD_CATEGORIES.some((x) => x.value === c)) errors.category = "Choose a category.";
    out.category = c;
  }
  if ("status" in raw) {
    const s = txt(raw, "status");
    if (!(LEAD_STATUSES as readonly string[]).includes(s)) errors.status = "Choose a status.";
    out.status = s;
  }
  for (const [k, max, label] of LEAD_TEXT) {
    if (!has(k)) continue;
    const v = txt(raw, k);
    if (v.length > max) errors[k] = `${label}: keep it under ${max} characters.`;
    out[k] = v || null;
  }
  if (out.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.contact_email as string)) errors.contact_email = "Enter a valid email address.";
  if (has("website_url")) {
    const w = txt(raw, "website_url");
    if (w && !/^https?:\/\/[^\s]+$/i.test(w)) errors.website_url = "Enter a full web address starting with http:// or https://.";
    out.website_url = w || null;
  }
  if (has("assigned_account_id")) {
    const a = raw.assigned_account_id;
    if (a === null || a === undefined || a === "") out.assigned_account_id = null;
    else if (!isUuid(a)) errors.assigned_account_id = "Choose someone from the list.";
    else out.assigned_account_id = a;
  }
  if (has("next_follow_up_date")) {
    const d = txt(raw, "next_follow_up_date");
    if (d && !isIsoDate(d)) errors.next_follow_up_date = "Enter a valid date.";
    out.next_follow_up_date = d || null;
  }
  if (out.status === "lost" && "lost_reason" in out && !out.lost_reason) errors.lost_reason = "Enter why the lead was lost.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

// --- Loading ---------------------------------------------------------------------------------
async function getLeadRow(db: Db, id: unknown): Promise<Lead> {
  const lid = idOrThrow(id, "lead");
  const { data, error } = await db.from("leads").select(LEAD_COLUMNS).eq("id", lid).maybeSingle();
  if (error) fail(error, "Could not load the lead.");
  if (!data) throw new GrowthError("Unknown lead.", 404);
  return normLead(data);
}

export type LeadListRow = Lead & { last_activity_date: string | null; assigned_name: string | null; follow_up_due: boolean };

export async function loadProspecting(db: Db, opts: { today?: string } = {}) {
  const today = opts.today ?? todayNy();
  const [l, a, t, s, st] = await Promise.all([
    db.from("leads").select(LEAD_COLUMNS),
    db.from("lead_activities").select("lead_id, activity_date, voided_at"),
    db.from("trips").select(TRIP_COLUMNS),
    db.from("prospecting_settings").select("goal_retailers, goal_date").maybeSingle(),
    db.from("trip_stops").select(STOP_COLUMNS),
  ]);
  for (const r of [l, a, t, s, st]) if (r.error) fail(r.error, "Could not load prospecting.");
  const employees = await listAssignableEmployees(db);
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const last = new Map<string, string>();
  for (const x of (a.data ?? []) as Array<{ lead_id: string; activity_date: string; voided_at: string | null }>) {
    if (x.voided_at) continue;
    const d = iso(x.activity_date)!;
    if (!last.has(x.lead_id) || d > last.get(x.lead_id)!) last.set(x.lead_id, d);
  }
  const leads: LeadListRow[] = ((l.data ?? []) as Lead[]).map(normLead).map((x) => ({
    ...x,
    last_activity_date: last.get(x.id) ?? null,
    assigned_name: x.assigned_account_id ? names.get(x.assigned_account_id) ?? null : null,
    follow_up_due: followUpDue(x, today),
  }));
  leads.sort((x, y) => x.name.localeCompare(y.name));
  const stops = (st.data ?? []) as TripStop[];
  const trips = ((t.data ?? []) as Trip[]).map(normTrip).map((x) => ({ ...x, stops: stops.filter((s2) => s2.trip_id === x.id).length }));
  trips.sort((x, y) => (x.trip_date < y.trip_date ? 1 : -1));
  const settings = { goal_retailers: s.data?.goal_retailers ?? null, goal_date: iso(s.data?.goal_date) };
  const active = leads.filter((x) => !x.archived_at);
  const won = active.filter((x) => x.status === "won").length;
  const followUps = active.filter((x) => x.follow_up_due).sort((x, y) => (x.next_follow_up_date! < y.next_follow_up_date! ? -1 : 1));
  return {
    today,
    leads,
    trips,
    settings,
    funnel: funnelCounts(leads),
    goal: { won, ...goalProgress({ won, goal: settings.goal_retailers, goalDate: settings.goal_date, today }) },
    followUps: followUps.map((x) => x.id),
    employees,
  };
}

/** Dashboard "Follow-ups due": the same list, overdue first, at most 10. */
export async function followUpsDue(db: Db, opts: { today?: string } = {}) {
  const today = opts.today ?? todayNy();
  const { data, error } = await db.from("leads").select("id, name, city, status, next_follow_up_date, archived_at").is("archived_at", null);
  if (error) fail(error, "Could not load follow-ups.");
  return ((data ?? []) as Array<{ id: string; name: string; city: string | null; status: string; next_follow_up_date: string | null; archived_at: string | null }>)
    .map((x) => ({ ...x, next_follow_up_date: iso(x.next_follow_up_date) }))
    .filter((x) => followUpDue(x, today))
    .sort((x, y) => x.next_follow_up_date!.localeCompare(y.next_follow_up_date!))
    .slice(0, 10)
    .map((x) => ({ id: x.id, name: x.name, city: x.city, next_follow_up_date: x.next_follow_up_date!, overdue: x.next_follow_up_date! < today }));
}

export async function loadLead(db: Db, id: unknown) {
  const lead = await getLeadRow(db, id);
  const [a, st] = await Promise.all([
    db.from("lead_activities").select(ACT_COLUMNS).eq("lead_id", lead.id),
    db.from("trip_stops").select(STOP_COLUMNS).eq("lead_id", lead.id),
  ]);
  if (a.error || st.error) fail(a.error ?? st.error, "Could not load the lead.");
  const activities = ((a.data ?? []) as LeadActivity[]).map(normAct).sort((x, y) => (x.activity_date === y.activity_date ? (x.created_at < y.created_at ? 1 : -1) : x.activity_date < y.activity_date ? 1 : -1));
  const tripIds = ((st.data ?? []) as TripStop[]).map((s) => s.trip_id);
  let trips: Trip[] = [];
  if (tripIds.length) {
    const t = await db.from("trips").select(TRIP_COLUMNS).in("id", tripIds);
    if (t.error) fail(t.error, "Could not load trips.");
    trips = ((t.data ?? []) as Trip[]).map(normTrip);
  }
  let retailer: { id: string; name: string } | null = null;
  if (lead.retailer_id) {
    const r = await db.from("retailers").select("id, name").eq("id", lead.retailer_id).maybeSingle();
    retailer = r.data ?? null;
  }
  return { lead, activities, trips, retailer };
}

// --- Leads -----------------------------------------------------------------------------------
export async function createLead(db: Db, input: unknown, actor: string | null): Promise<Lead> {
  const v = validateLead(input);
  if (!v.ok) throw new GrowthError("Some fields are missing or not valid.", 400, v.errors);
  const { data, error } = await db.from("leads").insert({ ...v.value, status: v.value.status ?? "to_visit", created_by_name: actor }).select(LEAD_COLUMNS).single();
  if (error) fail(error, "Could not add the lead.");
  return normLead(data);
}

export async function updateLead(db: Db, id: unknown, input: Record<string, unknown>): Promise<Lead> {
  const lead = await getLeadRow(db, id);
  if (input.archive === true || input.restore === true) {
    const { data, error } = await db.from("leads").update({ archived_at: input.archive === true ? new Date().toISOString() : null }).eq("id", lead.id).select(LEAD_COLUMNS).single();
    if (error) fail(error, "Could not update the lead.");
    return normLead(data);
  }
  const v = validateLead(input, { partial: true });
  if (!v.ok) throw new GrowthError("Some fields are missing or not valid.", 400, v.errors);
  if (v.value.status === "lost" && !(v.value.lost_reason ?? lead.lost_reason)) {
    throw new GrowthError("Enter why the lead was lost.", 400, { lost_reason: "Enter why the lead was lost." });
  }
  const { data, error } = await db.from("leads").update(v.value).eq("id", lead.id).select(LEAD_COLUMNS).single();
  if (error) fail(error, "Could not save the lead.");
  return normLead(data);
}

// --- Activities ------------------------------------------------------------------------------
export async function logActivity(db: Db, leadId: unknown, input: unknown, actor: string | null, opts: { tripStopId?: string | null } = {}) {
  const lead = await getLeadRow(db, leadId);
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Errors = {};
  const activity_date = txt(raw, "activity_date");
  if (!isIsoDate(activity_date)) errors.activity_date = "Enter the date.";
  const type = txt(raw, "type") || "visit";
  if (!ACTIVITY_TYPES.some((x) => x.value === type)) errors.type = "Choose a type.";
  const outcome = txt(raw, "outcome") || null;
  if (outcome && !OUTCOMES.some((x) => x.value === outcome)) errors.outcome = "Choose an outcome.";
  const summary = txt(raw, "summary");
  if (summary.length > 2000) errors.summary = "Keep the summary under 2000 characters.";
  const next_step = txt(raw, "next_step");
  if (next_step.length > 500) errors.next_step = "Keep the next step under 500 characters.";
  const follow = txt(raw, "next_follow_up_date");
  if (follow && !isIsoDate(follow)) errors.next_follow_up_date = "Enter a valid date.";
  const lost_reason = txt(raw, "lost_reason");
  if (outcome === "not_interested" && !lost_reason) errors.lost_reason = "Enter why they're not interested.";
  if (lost_reason.length > 500) errors.lost_reason = "Keep the reason under 500 characters.";
  if (Object.keys(errors).length > 0) throw new GrowthError("Some fields are missing or not valid.", 400, errors);

  const { data, error } = await db
    .from("lead_activities")
    .insert({ lead_id: lead.id, activity_date, type, outcome, summary: summary || null, next_step: next_step || null, by_name: actor })
    .select(ACT_COLUMNS)
    .single();
  if (error) fail(error, "Could not log the activity.");

  // Outcomes move the lead along; won and lost leads only change by hand.
  const patch: Record<string, unknown> = {};
  if (outcome === "not_interested") Object.assign(patch, { status: "lost", lost_reason, next_follow_up_date: null });
  else if (lead.status !== "won" && lead.status !== "lost") {
    if (outcome === "samples_left") patch.status = "samples_left";
    else if (outcome === "placing_order") patch.status = "negotiating";
    else if (outcome === "interested") patch.status = "follow_up";
    else if (lead.status === "to_visit" && (type === "visit" || outcome)) patch.status = "visited";
    patch.next_follow_up_date = follow || null;
  }
  if (Object.keys(patch).length) {
    const r = await db.from("leads").update(patch).eq("id", lead.id);
    if (r.error) fail(r.error, "Could not update the lead.");
  }
  if (opts.tripStopId) {
    const r = await db.from("trip_stops").update({ logged_at: new Date().toISOString() }).eq("id", opts.tripStopId).eq("lead_id", lead.id);
    if (r.error) fail(r.error, "Could not update the stop.");
  }
  return normAct(data);
}

export async function voidActivity(db: Db, leadId: unknown, activityId: unknown) {
  const lead = await getLeadRow(db, leadId);
  const aid = idOrThrow(activityId, "activity");
  const { data, error } = await db.from("lead_activities").update({ voided_at: new Date().toISOString() }).eq("id", aid).eq("lead_id", lead.id).select(ACT_COLUMNS).maybeSingle();
  if (error) fail(error, "Could not void the activity.");
  if (!data) throw new GrowthError("Unknown activity.", 404);
  return normAct(data);
}

// --- Convert to retailer (Admin only; the route checks) ----------------------------------------
export async function convertToRetailer(db: Db, leadId: unknown, opts: { confirmDuplicate?: boolean; confirmNotWon?: boolean }, actor: string | null) {
  const lead = await getLeadRow(db, leadId);
  if (lead.retailer_id) throw new GrowthError("This lead is already a retailer.", 409);
  if (lead.status !== "won" && !opts.confirmNotWon) return { needs: "confirm_not_won" as const };
  const dup = await db.from("retailers").select("id, name, archived_at").is("archived_at", null);
  if (dup.error) fail(dup.error, "Could not check retailers.");
  const same = ((dup.data ?? []) as Array<{ id: string; name: string }>).find((r) => r.name.trim().toLowerCase() === lead.name.trim().toLowerCase());
  if (same && !opts.confirmDuplicate) return { needs: "confirm_duplicate" as const, existing: same };
  const name = same ? `${lead.name} (from Prospecting)` : lead.name;
  let retailer;
  try {
    retailer = await createRetailRetailer(
      db,
      {
        retailer: {
          name,
          contact_name: lead.contact_name,
          contact_email: lead.contact_email,
          contact_phone: lead.phone,
          website_url: lead.website_url,
          description: lead.notes,
          billing_line1: lead.address_line1,
          billing_line2: lead.address_line2,
          billing_city: lead.city,
          billing_state: lead.state,
          billing_zip: lead.zip,
          shipping_same_as_billing: true,
        },
        terms: {},
      },
      actor,
    );
  } catch (e) {
    if (e instanceof RetailError) {
      const missing = e.fields && Object.keys(e.fields).some((k) => k.startsWith("billing_"));
      throw new GrowthError(missing ? "Add the store's full address (street, city, state, ZIP) before converting it to a retailer." : e.message, e.status, e.fields ?? undefined);
    }
    throw e;
  }
  const r = await db.from("leads").update({ retailer_id: retailer.id, status: "won", next_follow_up_date: null }).eq("id", lead.id);
  if (r.error) fail(r.error, "The retailer was created, but the lead couldn't be linked to it.");
  return { retailer: { id: retailer.id, name: retailer.name } };
}

// --- Goal --------------------------------------------------------------------------------------
export async function saveGoal(db: Db, input: Record<string, unknown>) {
  const g = txt(input, "goal_retailers");
  const d = txt(input, "goal_date");
  const errors: Errors = {};
  const n = g === "" ? null : Number(g);
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > 10000)) errors.goal_retailers = "Enter a whole number of retailers.";
  if (d && !isIsoDate(d)) errors.goal_date = "Enter a valid date.";
  if (Object.keys(errors).length) throw new GrowthError("Some fields are not valid.", 400, errors);
  const { error } = await db.from("prospecting_settings").upsert({ id: true, goal_retailers: n, goal_date: d || null }, { onConflict: "id" });
  if (error) fail(error, "Could not save the goal.");
}

// --- Trips -------------------------------------------------------------------------------------
async function getTripRow(db: Db, id: unknown): Promise<Trip> {
  const tid = idOrThrow(id, "trip");
  const { data, error } = await db.from("trips").select(TRIP_COLUMNS).eq("id", tid).maybeSingle();
  if (error) fail(error, "Could not load the trip.");
  if (!data) throw new GrowthError("Unknown trip.", 404);
  return normTrip(data);
}

function validateTrip(raw: Record<string, unknown>, partial: boolean) {
  const errors: Errors = {};
  const out: Record<string, unknown> = {};
  if (!partial || "name" in raw) {
    const n = txt(raw, "name");
    if (!n) errors.name = "Enter a trip name.";
    else if (n.length > 200) errors.name = "Keep the name under 200 characters.";
    out.name = n;
  }
  if (!partial || "trip_date" in raw) {
    const d = txt(raw, "trip_date");
    if (!isIsoDate(d)) errors.trip_date = "Enter the trip date.";
    out.trip_date = d;
  }
  if ("notes" in raw) {
    const n = txt(raw, "notes");
    if (n.length > 2000) errors.notes = "Keep notes under 2000 characters.";
    out.notes = n || null;
  }
  if ("status" in raw) {
    const s = txt(raw, "status");
    if (!["planned", "completed", "cancelled"].includes(s)) errors.status = "Choose a status.";
    out.status = s;
  }
  if (Object.keys(errors).length) throw new GrowthError("Some fields are missing or not valid.", 400, errors);
  return out;
}

export async function createTrip(db: Db, input: Record<string, unknown>, actor: string | null): Promise<Trip> {
  const v = validateTrip(input, false);
  const { data, error } = await db.from("trips").insert({ ...v, created_by_name: actor }).select(TRIP_COLUMNS).single();
  if (error) fail(error, "Could not create the trip.");
  return normTrip(data);
}

export async function updateTrip(db: Db, id: unknown, input: Record<string, unknown>): Promise<Trip> {
  const trip = await getTripRow(db, id);
  const v = validateTrip(input, true);
  const { data, error } = await db.from("trips").update(v).eq("id", trip.id).select(TRIP_COLUMNS).single();
  if (error) fail(error, "Could not save the trip.");
  return normTrip(data);
}

async function stopsOf(db: Db, tripId: string): Promise<TripStop[]> {
  const { data, error } = await db.from("trip_stops").select(STOP_COLUMNS).eq("trip_id", tripId);
  if (error) fail(error, "Could not load the stops.");
  return ((data ?? []) as TripStop[]).sort((a, b) => a.stop_order - b.stop_order);
}

export async function loadTrip(db: Db, id: unknown) {
  const trip = await getTripRow(db, id);
  const stops = await stopsOf(db, trip.id);
  let leads: Lead[] = [];
  if (stops.length) {
    const l = await db.from("leads").select(LEAD_COLUMNS).in("id", stops.map((s) => s.lead_id));
    if (l.error) fail(l.error, "Could not load the stops.");
    leads = ((l.data ?? []) as Lead[]).map(normLead);
  }
  const byId = new Map(leads.map((x) => [x.id, x]));
  return { trip, stops: stops.map((s) => ({ ...s, lead: byId.get(s.lead_id)! })).filter((s) => s.lead) };
}

/** Stop actions: add (lead_ids), remove (stop_id), reorder (stop_ids), sort_zip. */
export async function tripStopsAction(db: Db, tripId: unknown, body: Record<string, unknown>) {
  const trip = await getTripRow(db, tripId);
  const stops = await stopsOf(db, trip.id);
  const renumber = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i++) {
      const { error } = await db.from("trip_stops").update({ stop_order: i + 1 }).eq("id", ids[i]);
      if (error) fail(error, "Could not reorder the stops.");
    }
  };
  switch (body.action) {
    case "add": {
      const ids = Array.isArray(body.lead_ids) ? [...new Set(body.lead_ids as unknown[])] : [];
      if (ids.length === 0 || ids.length > 100) throw new GrowthError("Choose the stores to add.", 400);
      for (const id of ids) idOrThrow(id, "lead");
      const l = await db.from("leads").select("id, archived_at").in("id", ids);
      if (l.error) fail(l.error, "Could not load leads.");
      const found = new Set(((l.data ?? []) as Array<{ id: string; archived_at: string | null }>).filter((x) => !x.archived_at).map((x) => x.id));
      let order = stops.at(-1)?.stop_order ?? 0;
      for (const id of ids as string[]) {
        if (!found.has(id)) throw new GrowthError("Unknown lead.", 404);
        if (stops.some((s) => s.lead_id === id)) continue;
        const { error } = await db.from("trip_stops").insert({ trip_id: trip.id, lead_id: id, stop_order: ++order });
        if (error) fail(error, "Could not add the stop.");
      }
      return;
    }
    case "remove": {
      const s = stops.find((x) => x.id === body.stop_id);
      if (!s) throw new GrowthError("Unknown stop.", 404);
      const { error } = await db.from("trip_stops").delete().eq("id", s.id);
      if (error) fail(error, "Could not remove the stop.");
      await renumber(stops.filter((x) => x.id !== s.id).map((x) => x.id));
      return;
    }
    case "reorder": {
      const ids = body.stop_ids;
      if (!Array.isArray(ids) || ids.length !== stops.length || new Set(ids).size !== ids.length || !ids.every((x) => stops.some((s) => s.id === x))) {
        throw new GrowthError("The stops changed. Reload the page and try again.", 409);
      }
      await renumber(ids as string[]);
      return;
    }
    case "sort_zip": {
      const { stops: withLeads } = await loadTrip(db, trip.id);
      // Stops without a ZIP go last; ties keep their current order.
      const zip = (x: { lead: Lead }) => (x.lead.zip ?? "").trim();
      const sorted = [...withLeads].sort((a, b) => {
        const za = zip(a);
        const zb = zip(b);
        if (!za !== !zb) return za ? -1 : 1;
        return (za < zb ? -1 : za > zb ? 1 : 0) || a.stop_order - b.stop_order;
      });
      await renumber(sorted.map((s) => s.id));
      return;
    }
    default:
      throw new GrowthError("Unknown action.", 400);
  }
}

export const defaultFollowUp = (today: string) => addDays(today, DEFAULT_FOLLOW_UP_DAYS);
