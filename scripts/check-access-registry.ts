/**
 * check:access — default deny. Fails if any page, API route or server action
 * is not registered in the feature catalog (src/lib/access/catalog.ts) or
 * doesn't call its guard first. See scripts/lib/accessRegistry.ts.
 */
import path from "node:path";
import { checkAccessRegistry } from "./lib/accessRegistry";
import { API_RULES, PAGE_RULES } from "../src/lib/access/catalog";

const src = path.resolve(__dirname, "..", "src");
const problems = checkAccessRegistry(src, PAGE_RULES, API_RULES);
if (problems.length > 0) {
  console.error("check:access FAILED. Register these in src/lib/access/catalog.ts and guard them:");
  for (const p of problems) console.error(`  ${p.file}: ${p.problem}`);
  process.exit(1);
}
console.log(`check:access OK (${Object.keys(PAGE_RULES).length} page rules, ${Object.keys(API_RULES).length} API rules).`);
