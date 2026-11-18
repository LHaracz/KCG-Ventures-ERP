// Pure modules for Marketing & Sales: ingredient planning, the default
// launch checklist, task shifting, launch risk, the risky-word scan, caption
// templates, Google Maps route links, the funnel and goal progress, and the
// claims gate. Invented data only ("Store A", example.test).
import { describe, expect, it } from "vitest";
import { addDays, diffDays, nyDateOf } from "@/lib/growth/dates";
import { planIngredients, stateChip, type PlanRowInput } from "@/lib/growth/plan";
import { defaultLaunchTasks, launchRisk, shiftOpenTasks } from "@/lib/growth/tasks";
import { applyTemplate, claimsReadyCheck, scanText } from "@/lib/growth/text";
import { MAPS_MAX_WAYPOINTS, addressLine, funnelCounts, goalProgress, mapsRouteUrls } from "@/lib/growth/prospecting";

const row = (over: Partial<PlanRowInput> = {}): PlanRowInput => ({
  needed: "10",
  onHand: "0",
  qtyOrdered: null,
  status: "pending",
  orderedAt: null,
  expectedArrival: null,
  leadTimeDays: 7,
  ...over,
});
const plan1 = (r: PlanRowInput, opts: { today?: string; planned?: string | null; buffer?: number } = {}) =>
  planIngredients({ today: opts.today ?? "2026-11-17", plannedTestBatchDate: opts.planned === undefined ? "2026-12-15" : opts.planned, bufferDays: opts.buffer ?? 2, rows: [r] });

describe("dates", () => {
  it("whole calendar days across month, year, leap day and both daylight saving changes", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08"); // DST starts Mar 8 2026 (New York)
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01"); // DST ends Nov 1 2026
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(diffDays("2026-03-01", "2026-04-01")).toBe(31);
    expect(diffDays("2026-10-25", "2026-11-08")).toBe(14);
    expect(nyDateOf("2026-11-18T03:30:00Z")).toBe("2026-11-17"); // 10:30 pm in New York
  });
});

