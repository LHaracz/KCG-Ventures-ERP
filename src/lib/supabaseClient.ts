import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabaseConfig";

// Browser client. The session is kept in cookies (not localStorage), so the
// server can tell who is signed in on every page request. Same API as before.
export const supabase = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
