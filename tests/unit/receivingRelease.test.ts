// The Complete Production check's COA warning by COA policy: 'not_available'
// is skipped, 'unknown' or no preferred listing becomes the information line
// (no acknowledgement), 'included' and 'request' warn as before, and when the
// policies can't be read (error, timeout or a missing row) every missing COA
// keeps its warning. Supabase is stubbed. Invented data only.
import { describe, expect, it, vi } from "vitest";
import { computeReleaseCheck, readReleaseCoaPolicies, splitMissingCoa } from "@/lib/releaseWarnings";

const missing = [
  { id: "m1", name: "Ingredient A" },
  { id: "m2", name: "Ingredient B" },
  { id: "m3", name: "Ingredient C" },
  { id: "m4", name: "Ingredient D" },
  { id: "m5", name: "Ingredient E" },
];

describe("splitMissingCoa", () => {
  it("each policy", () => {
    const policies = new Map<string, string | null>([
      ["m1", "included"],
      ["m2", "request"],
      ["m3", "not_available"],
      ["m4", "unknown"],
      ["m5", null],
    ]);
    expect(splitMissingCoa(missing, policies)).toEqual({ warn: [missing[0], missing[1]], notSet: ["Ingredient D", "Ingredient E"] });
  });
  it("fails safe: unreadable policies or a missing row keep the warning", () => {
    expect(splitMissingCoa(missing, null)).toEqual({ warn: missing, notSet: [] });
    expect(splitMissingCoa(missing, new Map([["m3", "not_available"]]))).toEqual({ warn: [missing[0], missing[1], missing[3], missing[4]], notSet: [] });
  });
});

describe("readReleaseCoaPolicies", () => {
  it("reads rows; an error or a timeout gives null", async () => {
    const ok = { rpc: vi.fn(async () => ({ data: [{ raw_material_id: "m1", coa_policy: "unknown" }], error: null })) };
    expect(await readReleaseCoaPolicies(ok, ["m1"])).toEqual(new Map([["m1", "unknown"]]));
    expect(ok.rpc).toHaveBeenCalledWith("coa_policies_for_release", { p_raw_material_ids: ["m1"] });
    const failing = { rpc: vi.fn(async () => ({ data: null, error: { message: "permission denied" } })) };
    expect(await readReleaseCoaPolicies(failing, ["m1"])).toBeNull();
    const throwing = {
      rpc: vi.fn((): Promise<{ data: unknown; error: unknown }> => {
        throw new Error("network");
      }),
    };
    expect(await readReleaseCoaPolicies(throwing, ["m1"])).toBeNull();
    const slow = { rpc: vi.fn(() => new Promise<{ data: unknown; error: unknown }>(() => undefined)) };
    expect(await readReleaseCoaPolicies(slow, ["m1"], 10)).toBeNull();
  });
});

/** A tiny stand-in for the Supabase query builder: every chain resolves to the table's rows. */
function stubSupabase(tables: Record<string, unknown[]>, rpc: (name: string, args: unknown) => Promise<unknown>) {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "or", "order"]) c[m] = () => c;
    c.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
    return c;
  };
  return { from: (t: string) => chain(tables[t] ?? []), rpc };
}

describe("computeReleaseCheck", () => {
  const tables = {
    log_types: [],
    production_targets: [{ product: "p1" }],
    bom_lines: ["m1", "m2", "m3", "m4"].map((id) => ({ inventory_item: id, product: "p1", line_type: "inventory_item" })),
    inventory_items: missing,
    receiving_details: [],
    log_entry_files: [],
    log_entries: [],
  };
  const cycle = { id: "c1", start_date: "2026-11-01T00:00:00Z", end_date: "2026-11-20T00:00:00Z" };
  it("by policy: included and request warn, not_available is skipped, unknown is information only", async () => {
    const sb = stubSupabase(tables, async () => ({
      data: [
        { raw_material_id: "m1", coa_policy: "included" },
        { raw_material_id: "m2", coa_policy: "request" },
        { raw_material_id: "m3", coa_policy: "not_available" },
        { raw_material_id: "m4", coa_policy: null },
      ],
      error: null,
    }));
    const r = await computeReleaseCheck(sb, cycle);
    expect(r.warnings.map((w) => w.message)).toEqual(["No COA on file for Ingredient A.", "No COA on file for Ingredient B."]);
    expect(r.coaPolicyNotSet).toEqual(["Ingredient D"]);
  });
  it("keeps every warning when the policy function fails", async () => {
    const sb = stubSupabase(tables, async () => ({ data: null, error: { message: "boom" } }));
    const r = await computeReleaseCheck(sb, cycle);
    expect(r.warnings.map((w) => w.message)).toEqual(["Ingredient A", "Ingredient B", "Ingredient C", "Ingredient D"].map((n) => `No COA on file for ${n}.`));
    expect(r.coaPolicyNotSet).toEqual([]);
  });
});
