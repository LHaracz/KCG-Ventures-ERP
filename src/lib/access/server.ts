/**
 * Server-side access for pages (server components). getAccess() reads the
 * session cookie and loads the signed-in employee's access from the
 * database, once per request (React cache), never from a cached claim.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAccess, type Access } from "@/lib/access/access";
import { allows, pageRule } from "@/lib/access/catalog";

export type PageAccess = { user: User | null; access: Access | null; error: string | null };

export const getAccess = cache(async (): Promise<PageAccess> => {
  let user: User | null = null;
  try {
    const sb = await createServerSupabase();
    const { data } = await sb.auth.getUser();
    user = data.user ?? null;
  } catch {
    user = null;
  }
  if (!user) return { user: null, access: null, error: null };
  if (!supabaseAdmin) return { user, access: null, error: "Server is not configured." };
  try {
    return { user, access: await loadAccess(supabaseAdmin, user.id), error: null };
  } catch (e) {
    return { user, access: null, error: e instanceof Error ? e.message : "Could not check access." };
  }
});

export type PageDecision =
  | { kind: "allow" }
  | { kind: "login" }
  | { kind: "no_access" }
  | { kind: "complete_profile" }
  | { kind: "forbidden" };

/** Pure decision for a page route (testable). */
export function decidePage(route: string, pa: PageAccess): PageDecision {
  const rule = pageRule(route);
  if (rule.kind === "public") return { kind: "allow" };
  if (!pa.user) return { kind: "login" };
  if (rule.kind === "signed_in") return { kind: "allow" };
  if (!pa.access || !pa.access.active) return { kind: pa.error ? "forbidden" : "no_access" };
  if (!pa.access.fullName) return { kind: "complete_profile" };
  return allows(rule, pa.access, true) ? { kind: "allow" } : { kind: "forbidden" };
}

/**
 * Call at the top of every page. Redirects to sign-in, to "no access" or to
 * complete-profile, or returns "forbidden" (the page then renders the
 * Forbidden message instead of itself). Returns "allow" otherwise.
 */
export async function guardPage(route: string): Promise<"allow" | "forbidden"> {
  const d = decidePage(route, await getAccess());
  if (d.kind === "login") redirect(`/login?next=${encodeURIComponent(route.includes("[") ? "/" : route)}`);
  if (d.kind === "no_access") redirect("/no-access");
  if (d.kind === "complete_profile") redirect("/complete-profile");
  return d.kind === "forbidden" ? "forbidden" : "allow";
}
