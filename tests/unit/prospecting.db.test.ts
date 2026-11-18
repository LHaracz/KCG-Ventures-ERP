// Retail Prospecting server code against the real migrations in PGlite:
// quick add and validation, activity logging and status changes, voiding,
// follow-ups, trips and stops (add, reorder, ZIP sort, remove), the goal,
// and Convert to retailer with the duplicate warning. Invented stores
// ("Store A"), example.test addresses and 555 phone numbers only.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  convertToRetailer,
  createLead,
  createTrip,
  followUpsDue,
  loadLead,
  loadProspecting,
  loadTrip,
  logActivity,
  saveGoal,
  tripStopsAction,
  updateLead,
  voidActivity,
} from "@/lib/growth/prospectingService";
import type { Db } from "@/lib/growth/routeHelpers";

let pg: PGlite;
let db: Db;
const TODAY = "2026-11-17";

const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected an error").toBeTruthy();
  expect((err as Error).message).toMatch(re);
  return err as Error & { fields?: Record<string, string> };
};

const storeA = { name: "Store A", category: "health_food", address_line1: "1 Market Way", city: "Shopton", state: "PA", zip: "19100", phone: "(555) 010-0300", contact_name: "Pat Example", contact_email: "buyer@store-a.example.test", website_url: "https://store-a.example.test", notes: "Likes the mint flavor" };

beforeEach(async () => {
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql"]) await pg.exec(migration(f));
  db = pgliteSupabase(pg) as unknown as Db;
}, 120_000);

describe("leads", () => {
  it("quick add, validation, status changes, archive", async () => {
    const a = await createLead(db, { name: "  Store A ", address_line1: "1 Market Way", city: "Shopton", phone: "(555) 010-0300" }, "Test Person");
    expect(a).toMatchObject({ name: "Store A", status: "to_visit", category: "other", created_by_name: "Test Person" });
    const bad = await rejects(() => createLead(db, { name: "", website_url: "ftp://x", contact_email: "nope" }, null), /missing or not valid/);
    expect(Object.keys(bad.fields ?? {}).sort()).toEqual(["contact_email", "name", "website_url"]);
    await rejects(() => updateLead(db, a.id, { status: "lost" }), /why the lead was lost/);
    expect((await updateLead(db, a.id, { status: "lost", lost_reason: "Only carries local brands" })).status).toBe("lost");
    expect((await updateLead(db, a.id, { archive: true })).archived_at).not.toBeNull();
    const p = await loadProspecting(db, { today: TODAY });
    expect(p.funnel.lost).toBe(0); // archived leads are left out of the funnel
    expect((await updateLead(db, a.id, { restore: true })).archived_at).toBeNull();
  });

  it("logging: last activity, Samples left, Not interested needs a reason, follow-ups, void", async () => {
    const a = await createLead(db, storeA, null);
    await logActivity(db, a.id, { activity_date: "2026-11-10", type: "visit", outcome: "no_decision_maker", next_follow_up_date: "2026-11-15" }, "Test Person");
    let l = (await loadLead(db, a.id)).lead;
    expect(l).toMatchObject({ status: "visited", next_follow_up_date: "2026-11-15" });
    const act = await logActivity(db, a.id, { activity_date: "2026-11-16", type: "visit", outcome: "samples_left", summary: "Left 3 samples", next_follow_up_date: "2026-11-23" }, "Test Person");
    l = (await loadLead(db, a.id)).lead;
    expect(l).toMatchObject({ status: "samples_left", next_follow_up_date: "2026-11-23" });
    let p = await loadProspecting(db, { today: TODAY });
    expect(p.leads[0].last_activity_date).toBe("2026-11-16");
    expect(p.followUps).toEqual([]);
    expect(await followUpsDue(db, { today: "2026-11-24" })).toEqual([{ id: a.id, name: "Store A", city: "Shopton", next_follow_up_date: "2026-11-23", overdue: true }]);
    await voidActivity(db, a.id, act.id);
    p = await loadProspecting(db, { today: TODAY });
    expect(p.leads[0].last_activity_date).toBe("2026-11-10");
    const err = await rejects(() => logActivity(db, a.id, { activity_date: TODAY, type: "call", outcome: "not_interested" }, null), /missing or not valid/);
    expect(err.fields?.lost_reason).toBeTruthy();
    await logActivity(db, a.id, { activity_date: TODAY, type: "call", outcome: "not_interested", lost_reason: "No shelf space" }, null);
    l = (await loadLead(db, a.id)).lead;
    expect(l).toMatchObject({ status: "lost", lost_reason: "No shelf space", next_follow_up_date: null });
    const timeline = (await loadLead(db, a.id)).activities;
    expect(timeline.map((x) => [x.activity_date, x.outcome, !!x.voided_at])).toEqual([
      ["2026-11-17", "not_interested", false],
      ["2026-11-16", "samples_left", true],
      ["2026-11-10", "no_decision_maker", false],
    ]);
  });

  it("goal progress and the funnel", async () => {
    await saveGoal(db, { goal_retailers: "8", goal_date: "2027-02-15" });
    await rejects(() => saveGoal(db, { goal_retailers: "0" }), /not valid/);
    for (const [n, s] of [["Store A", "won"], ["Store B", "won"], ["Store C", "won"], ["Store D", "to_visit"]] as const) {
      const l = await createLead(db, { name: n }, null);
      if (s === "won") await updateLead(db, l.id, { status: "won" });
    }
    const p = await loadProspecting(db, { today: TODAY });
    expect(p.goal).toEqual({ won: 3, percent: 38, daysRemaining: 90, reached: false });
    expect(p.funnel).toMatchObject({ won: 3, to_visit: 1 });
  });
});

