// Database rules for packaging, staging boxes, picking, overrides and label
// gating, run against the real migration SQL in PGlite. Invented TEST-
// orders only. True concurrent races are in tests/db/ (real Postgres).
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createFulfillmentDb, createTestBoxes, FIX, rpc } from "./helpers/fulfillmentDb";

let pg: PGlite;
let boxes: Record<number, string>;

beforeEach(async () => {
  ({ pg } = await createFulfillmentDb());
  boxes = await createTestBoxes(pg, [901, 902, 903]);
});

const status = async (orderId: string) =>
  (await pg.query<{ status: string }>(`select status from order_status where shopify_order_id = $1`, [orderId])).rows[0]
    ?.status ?? null;
const openBox = async (orderId: string) =>
  (
    await pg.query<{ label: string }>(
      `select b.label from staging_box_assignments a join staging_boxes b on b.id = a.staging_box_id
       where a.order_id = $1 and a.released_at is null`,
      [orderId],
    )
  ).rows[0]?.label ?? null;
const pick = (orderId: string, boxNumber: number, name = orderId.replace("TEST-", "#")) =>
  rpc(pg, "mark_order_picked", { p_order_id: orderId, p_box_id: boxes[boxNumber], p_order_name: name });
const events = async (orderId: string) =>
  (await pg.query<{ event_type: string; detail: any }>(
    `select event_type, detail from order_events where order_id = $1 order by created_at, event_type`,
    [orderId],
  )).rows;
const addLabel = (orderId: string) =>
  rpc(pg, "complete_label_purchase", {
    p_order_id: orderId,
    p_log: { tracking_number: "TEST-TRK", carrier: "USPS", service: "GroundAdvantage", label_url: "https://example.invalid/l.pdf", easypost_shipment_id: "shp_test", rate_amount: "4.50", rate_currency: "USD" },
  });

describe("migration safety", () => {
  it("adds 'picked' without touching in-flight orders", async () => {
    expect(await status("TEST-INFLIGHT-GEN")).toBe("label_generated");
    expect(await status("TEST-INFLIGHT-PRINTED")).toBe("label_printed");
    expect(await status("TEST-INFLIGHT-DONE")).toBe("fulfilled");
    await pg.query(`insert into order_status (shopify_order_id, status) values ('TEST-P', 'picked')`);
    await expect(pg.query(`insert into order_status (shopify_order_id, status) values ('TEST-X', 'bogus')`)).rejects.toThrow();
  });

  it("is safe to run twice", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    await pg.exec(readFileSync(path.resolve(__dirname, "../../supabase-migrations/fulfillment_picking_staging.sql"), "utf8"));
    expect(await status("TEST-INFLIGHT-GEN")).toBe("label_generated");
  });
});

