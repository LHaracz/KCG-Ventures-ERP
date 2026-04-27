import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const envRaw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) {
  if (!line || line.trim().startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 0) continue;
  let value = line.slice(index + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  env[line.slice(0, index).trim()] = value;
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || "https://ttfshzqopxwijdtpvgye.supabase.co";
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

function isPlaceholder(value) {
  const text = String(value ?? "");
  return text.startsWith("UNMAPPED_") || text.startsWith("MISSING_");
}

const { data, error } = await supabase
  .from("inventory")
  .select("id, product_id, units_per_variant, shopify_variant_id");

if (error) throw new Error(error.message);

const rowsByKey = new Map();
for (const row of data ?? []) {
  const key = `${row.product_id ?? ""}::${row.units_per_variant ?? 1}`;
  const rows = rowsByKey.get(key) ?? [];
  rows.push(row);
  rowsByKey.set(key, rows);
}

const deleteIds = [];
for (const rows of rowsByKey.values()) {
  const real = rows.filter((row) => !isPlaceholder(row.shopify_variant_id));
  const placeholders = rows.filter((row) => isPlaceholder(row.shopify_variant_id));
  if (real.length > 0 && placeholders.length > 0) {
    for (const row of placeholders) deleteIds.push(row.id);
  }
}

if (deleteIds.length === 0) {
  console.log("No duplicate placeholder rows found.");
  process.exit(0);
}

const { error: deleteError } = await supabase.from("inventory").delete().in("id", deleteIds);
if (deleteError) throw new Error(deleteError.message);

console.log(`Deleted ${deleteIds.length} placeholder duplicate inventory rows.`);
