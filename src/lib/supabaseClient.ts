import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://ttfshzqopxwijdtpvgye.supabase.co";
const supabaseAnonKey =
  "sb_publishable_4ZsAEGgSLPwWtKu2l50VvQ_oGDEQC8K";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