describe("trips", () => {
  it("add stops, reorder, sort by ZIP, log a visit at a stop, remove, complete", async () => {
    const a = await createLead(db, { ...storeA, zip: "19711" }, null);
    const b = await createLead(db, { name: "Store B", address_line1: "2 Main St", city: "Testville", state: "DE", zip: "19702" }, null);
    const c = await createLead(db, { name: "Store C" }, null);
    const trip = await createTrip(db, { name: "Trip A", trip_date: "2026-11-20" }, "Test Person");
    await rejects(() => createTrip(db, { name: "", trip_date: "soon" }, null), /missing or not valid/);
    await tripStopsAction(db, trip.id, { action: "add", lead_ids: [a.id, b.id, c.id, a.id] });
    let t = await loadTrip(db, trip.id);
    expect(t.stops.map((s) => s.lead.name)).toEqual(["Store A", "Store B", "Store C"]);
    await tripStopsAction(db, trip.id, { action: "reorder", stop_ids: [t.stops[2].id, t.stops[0].id, t.stops[1].id] });
    expect((await loadTrip(db, trip.id)).stops.map((s) => s.lead.name)).toEqual(["Store C", "Store A", "Store B"]);
    await rejects(() => tripStopsAction(db, trip.id, { action: "reorder", stop_ids: [t.stops[0].id] }), /changed/);
    await tripStopsAction(db, trip.id, { action: "sort_zip" });
    t = await loadTrip(db, trip.id);
    expect(t.stops.map((s) => s.lead.name)).toEqual(["Store B", "Store A", "Store C"]); // no ZIP last
    const stopA = t.stops.find((s) => s.lead.name === "Store A")!;
    await logActivity(db, a.id, { activity_date: "2026-11-20", type: "visit", outcome: "spoke_with_buyer" }, null, { tripStopId: stopA.id });
    expect((await loadTrip(db, trip.id)).stops.find((s) => s.id === stopA.id)!.logged_at).not.toBeNull();
    await tripStopsAction(db, trip.id, { action: "remove", stop_id: t.stops[2].id });
    t = await loadTrip(db, trip.id);
    expect(t.stops.map((s) => [s.lead.name, s.stop_order])).toEqual([["Store B", 1], ["Store A", 2]]);
    const p = await loadProspecting(db, { today: TODAY });
    expect(p.trips[0]).toMatchObject({ name: "Trip A", stops: 2, status: "planned" });
  });
});

describe("convert to retailer", () => {
  it("asks to confirm a lead that isn't won, warns about a duplicate name, and links the retailer", async () => {
    const a = await createLead(db, storeA, null);
    expect(await convertToRetailer(db, a.id, {}, "Ada Admin")).toEqual({ needs: "confirm_not_won" });
    await pg.query(`insert into retailers (name, billing_line1, billing_city, billing_state, billing_zip) values ('store a', '9 Other Rd', 'Shopton', 'PA', '19100')`);
    const dup = await convertToRetailer(db, a.id, { confirmNotWon: true }, "Ada Admin");
    expect(dup).toMatchObject({ needs: "confirm_duplicate", existing: { name: "store a" } });
    const r = await convertToRetailer(db, a.id, { confirmNotWon: true, confirmDuplicate: true }, "Ada Admin");
    expect(r.retailer?.name).toBe("Store A (from Prospecting)");
    const lead = await loadLead(db, a.id);
    expect(lead.lead).toMatchObject({ status: "won", retailer_id: r.retailer!.id });
    expect(lead.retailer?.name).toBe("Store A (from Prospecting)");
    const row = (await pg.query<Record<string, unknown>>(`select * from retailers where id = $1`, [r.retailer!.id])).rows[0];
    expect(row).toMatchObject({ billing_line1: "1 Market Way", billing_city: "Shopton", contact_email: "buyer@store-a.example.test", description: "Likes the mint flavor", website_url: "https://store-a.example.test" });
    expect((await pg.query(`select * from retailer_terms where retailer_id = $1`, [r.retailer!.id])).rows).toEqual([]);
    await rejects(() => convertToRetailer(db, a.id, { confirmNotWon: true }, null), /already a retailer/);
    const noAddr = await createLead(db, { name: "Store Z" }, null);
    await updateLead(db, noAddr.id, { status: "won" });
    await rejects(() => convertToRetailer(db, noAddr.id, {}, null), /full address/);
  });
});
