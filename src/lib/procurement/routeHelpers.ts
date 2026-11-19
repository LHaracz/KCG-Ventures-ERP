/**
 * Shared response handling for the /api/procurement routes. Every route
 * calls guardApi() first (feature inventory.purchase_orders), then one of
 * the service functions with the service-role client.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabaseConfig";
import { callerOf } from "@/lib/access/api";
import { AccessError, requireAdmin } from "@/lib/access/access";
import { ProcurementError, type Db } from "./service";

export function procurementDb(): Db {
  if (!supabaseAdmin) throw new Error("The server isn't configured for Procurement (missing service role key).");
  return supabaseAdmin as unknown as Db;
}

/**
 * The signed-in user's own client (anon key + their token), so database
 * functions that check is_admin() see who is calling. Never the service role.
 */
export async function userDb(request: Request): Promise<Db> {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } }) as unknown as Db;
  }
  const { createServerSupabase } = await import("@/lib/supabaseServer");
  return (await createServerSupabase()) as unknown as Db;
}

/** Throws unless the caller is an active Admin (the route rule already checks; this is the second check). */
export const requireAdminCaller = (request: Request) => requireAdmin(callerOf(request).access);

/** "Updated by": the signed-in employee, from the session (never from the browser). */
export const actorName = (request: Request) => callerOf(request).access.fullName;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function procurementError(error: unknown): NextResponse {
  if (error instanceof AccessError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ProcurementError) {
    return NextResponse.json({ error: error.message, fields: error.fields ?? null }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status: 500 });
}
