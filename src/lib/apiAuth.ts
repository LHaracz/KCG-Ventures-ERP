import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { userFromRequest } from "@/lib/access/api";
import { loadAccess } from "@/lib/access/access";

/**
 * The signed-in caller of an API route. Every route also calls guardApi()
 * first (feature check); this is a second line of defense: it only returns
 * a user who is an active employee, read from the database now.
 */
export async function requireApiUserFromBearerToken(request: Request): Promise<User> {
  if (!supabaseAdmin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !authorization.replace("Bearer ", "").trim()) {
    throw new Error("Missing bearer token.");
  }

  const user = await userFromRequest(request);
  if (!user) {
    throw new Error("Unauthorized.");
  }
  const access = await loadAccess(supabaseAdmin, user.id).catch(() => null);
  if (!access?.active) {
    throw new Error("Unauthorized.");
  }

  return user;
}
