/**
 * Real-database specs PGlite can't cover: true concurrent races (separate
 * connections through the Supabase API) and row level security as a real
 * logged-in user vs. an anonymous caller. Invented TEST- data only, cleaned
 * up afterwards. Dev database only (assertDevDatabase).
 */
import { expect, test } from "@playwright/test";
import { admin } from "./helpers";
import { anonClient, assertDevDatabase } from "./warehouseHelpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const orderIds: string[] = [];
const boxIds: string[] = [];
const presetIds: string[] = [];
const userIds: string[] = [];

test.beforeAll(() => assertDevDatabase());

test.afterAll(async () => {
  const db = admin();
  const cleaned = await db.rpc("fulfillment_test_cleanup", { p_order_ids: orderIds, p_box_ids: boxIds });
  if (cleaned.error) throw new Error(`cleanup failed: ${cleaned.error.message}`);
  if (presetIds.length) await db.from("package_presets").delete().in("id", presetIds);
  for (const id of userIds) await db.auth.admin.deleteUser(id);
});

async function testBoxes(n: number) {
  const db = admin();
  const base = 700000 + Math.floor(Math.random() * 90000) * 10;
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const { data, error } = await db.from("staging_boxes").insert({ box_number: base + i, is_test: true }).select("id").single();
    if (error) throw new Error(error.message);
    ids.push(data.id);
    boxIds.push(data.id);
  }
  return ids;
}

const order = (n: number) => {
  const id = `TEST-${tag}-R${n}`;
  orderIds.push(id);
  return id;
};

test("two sessions picking the same box at the same moment: exactly one succeeds", async () => {
  const rounds = 10;
  const boxes = await testBoxes(rounds);
  for (let i = 0; i < rounds; i++) {
    const a = order(i * 2);
    const b = order(i * 2 + 1);
    // Two separate clients = two separate API connections/transactions.
    const [ra, rb] = await Promise.all([
      admin().rpc("mark_order_picked", { p_order_id: a, p_box_id: boxes[i], p_order_name: `#${a}` }),
      admin().rpc("mark_order_picked", { p_order_id: b, p_box_id: boxes[i], p_order_name: `#${b}` }),
    ]);
    const ok = [ra, rb].filter((r) => !r.error);
    const failed = [ra, rb].filter((r) => r.error);
    expect(ok).toHaveLength(1);
    expect(failed[0].error!.message).toMatch(/is already holding order|was just taken/);
    const { data } = await admin().from("staging_box_assignments").select("order_id").eq("staging_box_id", boxes[i]).is("released_at", null);
    expect(data).toHaveLength(1);
    // The loser was not left in a half-picked state.
    const loser = ra.error ? a : b;
    const { data: st } = await admin().from("order_status").select("status").eq("shopify_order_id", loser).maybeSingle();
    expect(st?.status ?? "preparing_shipment").toBe("preparing_shipment");
  }
});

test("two sessions picking the same order into two boxes: exactly one succeeds", async () => {
  const rounds = 10;
  const boxes = await testBoxes(rounds * 2);
  for (let i = 0; i < rounds; i++) {
    const id = order(100 + i);
    const [r1, r2] = await Promise.all([
      admin().rpc("mark_order_picked", { p_order_id: id, p_box_id: boxes[i * 2], p_order_name: `#${id}` }),
      admin().rpc("mark_order_picked", { p_order_id: id, p_box_id: boxes[i * 2 + 1], p_order_name: `#${id}` }),
    ]);
    expect([r1, r2].filter((r) => !r.error)).toHaveLength(1);
    expect([r1, r2].find((r) => r.error)!.error!.message).toMatch(/is already picked into STG-/);
    const { data } = await admin().from("staging_box_assignments").select("id").eq("order_id", id).is("released_at", null);
    expect(data).toHaveLength(1);
  }
});

test("package_presets are shared: a logged-in user sees and edits presets another login created", async () => {
  const db = admin();
  const other = await db.auth.admin.createUser({ email: `test-${tag}@example.invalid`, password: `Pw-${tag}-${Date.now()}`, email_confirm: true });
  if (other.error) throw new Error(other.error.message);
  userIds.push(other.data.user!.id);
  const { data: preset, error } = await db
    .from("package_presets")
    .insert({ user_id: other.data.user!.id, nickname: `[TEST] Shared ${tag}`, length_in: 1, width_in: 1, height_in: 1, tare_weight_oz: 0 })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  presetIds.push(preset.id);

  const me = anonClient();
  const signIn = await me.auth.signInWithPassword({ email: process.env.E2E_EMAIL!, password: process.env.E2E_PASSWORD! });
  expect(signIn.error).toBeNull();
  const seen = await me.from("package_presets").select("id, nickname").eq("id", preset.id);
  expect(seen.data).toHaveLength(1);
  const upd = await me.from("package_presets").update({ nickname: `[TEST] Shared ${tag} edited` }).eq("id", preset.id).select("id");
  expect(upd.error).toBeNull();
  expect(upd.data).toHaveLength(1);

  // Anonymous callers see nothing.
  const anon = await anonClient().from("package_presets").select("id").eq("id", preset.id);
  expect(anon.data ?? []).toHaveLength(0);
});

test("fulfillment_orders_cache: logged-in users can read, nobody but the server can write, anonymous can't read", async () => {
  const db = admin();
  const id = order(900);
  const ins = await db.from("fulfillment_orders_cache").insert({ shopify_order_id: id, source: "test", payload: { orderId: id, name: `[TEST] #${tag}`, lineItems: [] } });
  expect(ins.error).toBeNull();

  const me = anonClient();
  await me.auth.signInWithPassword({ email: process.env.E2E_EMAIL!, password: process.env.E2E_PASSWORD! });
  const read = await me.from("fulfillment_orders_cache").select("shopify_order_id").eq("shopify_order_id", id);
  expect(read.data).toHaveLength(1);
  const write = await me.from("fulfillment_orders_cache").insert({ shopify_order_id: `${id}-x`, source: "test", payload: {} });
  expect(write.error).not.toBeNull();
  const del = await me.from("fulfillment_orders_cache").delete().eq("shopify_order_id", id).select("shopify_order_id");
  expect(del.data ?? []).toHaveLength(0);

  // Warehouse functions are server-only (service role).
  const rpc = await me.rpc("mark_order_picked", { p_order_id: id, p_box_id: "00000000-0000-0000-0000-000000000000" });
  expect(rpc.error).not.toBeNull();

  const anon = await anonClient().from("fulfillment_orders_cache").select("shopify_order_id").eq("shopify_order_id", id);
  expect(anon.data ?? []).toHaveLength(0);
});