describe("preset validation (database)", () => {
  it("rejects duplicate and non-positive max points", async () => {
    await expect(
      pg.query(`insert into package_presets (user_id, nickname, length_in, width_in, height_in, tare_weight_oz, max_points)
                values ('${FIX.user}', 'Dup', 1, 1, 1, 0, 10)`),
    ).rejects.toThrow(/uq_package_presets_max_points|duplicate/);
    await expect(
      pg.query(`insert into package_presets (user_id, nickname, length_in, width_in, height_in, tare_weight_oz, max_points)
                values ('${FIX.user}', 'Zero', 1, 1, 1, 0, 0)`),
    ).rejects.toThrow(/max_points_positive/);
    // Several presets without max points are fine.
    await pg.query(`insert into package_presets (user_id, nickname, length_in, width_in, height_in, tare_weight_oz)
                    values ('${FIX.user}', 'NoPts1', 1, 1, 1, 0), ('${FIX.user}', 'NoPts2', 1, 1, 1, 0)`);
  });

  it("product rules: points must be > 0, minimum must have max points", async () => {
    await expect(pg.query(`insert into product_packaging_rules (product_id, points) values ('${FIX.gum}', 0)`)).rejects.toThrow();
    const noPts = await pg.query<{ id: string }>(
      `insert into package_presets (user_id, nickname, length_in, width_in, height_in, tare_weight_oz)
       values ('${FIX.user}', 'NoPts', 1, 1, 1, 0) returning id`,
    );
    await expect(
      pg.query(`insert into product_packaging_rules (product_id, points, min_package_id) values ('${FIX.gum}', 1, '${noPts.rows[0].id}')`),
    ).rejects.toThrow(/smallest allowed package must be a package with max points/);
    await pg.query(`insert into product_packaging_rules (product_id, points, min_package_id) values ('${FIX.gum}', 1, '${FIX.small}')`);
  });

  it("blocks deleting a preset used by a product rule or an open order override, naming where", async () => {
    await pg.query(`insert into product_packaging_rules (product_id, points, min_package_id) values ('${FIX.spray}', 1, '${FIX.small}')`);
    await expect(pg.query(`delete from package_presets where id = '${FIX.small}'`)).rejects.toThrow(
      /Test Small is still in use as the smallest allowed package for: Test Spray/,
    );
    await pick("TEST-1", 901, "#1001");
    await rpc(pg, "set_packaging_override", { p_order_id: "TEST-1", p_target: "preset", p_preset_id: FIX.big, p_previous_label: "Test Small" });
    await expect(pg.query(`delete from package_presets where id = '${FIX.big}'`)).rejects.toThrow(
      /package override on open orders: #1001/,
    );
    // Unused preset deletes fine.
    await pg.query(`delete from package_presets where id = '${FIX.mailer}'`);
  });
});

describe("staging boxes", () => {
  it("numbers continue from the highest box and are never reused", async () => {
    const r = await rpc(pg, "create_staging_boxes", { p_count: 2 });
    expect(r.error).toBeNull();
    expect((r.data as any).created).toEqual(["STG-904", "STG-905"]);
    expect((await rpc(pg, "create_staging_boxes", { p_count: 0 })).error?.message).toBe("Enter a number of boxes from 1 to 50.");
    expect((await rpc(pg, "create_staging_boxes", { p_count: 51 })).error?.message).toBe("Enter a number of boxes from 1 to 50.");
  });

  it("can't be deleted; retire only when available", async () => {
    await expect(pg.query(`delete from staging_boxes where id = '${boxes[901]}'`)).rejects.toThrow(/never deleted/);
    await pick("TEST-1", 901);
    expect((await rpc(pg, "retire_staging_box", { p_box_id: boxes[901] })).error?.message).toBe(
      "STG-901 is holding order #1. Release it before retiring.",
    );
    expect((await rpc(pg, "retire_staging_box", { p_box_id: boxes[902] })).error).toBeNull();
    expect((await pick("TEST-2", 902)).error?.message).toBe("STG-902 is retired.");
  });
});

