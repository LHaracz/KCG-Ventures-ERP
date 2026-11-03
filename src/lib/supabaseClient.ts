import { createClient } from "@supabase/supabase-js";

// Defaults are the production project (unchanged behavior). Setting
// NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY points the
// browser at another project (a dev project or local `supabase start`), which
// the e2e tests require so they never run against production.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ttfshzqopxwijdtpvgye.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_4ZsAEGgSLPwWtKu2l50VvQ_oGDEQC8K";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