describe("planIngredients", () => {
  it("enough stock", () => {
    const p = plan1(row({ onHand: "12" }));
    expect(p.rows[0]).toMatchObject({ state: "enough", shortfall: "0" });
    expect(p.earliestTestBatchDate).toBe("2026-11-17");
    expect(p.slipDays).toBe(0);
    expect(p.hasUnknownLeadTimes).toBe(false);
  });

  it("partial stock: shortfall, order-by with buffer, arrival if ordered today", () => {
    const p = plan1(row({ onHand: "4.25" }));
    expect(p.rows[0]).toMatchObject({ state: "to_order", shortfall: "5.75", orderBy: "2026-12-06", lateByDays: 0, arrivalIfOrderedToday: "2026-11-24" });
    expect(p.earliestTestBatchDate).toBe("2026-11-24");
    expect(p.slipDays).toBe(0);
    expect(stateChip(p.rows[0]).label).toBe("To order");
  });

  it("decimal quantities stay exact", () => {
    const p = plan1(row({ needed: "0.3", onHand: "0.1", status: "ordered", qtyOrdered: "0.1", orderedAt: "2026-11-10" }));
    expect(p.rows[0].shortfall).toBe("0.1");
    expect(p.rows[0].inTransit).toBe("0.1");
    expect(p.rows[0].state).toBe("ordered_short");
  });

  it("ordered covering the need, with and without an expected arrival override", () => {
    let p = plan1(row({ status: "ordered", qtyOrdered: "10", orderedAt: "2026-11-10", leadTimeDays: 14 }));
    expect(p.rows[0]).toMatchObject({ state: "ordered", shortfall: "0", expectedArrivalDate: "2026-11-24" });
    expect(p.earliestTestBatchDate).toBe("2026-11-24");
    p = plan1(row({ status: "ordered", qtyOrdered: "10", orderedAt: "2026-11-10", expectedArrival: "2026-12-20" }));
    expect(p.rows[0].expectedArrivalDate).toBe("2026-12-20");
    expect(p.slipDays).toBe(5);
  });

  it("ordered with no date known is unknown", () => {
    const p = plan1(row({ status: "ordered", qtyOrdered: "10", orderedAt: "2026-11-10", leadTimeDays: null }));
    expect(p.rows[0].expectedArrivalDate).toBeNull();
    expect(p.hasUnknownLeadTimes).toBe(true);
  });

  it("ordered short", () => {
    const p = plan1(row({ status: "ordered", qtyOrdered: "4", onHand: "1", orderedAt: "2026-11-10" }));
    expect(p.rows[0]).toMatchObject({ state: "ordered_short", shortfall: "5" });
    expect(stateChip(p.rows[0]).label).toBe("Ordered (short)");
  });

  it("arrived (stock is now on hand, nothing in transit)", () => {
    const p = plan1(row({ status: "arrived", onHand: "10", qtyOrdered: "10" }));
    expect(p.rows[0]).toMatchObject({ state: "arrived", inTransit: "0" });
    expect(p.earliestTestBatchDate).toBe("2026-11-17");
  });

  it("skipped rows are left out", () => {
    const p = plan1(row({ status: "skipped", leadTimeDays: null }));
    expect(p.rows[0].state).toBe("skipped");
    expect(p.hasUnknownLeadTimes).toBe(false);
    expect(p.earliestTestBatchDate).toBe("2026-11-17");
  });

  it("unknown lead time", () => {
    const p = plan1(row({ leadTimeDays: null }));
    expect(p.rows[0]).toMatchObject({ state: "no_lead_time", orderBy: null, arrivalIfOrderedToday: null });
    expect(p.hasUnknownLeadTimes).toBe(true);
    expect(p.earliestTestBatchDate).toBe("2026-11-17");
  });

  it("order-by in the past: late by days, slip into the next year", () => {
    const p = planIngredients({
      today: "2026-12-20",
      plannedTestBatchDate: "2026-12-28",
      bufferDays: 3,
      rows: [row({ leadTimeDays: 21 }), row({ leadTimeDays: 5 })],
    });
    expect(p.rows[0]).toMatchObject({ orderBy: "2026-12-04", lateByDays: 16, arrivalIfOrderedToday: "2027-01-10" });
    expect(stateChip(p.rows[0]).label).toBe("Late");
    expect(p.earliestTestBatchDate).toBe("2027-01-10");
    expect(p.slipDays).toBe(13);
  });

  it("slip across a month end, the leap day and daylight saving changes (exact dates)", () => {
    let p = planIngredients({ today: "2028-02-20", plannedTestBatchDate: "2028-02-27", bufferDays: 0, rows: [row({ leadTimeDays: 10 })] });
    expect(p.earliestTestBatchDate).toBe("2028-03-01");
    expect(p.slipDays).toBe(3);
    p = planIngredients({ today: "2026-03-01", plannedTestBatchDate: "2026-03-05", bufferDays: 0, rows: [row({ leadTimeDays: 8 })] });
    expect(p.earliestTestBatchDate).toBe("2026-03-09");
    p = planIngredients({ today: "2026-10-25", plannedTestBatchDate: "2026-10-30", bufferDays: 1, rows: [row({ leadTimeDays: 8 })] });
    expect(p.rows[0].orderBy).toBe("2026-10-21");
    expect(p.earliestTestBatchDate).toBe("2026-11-02");
  });

  it("no planned date: no order-by and no slip", () => {
    const p = plan1(row(), { planned: null });
    expect(p.rows[0].orderBy).toBeNull();
    expect(p.slipDays).toBeNull();
    expect(p.earliestTestBatchDate).toBe("2026-11-24");
  });
});

