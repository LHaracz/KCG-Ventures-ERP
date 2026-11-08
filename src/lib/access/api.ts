/**
 * API route guard. Every route handler's first line is
 *
 *   const denied = await guardApi(request); if (denied) return denied;
 *
 * It finds the route's rule in the feature catalog (unregistered routes are
 * Admin only), identifies the caller from the bearer token (or the session
 * cookie), loads their access from the database, and returns a 401/403 JSON
 * response when they may not call it. scripts/check-access-registry.ts fails
 * if a handler doesn't call it.
 */
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { allows, apiRule } from "@/lib/access/catalog";
import { AccessError, FORBIDDEN_MESSAGE, NO_ACCESS_MESSAGE, loadAccess, type Access } from "@/lib/access/access";

type Caller = { user: User; access: Access };
const callers = new WeakMap<Request, Caller>();

function bearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t || null;
}

async function userFromCookies(): Promise<User | null> {
  try {
    const { createServerSupabase } = await import("@/lib/supabaseServer");
    const sb = await createServerSupabase();
    const { data } = await sb.auth.getUser();
    return data.user ?? null;
  } catch {
    return null; // not in a request context (tests) or no cookies
  }
}

/** The caller's login, from the bearer token or the session cookie. Null if not signed in. */
export async function userFromRequest(request: Request): Promise<User | null> {
  const cached = callers.get(request);
  if (cached) return cached.user;
  if (!supabaseAdmin) return null;
  const token = bearer(request);
  if (token) {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    return error ? null : data.user ?? null;
  }
  return userFromCookies();
}

const json = (status: number, error: string, code: string) => NextResponse.json({ error, code }, { status });

/** Null when the caller may use this route; otherwise the 401/403 response to return. */
export async function guardApi(request: Request): Promise<NextResponse | null> {
  const rule = apiRule(new URL(request.url).pathname);
  if (rule.kind === "public" || rule.kind === "system") return null;
  if (!supabaseAdmin) return json(500, "Server is not configured.", "server_config");

  let user: User | null;
  let access: Access;
  try {
    user = await userFromRequest(request);
    if (!user) return json(401, "Unauthorized.", "unauthorized");
    access = await loadAccess(supabaseAdmin, user.id);
  } catch {
    // Fail closed when access can't be determined.
    return json(403, FORBIDDEN_MESSAGE, "forbidden");
  }
  if (rule.kind !== "signed_in") {
    if (!access.active) return json(403, NO_ACCESS_MESSAGE, "no_access");
    if (!allows(rule, access, true)) return json(403, FORBIDDEN_MESSAGE, "forbidden");
  }
  callers.set(request, { user, access });
  return null;
}

/** The caller recorded by guardApi for this request (throws if guardApi didn't run or denied). */
export function callerOf(request: Request): Caller {
  const c = callers.get(request);
  if (!c) throw new AccessError("Unauthorized.", 401, "unauthorized");
  return c;
}

/** JSON response for an AccessError (403/401), or null for other errors. */
export function accessErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AccessError) return json(error.status, error.message, error.code);
  return null;
}
