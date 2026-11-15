/**
 * Shared handling for the /api/retail routes (Admin only). Every route calls
 * guardApi() first, then a service function with the service-role client.
 */
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerOf } from "@/lib/access/api";
import { RetailError, type Db } from "./service";

export function retailDb(): Db {
  if (!supabaseAdmin) throw new Error("The server isn't configured for Retail (missing service role key).");
  return supabaseAdmin as unknown as Db;
}

/** "Updated by" / "Created by": the signed-in Admin, from the session (never from the browser). */
export const actorName = (request: Request) => callerOf(request).access.fullName;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function retailError(error: unknown): NextResponse {
  if (error instanceof RetailError) {
    return NextResponse.json({ error: error.message, fields: error.fields ?? null, conflict: error.conflict ?? null }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status: 500 });
}