describe("defaultLaunchTasks", () => {
  it("a normal target", () => {
    const t = defaultLaunchTasks("2027-03-15", "2027-02-10", { longestLeadTimeDays: 14, bufferDays: 2 });
    expect(t).toHaveLength(18);
    const due = Object.fromEntries(t.map((x) => [x.title, x.due_date]));
    expect(due["Finalize the formula for the test batch"]).toBe("2027-02-01");
    expect(due["Confirm ingredient list and suppliers"]).toBe("2027-02-02");
    expect(due["Order test batch ingredients"]).toBe("2027-01-25");
    expect(due["Ingredients arrived"]).toBe("2027-02-09");
    expect(due["Make the test batch"]).toBe("2027-02-10");
    expect(due["Evaluate the test batch (texture, flavor, stability notes)"]).toBe("2027-02-18");
    expect(due["Launch day posts live"]).toBe("2027-03-15");
    expect(due["First retailer visits"]).toBe("2027-03-18");
    expect(t.filter((x) => x.auto_kind).map((x) => x.auto_kind)).toEqual(["formula_final", "ingredients_ready"]);
    expect(t.map((x) => x.sort_order)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it("missing planned date and unknown lead time: defaults (target -28, -40)", () => {
    const t = defaultLaunchTasks("2027-01-05", null);
    const due = Object.fromEntries(t.map((x) => [x.title, x.due_date]));
    expect(due["Make the test batch"]).toBe("2026-12-08");
    expect(due["Ingredients arrived"]).toBe("2026-12-07");
    expect(due["Order test batch ingredients"]).toBe("2026-11-26");
    expect(due["Finalize the formula for the test batch"]).toBe("2026-11-24");
  });

  it("a target in the past and month ends", () => {
    const t = defaultLaunchTasks("2026-03-01", "2026-01-31");
    const due = Object.fromEntries(t.map((x) => [x.title, x.due_date]));
    expect(due["Product photos"]).toBe("2026-02-15");
    expect(due["Ingredients arrived"]).toBe("2026-01-30");
    expect(due["Order test batch ingredients"]).toBe("2026-01-20");
  });
});

describe("shiftOpenTasks and launchRisk", () => {
  const tasks = [
    { id: "a", status: "todo" as const, due_date: "2026-12-30" },
    { id: "b", status: "done" as const, due_date: "2026-12-01" },
    { id: "c", status: "blocked" as const, due_date: null },
    { id: "d", status: "in_progress" as const, due_date: "2026-03-01" },
  ];
  it("shifts open tasks with dates, forward and back", () => {
    expect(shiftOpenTasks(tasks, 5).map((t) => t.due_date)).toEqual(["2027-01-04", "2026-12-01", null, "2026-03-06"]);
    expect(shiftOpenTasks(tasks, -1).map((t) => t.due_date)).toEqual(["2026-12-29", "2026-12-01", null, "2026-02-28"]);
  });
  it("late, at risk, on track", () => {
    const clean = { slipDays: 0, hasUnknownLeadTimes: false };
    expect(launchRisk({ tasks, plan: clean, today: "2026-03-02" })).toBe("late");
    expect(launchRisk({ tasks, plan: clean, today: "2026-03-01" })).toBe("on_track");
    expect(launchRisk({ tasks, plan: { slipDays: 2, hasUnknownLeadTimes: false }, today: "2026-02-01" })).toBe("at_risk");
    expect(launchRisk({ tasks, plan: { slipDays: 0, hasUnknownLeadTimes: true }, today: "2026-02-01" })).toBe("at_risk");
    expect(launchRisk({ tasks: [{ status: "done", due_date: "2020-01-01" }], plan: null, today: "2026-02-01" })).toBe("on_track");
  });
});

describe("scanText", () => {
  const words = ["cure", "cures", "gum disease", "FDA approved", "treat"];
  it("whole words and phrases, case-insensitive, once each, with positions", () => {
    const m = scanText("Cures bad breath? Not a CURE. Fights gum   disease... FDA-approved? no; FDA approved!", words);
    expect(m.map((x) => x.phrase)).toEqual(["cures", "cure", "gum disease", "FDA approved"]);
    expect(m[0].index).toBe(0);
  });
  it("no match inside longer words; punctuation; empty text", () => {
    expect(scanText("Secure, treatment-free, procured", words)).toEqual([]);
    expect(scanText("(treat)", words).map((x) => x.phrase)).toEqual(["treat"]);
    expect(scanText("", words)).toEqual([]);
    expect(scanText(null, words)).toEqual([]);
  });
});

describe("applyTemplate", () => {
  it("fills known placeholders, lists unknown and missing ones", () => {
    const r = applyTemplate("New: {product_name} - {tagline}\n{short_description} {hashtags} {link} {price}", {
      product_name: "Product A",
      tagline: "Fresh every day",
      short_description: "",
      hashtags: "#example",
    });
    expect(r.text).toBe("New: Product A - Fresh every day\n #example  {price}");
    expect(r.unknown).toEqual(["price"]);
    expect(r.missing.sort()).toEqual(["link", "short_description"]);
  });
});

describe("mapsRouteUrls", () => {
  const stop = (i: number) => ({ label: `Store ${i}`, address: `${i} Example St, Testville, DE 19700` });
  it("one stop: just a destination, no origin", () => {
    const r = mapsRouteUrls([stop(1)]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0].url).toBe("https://www.google.com/maps/dir/?api=1&destination=1%20Example%20St%2C%20Testville%2C%20DE%2019700&travelmode=driving");
    expect(r.links[0].url).not.toContain("origin=");
  });
  it("10 stops fit one link (9 waypoints + destination); 25 stops make 3 parts", () => {
    expect(MAPS_MAX_WAYPOINTS).toBe(9);
    const ten = mapsRouteUrls(Array.from({ length: 10 }, (_, i) => stop(i + 1)));
    expect(ten.links).toHaveLength(1);
    const wp = new URL(ten.links[0].url).searchParams.get("waypoints")!.split("|");
    expect(wp).toHaveLength(9);
    expect(new URL(ten.links[0].url).searchParams.get("destination")).toBe(stop(10).address);
    const many = mapsRouteUrls(Array.from({ length: 25 }, (_, i) => stop(i + 1)));
    expect(many.links.map((l) => [l.label, l.stops.length])).toEqual([["Part 1", 10], ["Part 2", 10], ["Part 3", 5]]);
    expect(new URL(many.links[1].url).searchParams.get("destination")).toBe(stop(20).address);
  });
  it("encodes special characters; skips missing addresses with a warning", () => {
    const r = mapsRouteUrls([
      { label: "Store A", address: "12 O'Neil & Sons Rd #4, Testville, DE" },
      { label: "Store B", address: "" },
      { label: "Store C", address: "5 Main St | Unit 2, Testville" },
    ]);
    expect(r.warnings).toEqual(["Store B has no address and was left out of the route."]);
    const u = new URL(r.links[0].url);
    expect(u.searchParams.get("waypoints")).toBe("12 O'Neil & Sons Rd #4, Testville, DE");
    expect(u.searchParams.get("destination")).toBe("5 Main St   Unit 2, Testville"); // "|" separates waypoints, so it is dropped
    expect(r.links[0].url).not.toContain(" ");
    expect(r.links[0].url).not.toContain("&Sons");
    expect(addressLine({ address_line1: "1 Market Way", city: "Shopton", state: "PA", zip: "19100" })).toBe("1 Market Way, Shopton, PA 19100");
    expect(addressLine({ state: "PA" })).toBeNull();
  });
});

describe("funnel and goal", () => {
  it("counts by status, ignoring archived", () => {
    const c = funnelCounts([{ status: "won" }, { status: "won" }, { status: "to_visit" }, { status: "lost", archived_at: "2026-01-01" }]);
    expect(c).toMatchObject({ won: 2, to_visit: 1, lost: 0, visited: 0 });
  });
  it("percent and days remaining", () => {
    expect(goalProgress({ won: 3, goal: 8, goalDate: "2027-02-15", today: "2026-11-17" })).toEqual({ percent: 38, daysRemaining: 90, reached: false });
    expect(goalProgress({ won: 9, goal: 8, goalDate: null, today: "2026-11-17" })).toEqual({ percent: 100, daysRemaining: null, reached: true });
    expect(goalProgress({ won: 1, goal: null, goalDate: null, today: "2026-11-17" }).percent).toBeNull();
  });
});

describe("claimsReadyCheck", () => {
  it("lists the selected claims that aren't approved", () => {
    const sel = [
      { id: "1", claim_text: "Claim A", status: "approved" },
      { id: "2", claim_text: "Claim B", status: "in_review" },
      { id: "3", claim_text: "Claim C", status: "retired" },
    ];
    expect(claimsReadyCheck(sel).map((c) => c.id)).toEqual(["2", "3"]);
    expect(claimsReadyCheck([])).toEqual([]);
  });
});
