/**
 * Throwaway test data for browser tests. Everything created here is named
 * "[TEST] ..." with invented ingredients and amounts, and is removed in
 * cleanup(). Never touches real SOPs, formulas or inventory.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

export const SCREENS = path.join(process.cwd(), ".private", "screens");

export function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for e2e setup.");
  return createClient(url, key, { auth: { persistSession: false } });
}

export type TestData = {
  tag: string;
  productId: string;
  productName: string;
  formulationProductId: string;
  formulationV1: string;
  itemIds: string[];
  sopIds: string[];
  formulationIds: string[];
};

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error || r.data === null || r.data === undefined) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
};

export async function createTestData(userId: string): Promise<TestData> {
  const db = admin();
  const tag = Math.random().toString(36).slice(2, 8);
  const productName = `[TEST] Product ${tag}`;
  const product = must(await db.from("products").insert({ name: productName, unit: "unit", is_microgreen: false, sale_price_per_unit: 0, user_id: userId }).select("id").single(), "product");
  const items = must(
    await db
      .from("inventory_items")
      .insert([
        { name: `[TEST] Ingredient A ${tag}`, unit: "g", cost_per_unit: 0, quantity_on_hand: 0, user_id: userId },
        { name: `[TEST] Ingredient D ${tag}`, unit: "kg", cost_per_unit: 0, quantity_on_hand: 0, user_id: userId },
        { name: `[TEST] Ingredient F ${tag}`, unit: "each", cost_per_unit: 0, quantity_on_hand: 0, user_id: userId },
      ])
      .select("id"),
    "inventory items",
  ) as { id: string }[];
  const fp = must(await db.from("formulation_products").insert({ name: productName, product_id: product.id, status: "active" }).select("id").single(), "formulation product");
  const f1 = must(
    await db.from("formulations").insert({ formulation_product_id: fp.id, version_number: 1, status: "final", finalized_at: new Date().toISOString(), change_summary: "Test baseline" }).select("id").single(),
    "formulation v1",
  );
  must(
    await db
      .from("formulation_lines")
      .insert([
        { formulation_id: f1.id, line_type: "inventory_item", raw_material_id: items[0].id, qty_per_unit: 12.5, sort_order: 0 },
        { formulation_id: f1.id, line_type: "inventory_item", raw_material_id: items[1].id, qty_per_unit: 0.002, sort_order: 1 },
        { formulation_id: f1.id, line_type: "packaging", raw_material_id: items[2].id, qty_per_unit: 2, sort_order: 2 },
      ])
      .select("id"),
    "formulation lines",
  );
  return { tag, productId: product.id, productName, formulationProductId: fp.id, formulationV1: f1.id, itemIds: items.map((i) => i.id), sopIds: [], formulationIds: [f1.id] };
}

/** Adds a new final formulation version (simulating Finish Iteration's formula change for the test product only). */
export async function addFormulationVersion(t: TestData, versionNumber: number, qtyA: number): Promise<string> {
  const db = admin();
  const f = must(
    await db
      .from("formulations")
      .insert({ formulation_product_id: t.formulationProductId, version_number: versionNumber, status: "final", finalized_at: new Date().toISOString(), change_summary: "Test change" })
      .select("id")
      .single(),
    "formulation",
  );
  must(
    await db
      .from("formulation_lines")
      .insert([
        { formulation_id: f.id, line_type: "inventory_item", raw_material_id: t.itemIds[0], qty_per_unit: qtyA, sort_order: 0 },
        { formulation_id: f.id, line_type: "inventory_item", raw_material_id: t.itemIds[1], qty_per_unit: 0.002, sort_order: 1 },
        { formulation_id: f.id, line_type: "packaging", raw_material_id: t.itemIds[2], qty_per_unit: 2, sort_order: 2 },
      ])
      .select("id"),
    "lines",
  );
  t.formulationIds.push(f.id);
  return f.id;
}

export async function cleanup(t: TestData | null) {
  if (!t) return;
  const db = admin();
  const { data: sops } = await db.from("sops").select("id").like("title", `[TEST] %${t.tag}%`);
  const sopIds = Array.from(new Set([...t.sopIds, ...((sops ?? []) as { id: string }[]).map((s) => s.id)]));
  if (sopIds.length) {
    const { error } = await db.rpc("sop_test_cleanup", { p_sop_ids: sopIds });
    if (error) console.error(`cleanup sops: ${error.message}`);
  }
  await db.from("formulation_lines").delete().in("formulation_id", t.formulationIds);
  await db.from("formulations").delete().in("id", t.formulationIds);
  await db.from("formulation_products").delete().eq("id", t.formulationProductId);
  await db.from("bom_lines").delete().eq("product", t.productId);
  await db.from("products").delete().eq("id", t.productId);
  await db.from("inventory_items").delete().in("id", t.itemIds);
}

export async function login(page: Page) {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error("Set E2E_EMAIL and E2E_PASSWORD.");
  await page.goto("/login");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
}

export async function accessToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.includes("auth-token")) {
        try {
          return JSON.parse(localStorage.getItem(k)!).access_token as string;
        } catch {
          /* ignore */
        }
      }
    }
    return "";
  });
}

/** The logged-in user's id (JWT "sub"). */
export function userIdFromToken(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return payload.sub as string;
}
