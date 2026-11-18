/**
 * Shared handling for /api/growth routes. Every route calls guardApi() first
 * (feature rules in the access catalog), then server code with the service
 * role client.
 */
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerOf } from "@/lib/access/api";
import { hasFeature, type FeatureKey } from "@/lib/access/catalog";
import { GrowthError } from "./errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export function growthDb(): Db {
  if (!supabaseAdmin) throw new Error("The server isn't configured (missing service role key).");
  return supabaseAdmin;
}

export const caller = (request: Request) => callerOf(request).access;
/** The signed-in employee's name, from the session (never from the browser). */
export const actorName = (request: Request) => callerOf(request).access.fullName ?? "Unknown";
export const actorAccountId = (request: Request) => callerOf(request).access.accountId;
export const isAdminCaller = (request: Request) => !!callerOf(request).access.isAdmin;
export const callerHas = (request: Request, key: FeatureKey) => hasFeature(callerOf(request).access, key);

/** Admin-only actions inside a feature route (approve claims, risky words, convert to retailer). */
export function requireAdminCaller(request: Request) {
  if (!isAdminCaller(request)) throw new GrowthError("Only an Admin can do this.", 403);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function growthError(error: unknown): NextResponse {
  if (error instanceof GrowthError) return NextResponse.json({ error: error.message, fields: error.fields ?? null }, { status: error.status });
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status: 500 });
}
