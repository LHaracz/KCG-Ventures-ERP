/** Small helpers shared by the SOP document API routes. */
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { SopError } from "@/lib/sopService";

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

/** Authenticates the caller, ensures the service role is configured, and maps errors to JSON responses. */
export async function withSopApi(
  request: Request,
  handler: (ctx: { user: User; admin: NonNullable<typeof supabaseAdmin> }) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) return jsonError("The server is missing its service role key.", 500);
    return await handler({ user, admin: supabaseAdmin });
  } catch (error) {
    if (error instanceof SopError) return jsonError(error.message, error.status, error.code ? { code: error.code } : undefined);
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return jsonError(message, status);
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new SopError("Request body must be JSON.");
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
