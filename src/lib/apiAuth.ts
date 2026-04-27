import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function requireApiUserFromBearerToken(request: Request): Promise<User> {
  if (!supabaseAdmin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new Error("Missing bearer token.");
  }

  const token = authorization.replace("Bearer ", "").trim();
  if (!token) {
    throw new Error("Missing bearer token.");
  }

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    throw new Error("Unauthorized.");
  }

  return user;
}
