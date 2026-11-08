/**
 * Shared wrapper for /api/admin/* handlers: guardApi (Admin only, from the
 * catalog), requireAdmin again, then the operation; errors become JSON.
 */
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { accessErrorResponse, callerOf } from "@/lib/access/api";
import { requireAdmin, type Access } from "@/lib/access/access";
import { OpError, type AuthApi } from "@/lib/access/adminOps";

export type AdminCtx = { db: NonNullable<typeof supabaseAdmin>; auth: AuthApi; actor: string; actorName: string; access: Access; origin: string };

export async function runAdmin(request: Request, fn: (ctx: AdminCtx) => Promise<unknown>): Promise<NextResponse> {
  try {
    const { access } = callerOf(request);
    requireAdmin(access);
    if (!supabaseAdmin) return NextResponse.json({ error: "Server is not configured." }, { status: 500 });
    if (!access.accountId) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const origin = new URL(request.url).origin;
    const result = await fn({
      db: supabaseAdmin,
      auth: supabaseAdmin.auth as unknown as AuthApi,
      actor: access.accountId,
      actorName: access.fullName ?? "Admin",
      access,
      origin,
    });
    return NextResponse.json(result ?? { ok: true });
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;
    if (error instanceof OpError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function readBody<T>(request: Request): Promise<T> {
  return (await request.json().catch(() => ({}))) as T;
}
