import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerOf, guardApi } from "@/lib/access/api";
import { passwordProblem } from "@/lib/access/passwordPolicy";
import { NO_ACCESS_MESSAGE } from "@/lib/access/access";

/**
 * Sets the signed-in login's password (accepting an invite, a reset link, or
 * a change). The policy is checked here again before anything is saved.
 * Accepting an invite makes the account active.
 */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { user, access } = callerOf(request);
  if (!supabaseAdmin) return NextResponse.json({ error: "Server is not configured." }, { status: 500 });

  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  const problem = passwordProblem(body.password);
  if (problem) return NextResponse.json({ error: problem, code: "weak_password" }, { status: 400 });

  // Only invited or active employees may set a password here.
  if (access.status !== "invited" && access.status !== "active") {
    return NextResponse.json({ error: NO_ACCESS_MESSAGE, code: "no_access" }, { status: 403 });
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password: body.password as string });
  if (error) return NextResponse.json({ error: error.message, code: "auth_error" }, { status: 400 });

  if (access.status === "invited" && access.accountId) {
    const { error: upErr } = await supabaseAdmin
      .from("employee_accounts")
      .update({ status: "active", accepted_at: new Date().toISOString() })
      .eq("id", access.accountId)
      .eq("status", "invited");
    if (upErr) return NextResponse.json({ error: `Password saved, but the account could not be activated: ${upErr.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
