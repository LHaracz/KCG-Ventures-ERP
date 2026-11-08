// Public Supabase settings (safe for the browser). Defaults are the production
// project (unchanged behavior). NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY point the app at another project (a dev
// project or local Supabase), which the e2e tests require so they never run
// against production. The service role key never appears here.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ttfshzqopxwijdtpvgye.supabase.co";
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_4ZsAEGgSLPwWtKu2l50VvQ_oGDEQC8K";
