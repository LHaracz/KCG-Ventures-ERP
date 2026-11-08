import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerOf, guardApi } from "@/lib/access/api";
import { NO_ACCESS_MESSAGE } from "@/lib/access/access";

/** First and last name for an active account that has none yet (the existing admins on first sign-in). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { access } = callerOf(request);
  if (!supabaseAdmin) return NextResponse.json({ error: "Server is not configured." }, { status: 500 });
  if (!access.active || !access.accountId) return NextResponse.json({ error: NO_ACCESS_MESSAGE, code: "no_access" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { firstName?: unknown; lastName?: unknown };
  const first = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const last = typeof body.lastName === "string" ? body.lastName.trim() : "";
  if (!first || !last) return NextResponse.json({ error: "Enter your first and last name.", code: "name_required" }, { status: 400 });
  if (first.length > 60 || last.length > 60) return NextResponse.json({ error: "Names can be at most 60 characters.", code: "name_too_long" }, { status: 400 });
  if (access.fullName) return NextResponse.json({ error: "Your name is already set. Ask an admin to change it.", code: "already_set" }, { status: 409 });

  const { error } = await supabaseAdmin.from("employee_accounts").update({ first_name: first, last_name: last }).eq("id", access.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await supabaseAdmin.from("access_audit_log").insert({
    actor_name: `${first} ${last}`,
    actor_account_id: access.accountId,
    action: "profile_completed",
    target: `${first} ${last}`,
    detail: {},
  });
  return NextResponse.json({ ok: true });
}
