/**
 * Shared response handling for the /api/procurement routes. Every route
 * calls guardApi() first (feature inventory.purchase_orders), then one of
 * the service functions with the service-role client.
 */
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerOf } from "@/lib/access/api";
import { ProcurementError, type Db } from "./service";

export function procurementDb(): Db {
  if (!supabaseAdmin) throw new Error("The server isn't configured for Procurement (missing service role key).");
  return supabaseAdmin as unknown as Db;
}

/** "Updated by": the signed-in employee, from the session (never from the browser). */
export const actorName = (request: Request) => callerOf(request).access.fullName;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function procurementError(error: unknown): NextResponse {
  if (error instanceof ProcurementError) {
    return NextResponse.json({ error: error.message, fields: error.fields ?? null }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status: 500 });
}