describe("mark_order_picked", () => {
  it("assigns the box, sets picked and writes an event", async () => {
    const r = await pick("TEST-1", 901, "#2554");
    expect(r.error).toBeNull();
    expect((r.data as any).box_label).toBe("STG-901");
    expect(await status("TEST-1")).toBe("picked");
    expect(await openBox("TEST-1")).toBe("STG-901");
    expect((await events("TEST-1")).map((e) => e.event_type)).toEqual(["picked"]);
  });

  it("box in use: specific error, nothing overwritten", async () => {
    await pick("TEST-1", 901, "#2554");
    const r = await pick("TEST-2", 901, "#2555");
    expect(r.error?.message).toBe("STG-901 is already holding order #2554.");
    expect(await openBox("TEST-1")).toBe("STG-901");
    expect(await openBox("TEST-2")).toBeNull();
    // The failed call left no order_status row behind.
    expect(await status("TEST-2")).toBeNull();
  });

  it("order already picked: specific error", async () => {
    await pick("TEST-1", 901, "#2554");
    const r = await pick("TEST-1", 902, "#2554");
    expect(r.error?.message).toBe("Order #2554 is already picked into STG-901.");
    expect(await openBox("TEST-1")).toBe("STG-901");
  });

  it("status not preparing_shipment: specific error (in-flight orders are exempt)", async () => {
    const r = await rpc(pg, "mark_order_picked", { p_order_id: "TEST-INFLIGHT-GEN", p_box_id: boxes[901], p_order_name: "#2400" });
    expect(r.error?.message).toBe("Order #2400 is not waiting to be picked.");
  });

  it("flagged orders can't be picked", async () => {
    await pg.query(`insert into order_status (shopify_order_id, is_flagged, flagged_reason) values ('TEST-F', true, 'Address?')`);
    expect((await pick("TEST-F", 901, "#77")).error?.message).toBe("Order #77 is flagged. Unflag it before picking.");
  });

  it("same box for two orders back to back: exactly one succeeds; a released box is reusable", async () => {
    const results = await Promise.all([pick("TEST-A", 903), pick("TEST-B", 903)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    const winner = results[0].error === null ? "TEST-A" : "TEST-B";
    const loser = winner === "TEST-A" ? "TEST-B" : "TEST-A";
    expect((await rpc(pg, "return_order_to_picking", { p_order_id: winner })).error).toBeNull();
    expect((await pick(loser, 903)).error).toBeNull();
  });

  it("same order into two boxes: exactly one succeeds", async () => {
    const results = await Promise.all([pick("TEST-A", 901), pick("TEST-A", 902)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    const n = await pg.query(`select count(*)::int as n from staging_box_assignments where order_id = 'TEST-A' and released_at is null`);
    expect((n.rows[0] as any).n).toBe(1);
  });

  it("the unique indexes are the final guard even without the function", async () => {
    await pick("TEST-1", 901);
    await expect(
      pg.query(`insert into staging_box_assignments (order_id, staging_box_id) values ('TEST-2', '${boxes[901]}')`),
    ).rejects.toThrow(/uq_staging_box_open_by_box/);
    await expect(
      pg.query(`insert into staging_box_assignments (order_id, staging_box_id) values ('TEST-1', '${boxes[902]}')`),
    ).rejects.toThrow(/uq_staging_box_open_by_order/);
  });
});

describe("return_order_to_picking / release_staging_box", () => {
  it("blocked when a label exists; otherwise frees the box and clears the override", async () => {
    await pick("TEST-1", 901, "#1");
    await rpc(pg, "set_packaging_override", { p_order_id: "TEST-1", p_target: "needs_review", p_previous_label: "Test Small" });
    expect((await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-1" })).error).toBeNull();
    await addLabel("TEST-1");
    expect((await rpc(pg, "return_order_to_picking", { p_order_id: "TEST-1" })).error?.message).toBe("Void the label first.");
    expect((await rpc(pg, "release_staging_box", { p_box_id: boxes[901], p_reason: "Lost" })).error?.message).toBe("Void the label first.");

    const log = await pg.query<{ id: string }>(`select id from fulfillment_log where shopify_order_id = 'TEST-1'`);
    expect(((await rpc(pg, "finish_label_void", { p_order_id: "TEST-1", p_log_id: log.rows[0].id })).data as any).status).toBe("picked");

    expect((await rpc(pg, "return_order_to_picking", { p_order_id: "TEST-1" })).error).toBeNull();
    expect(await status("TEST-1")).toBe("preparing_shipment");
    expect(await openBox("TEST-1")).toBeNull();
    expect((await pg.query(`select * from order_packaging where order_id = 'TEST-1'`)).rows).toHaveLength(0);
    const types = (await events("TEST-1")).map((e) => e.event_type);
    expect(types).toContain("returned_to_picking");
    expect(types).toContain("packaging_override_cleared");
    // Box is available again.
    expect((await pick("TEST-2", 901)).error).toBeNull();
  });

  it("only allowed for picked orders", async () => {
    expect((await rpc(pg, "return_order_to_picking", { p_order_id: "TEST-NEW" })).error?.message).toBe("Order #TEST-NEW is not picked.");
  });

  it("manual release requires a reason and sends the order back to picking", async () => {
    await pick("TEST-1", 901, "#1");
    expect((await rpc(pg, "release_staging_box", { p_box_id: boxes[901], p_reason: "  " })).error?.message).toBe(
      "A reason is required to release a staging box.",
    );
    const r = await rpc(pg, "release_staging_box", { p_box_id: boxes[901], p_reason: "Box crushed" });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ box_label: "STG-901", returned_to_picking: true });
    expect(await status("TEST-1")).toBe("preparing_shipment");
    const a = await pg.query<any>(`select release_reason, release_note from staging_box_assignments where order_id = 'TEST-1'`);
    expect(a.rows[0]).toMatchObject({ release_reason: "manual_release", release_note: "Box crushed" });
  });
});

describe("Void Label, Mark Fulfilled, reconcile", () => {
  it("void returns the order to picked when it holds a box, preparing_shipment when not", async () => {
    await pick("TEST-1", 901);
    await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-1" });
    await addLabel("TEST-1");
    const log = await pg.query<{ id: string }>(`select id from fulfillment_log where shopify_order_id = 'TEST-1'`);
    await rpc(pg, "finish_label_void", { p_order_id: "TEST-1", p_log_id: log.rows[0].id });
    expect(await status("TEST-1")).toBe("picked");
    expect(await openBox("TEST-1")).toBe("STG-901");

    // An in-flight order (label bought before this shipped, no box).
    await pg.query(`insert into fulfillment_log (shopify_order_id, easypost_shipment_id) values ('TEST-INFLIGHT-GEN', 'shp_x')`);
    const l2 = await pg.query<{ id: string }>(`select id from fulfillment_log where shopify_order_id = 'TEST-INFLIGHT-GEN'`);
    await rpc(pg, "finish_label_void", { p_order_id: "TEST-INFLIGHT-GEN", p_log_id: l2.rows[0].id });
    expect(await status("TEST-INFLIGHT-GEN")).toBe("preparing_shipment");
  });

  it("release on fulfilled frees the box and is idempotent; reconcile is idempotent", async () => {
    await pick("TEST-1", 901);
    await pg.query(`update order_status set status = 'fulfilled' where shopify_order_id = 'TEST-1'`);
    expect(((await rpc(pg, "release_assignment_on_fulfilled", { p_order_id: "TEST-1" })).data as any).released).toBe(true);
    expect(((await rpc(pg, "release_assignment_on_fulfilled", { p_order_id: "TEST-1" })).data as any).released).toBe(false);
    expect(await openBox("TEST-1")).toBeNull();

    // A fulfilled order whose release failed: reconcile frees it, once.
    await pick("TEST-2", 902);
    await pg.query(`update order_status set status = 'fulfilled' where shopify_order_id = 'TEST-2'`);
    expect((await rpc(pg, "reconcile_staging_assignments", {})).data).toBe(1);
    expect((await rpc(pg, "reconcile_staging_assignments", {})).data).toBe(0);
    const a = await pg.query<any>(`select release_reason from staging_box_assignments where order_id = 'TEST-2'`);
    expect(a.rows[0].release_reason).toBe("auto_reconcile");
  });
});

describe("label purchase gating", () => {
  it("applies to preparing_shipment orders only, and blocks a second purchase", async () => {
    expect((await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-NEW" })).error?.message).toBe(
      "Pick this order first: assign a staging box on the Pick List.",
    );
    expect(await status("TEST-NEW")).toBeNull(); // nothing written
    await pick("TEST-1", 901);
    expect((await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-1" })).error).toBeNull();
    expect((await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-1" })).error?.message).toBe(
      "A label purchase for this order is already in progress.",
    );
    await addLabel("TEST-1");
    expect((await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-1" })).error?.message).toBe(
      "This order already has an active label. Void it before buying another.",
    );
    // In-flight order whose label was voided before this shipped and is at
    // label_generated with no active log row is not blocked by the picking rule.
    await pg.query(`insert into order_status (shopify_order_id, status) values ('TEST-OLD', 'label_printed')`);
    expect((await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-OLD" })).error?.message).toMatch(/active label/);
    // Cancel releases the in-progress claim.
    await pick("TEST-2", 902);
    await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-2" });
    await rpc(pg, "cancel_label_purchase", { p_order_id: "TEST-2" });
    expect((await rpc(pg, "begin_label_purchase", { p_order_id: "TEST-2" })).error).toBeNull();
  });
});

describe("packaging overrides", () => {
  it("only for picked..label_printed, records previous and new, clear restores", async () => {
    expect(
      (await rpc(pg, "set_packaging_override", { p_order_id: "TEST-NEW", p_target: "needs_review" })).error?.message,
    ).toMatch(/after the order is picked/);
    await pick("TEST-1", 901);
    const r = await rpc(pg, "set_packaging_override", { p_order_id: "TEST-1", p_target: "preset", p_preset_id: FIX.big, p_previous_label: "Test Small" });
    expect(r.data).toMatchObject({ package: "Test Big" });
    await rpc(pg, "set_packaging_override", { p_order_id: "TEST-1", p_target: "needs_review", p_previous_label: "Test Big" });
    const row = await pg.query<any>(`select override_target, override_preset_id from order_packaging where order_id = 'TEST-1'`);
    expect(row.rows[0]).toMatchObject({ override_target: "needs_review", override_preset_id: null });
    await rpc(pg, "clear_packaging_override", { p_order_id: "TEST-1", p_restored_label: "Test Small" });
    expect((await pg.query(`select 1 from order_packaging where order_id = 'TEST-1'`)).rows).toHaveLength(0);
    const ev = await events("TEST-1");
    expect(ev.filter((e) => e.event_type === "packaging_override").map((e) => [e.detail.previous, e.detail.new])).toEqual([
      ["Test Small", "Test Big"],
      ["Test Big", "Needs Review"],
    ]);
    expect(ev.some((e) => e.event_type === "packaging_override_cleared")).toBe(true);
  });

  it("rejects a preset with no max points", async () => {
    await pick("TEST-1", 901);
    const np = await pg.query<{ id: string }>(
      `insert into package_presets (user_id, nickname, length_in, width_in, height_in, tare_weight_oz)
       values ('${FIX.user}', 'Loose', 1, 1, 1, 0) returning id`,
    );
    expect(
      (await rpc(pg, "set_packaging_override", { p_order_id: "TEST-1", p_target: "preset", p_preset_id: np.rows[0].id })).error?.message,
    ).toBe("Loose has no max points set.");
  });
});

describe("append-only records", () => {
  it("order_events rejects UPDATE and DELETE", async () => {
    await pick("TEST-1", 901);
    await expect(pg.query(`update order_events set detail = '{}'::jsonb`)).rejects.toThrow(/append-only \(UPDATE/);
    await expect(pg.query(`delete from order_events`)).rejects.toThrow(/append-only \(DELETE/);
  });

  it("assignments can't be deleted or edited, only released once", async () => {
    await pick("TEST-1", 901);
    await expect(pg.query(`delete from staging_box_assignments`)).rejects.toThrow(/never deleted/);
    await expect(pg.query(`update staging_box_assignments set staging_box_id = '${boxes[902]}'`)).rejects.toThrow(/only be released/);
    await rpc(pg, "return_order_to_picking", { p_order_id: "TEST-1" });
    await expect(pg.query(`update staging_box_assignments set release_note = 'x'`)).rejects.toThrow(/released staging box assignment/);
  });

  it("test cleanup only removes TEST- orders and test boxes", async () => {
    await pick("TEST-1", 901);
    const real = await pg.query<{ id: string }>(`insert into staging_boxes (box_number) values (950) returning id`);
    await rpc(pg, "return_order_to_picking", { p_order_id: "TEST-1" });
    await rpc(pg, "fulfillment_test_cleanup", { p_order_ids: ["TEST-1"], p_box_ids: [boxes[901], real.rows[0].id] });
    expect((await pg.query(`select 1 from order_events where order_id = 'TEST-1'`)).rows).toHaveLength(0);
    expect((await pg.query(`select 1 from staging_boxes where id = '${boxes[901]}'`)).rows).toHaveLength(0);
    expect((await pg.query(`select 1 from staging_boxes where id = '${real.rows[0].id}'`)).rows).toHaveLength(1);
    // Outside cleanup the guards are back on.
    await expect(pg.query(`delete from staging_boxes where id = '${boxes[902]}'`)).rejects.toThrow(/never deleted/);
  });
});
