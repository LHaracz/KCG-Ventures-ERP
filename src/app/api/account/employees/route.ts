import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { guardApi } from "@/lib/access/api";

/**
 * Names of active employee accounts, for fields that name a different person
 * (training trainer and trainee, Purchase Order "Authorized by"). Names only.
 */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  if (!supabaseAdmin) return NextResponse.json({ error: "Server is not configured." }, { status: 500 });
  const { data, error } = await supabaseAdmin
    .from("employee_accounts")
    .select("id, first_name, last_name")
    .eq("status", "active")
    .not("first_name", "is", null)
    .not("last_name", "is", null)
    .order("first_name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const employees = ((data ?? []) as Array<{ id: string; first_name: string; last_name: string }>)
    .map((r) => ({ id: r.id, fullName: `${r.first_name.trim()} ${r.last_name.trim()}`.trim() }))
    .filter((r) => r.fullName);
  return NextResponse.json({ employees });
}
