import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabaseConfig";

/**
 * Supabase client for server components and route handlers, using the
 * signed-in user's session cookies (anon key + the user's token, so row level
 * security applies). Never uses the service role key.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a server component: cookies are read-only there. The
          // proxy refreshes the session cookies on the next request.
        }
      },
    },
  });
}
